# Gumps: server, client, and editor

NodeUO supports three kinds of gump definitions. They all ultimately produce
standard Ultima Online controls or packets; the private JSON format does not
change the UO protocol.

## Model and compatibility

| Source | Purpose | Fallback behavior |
| --- | --- | --- |
| `data/config/gumps.json` | fully data-driven server gumps | the JSON record is the layout source |
| `data/config/server-gump-catalog.json` | catalog of gumps constructed in JS | JS remains active until an override has `enabled: true` |
| `apps/client/public/client-gumps.json` | local web-client layouts and overrides | the built-in JS class works without JSON or after an error |

A client connected to ServUO or another emulator still renders the standard UO
layout it receives. `client-gumps.json` applies only to local client windows,
such as the paperdoll, options, and action bar.

After `nodeuo.json.v2` negotiation, historical `@@OPEN_*@@` script markers are
centrally converted to typed JSON messages (`ui.rich-gumps` or
`crafting.workbench`). They are an internal script API, never a wire protocol.
Binary frames contain only original UO packets. Classic clients never receive
the marker: the server emits a rate-limited explanatory system message and the
script's standard UO/text fallback remains authoritative.

## Smallest server gump

```js
export default function register(api) {
  api.lifecycle.command({
    name: 'hello-gump',
    access: 'Player',
    run(ctx) {
      api.gumps.send(ctx.state, {
        definitionId: 'server:examples:hello-gump',
        x: 100,
        y: 100,
        layout: [
          '{ page 0 }',
          '{ resizepic 0 0 5054 320 150 }',
          '{ text 25 20 1153 0 }',
          '{ textentry 25 55 260 20 1152 1 1 }',
          '{ button 25 105 4023 4024 1 0 1 }',
          '{ button 170 105 4017 4018 1 0 0 }',
        ].join(''),
        texts: ['What is your name?', ''],
      }, (response) => {
        if (response.buttonId !== 1) return;
        const name = response.textEntries
          .find((entry) => entry.entryId === 1)?.text ?? '';
        ctx.state.sendSystemMessage(`Hello ${name}!`);
      });
    },
  });
}
```

The response contains:

```js
{
  serial,        // gump owner/context
  gumpId,        // instance identifier
  buttonId,      // clicked button; 0 usually means close
  switches,      // selected radio/checkbox IDs
  textEntries,   // [{ entryId, text }]
}
```

The server validates a response against the controls it sent, limits the number
of active windows, and removes the callback after the first valid response.
Still treat `textEntries` as untrusted: validate length, range, and player access.

## Fully JSON-defined gump

```json
{
  "definitionId": "daily-reward",
  "name": "Daily reward",
  "x": 110,
  "y": 90,
  "width": 360,
  "height": 220,
  "controls": [
    { "type": "panel", "x": 0, "y": 0, "width": 360, "height": 220, "artId": 5054 },
    { "type": "label", "x": 24, "y": 18, "width": 300, "height": 20, "hue": 1153, "text": "Reward for {{playerName}}" },
    { "type": "image", "x": 24, "y": 55, "width": 64, "height": 64, "artId": 10400 },
    { "type": "button", "x": 24, "y": 165, "width": 30, "height": 24, "normalId": 4023, "pressedId": 4024, "buttonId": 1 },
    { "type": "label", "x": 62, "y": 167, "width": 120, "height": 20, "hue": 1149, "text": "Claim" }
  ]
}
```

`{{name}}` text placeholders read from `gump.values`. Source-linked overrides
can also access `texts` and `original`:

```js
api.gumps.send(ctx.state, {
  definitionId: 'daily-reward',
  values: { playerName: ctx.sender.name },
  layout: fallbackLayout,
  texts: fallbackTexts,
}, onResponse);
```

## JSON controls

| Type | Main fields |
| --- | --- |
| `panel` | `x`, `y`, `width`, `height`, `artId` |
| `label` | geometry, `text`, `hue` |
| `button` | geometry, `normalId`, `pressedId`, `buttonId`, `quit`, `page` |
| `textentry` | geometry, `entryId`, `text`, `hue` |
| `checkbox` / `radio` | `uncheckedId`, `checkedId`, `switchId`, `checked` |
| `image` | `artId`, optional geometry |
| `tilepic` | `artId`, `hue` |
| `html` | geometry, `text`, `background`, `scrollbar` |
| `alpha` | geometry |
| `page` | `page` |

Every gump and interactive control should have a stable identifier. Do not
derive `buttonId` from record position when ordering can change.

## Source-linked server gumps

`pnpm catalog:gumps:server` scans `api.gumps.send` calls and updates
`server-gump-catalog.json`. Each record retains a source path and line, allowing
the designer to open its functional JavaScript directly.

```json
{
  "definitionId": "server:commands-example:open-menu",
  "scope": "server",
  "mode": "source-linked",
  "source": "commands/example.js",
  "enabled": false,
  "width": 320,
  "height": 240,
  "controls": []
}
```

`enabled: false` is the safe default: production layout remains in code. After
recreating controls in the editor, set `enabled: true`; the resolver replaces
the layout while preserving the callback and all script logic.

## Local client gumps

Every discovered gump class has a record in `client-gumps.json`. The record is
an overlay on working client code:

```json
{
  "definitionId": "client:action-bar-gump",
  "scope": "client",
  "className": "ActionBarGump",
  "type": "actionbar",
  "source": "action-bar-gump.js",
  "frame": { "enabled": true, "width": 720, "height": 72, "opacity": 1 },
  "behavior": { "enabled": true, "canMove": true, "canClose": true },
  "controlOverrides": [
    { "enabled": true, "controlId": "status-label", "x": 12, "y": 8 }
  ]
}
```

The most stable selector is a `controlId` assigned by `setLayoutId()` in the
constructor. It survives insertion and reordering of other elements. Older
gumps can still be addressed by `className` + `classIndex` or a child-index
path such as `0.2`.

The file is a static client asset. If fetching fails, a record is invalid, or
the client connects to a third-party shard, the JS constructor still builds the
complete window. Visual editing is therefore never a compatibility requirement.

### Visual-novel NPC dialog

The dialog has a `client:npc-dialog-gump` record and a ready set of stable
controls: frame, panels, portrait, name, title, dialog text, list, and 24 action
slots named `action-1` through `action-24`. The same editor can move, resize,
hide, and change the opacity, text, hue, or graphic of each control. Dynamically
rebuilt NPC buttons receive their Studio overrides again after every response.

Conversation content and logic remain server-side and are edited through quest
data, vendor data, and NPC scripts. Disabling the override restores the built-in
client template; without `NpcDialog` negotiation, standard UO behavior remains.

## Editing in Content Studio

1. Select **Gumps & layouts**.
2. Edit data-driven gumps in `config/gumps.json`.
3. Inspect all discovered send sites in `config/server-gump-catalog.json`.
4. Edit local client windows in `@client/client-gumps.json`.
5. Drag and resize controls on the canvas and use the graphic pickers.
6. Resolve overflow, duplicate-ID, and missing-field warnings.
7. Publishing creates a backup. Client changes need a rebuild/page reload;
   server script-data changes need only a hot reload.

## Safety and performance rules

- Never generate an unbounded number of controls from player data.
- Keep text and response counts within reasonable limits.
- Never execute an action solely because a `buttonId` arrived; recheck ACL.
- Large gumps are packed automatically but still have a UO packet-size limit.
- A callback is connection-scoped and short-lived; store durable workflows as player data.
- Paginate dynamic lists instead of sending thousands of rows.
