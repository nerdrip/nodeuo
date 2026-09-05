# Tutorial: add and edit a game system

This tutorial creates a complete activity that works on ordinary UO clients and receives a richer view on NodeUO.

## Edit in the admin panel

1. Open **Admin → Content Studio**.
2. Select **Game systems** and `config/game-systems.json`.
3. Duplicate a related system or choose **New record**.
4. Enter a stable kebab-case ID. Never change an ID after players have earned completion history; rename only the display name.
5. Choose a category and archetype. The archetype supplies sensible default actions and event behavior.
6. Write a player-facing name and summary.
7. Configure the definition version, difficulty, primary skill, duration, action cooldown, stamina cost, player bounds, teams, entry cost, availability, anti-exploit policy, and rewards.
8. Create at least three meaningful stages: discovery or preparation, central challenge, and resolution.
9. Set `clientMode` according to the compatibility rules. Prefer `hybrid`.
10. Validate the draft, review the diff, save it, then open **Admin → Game Systems** and select **Validate & reload**.
11. Use **Simulate balance** at several skill values before starting an instance.
12. Start the selected system or let its first participant create it on demand.

The visual stage designer edits every stage's ID, name, description, goal, event, skill, actions, contribution cap, unique-target rule, maps, regions, and source/target filters. Stages can be added, reordered, duplicated, or removed while preserving the required 3–12 range. Reward-item cards support multiple independently rolled items and visual art/hue pickers. Use the structured field editor only for completion-prerequisite maps and `nextStageByAction` branch objects. New records contain complete stage objects. Compact strings are accepted only as a legacy import convenience.

Manual action order defines its gameplay role. Put the direct objective action first (**execute**), the cooperative action second (**support**), and planning/research actions third or later (**prepare**). Execute has the best immediate throughput, support raises bounded shared momentum, and prepare costs half stamina while raising personal focus. The Classic and NodeUO interfaces label these roles, and **Simulate balance** compares their success probability and expected contribution.

## Minimal record

```json
{
  "id": "lost-observatory",
  "version": 1,
  "name": "The Lost Observatory",
  "category": "pve",
  "archetype": "exploration",
  "summary": "Survey a ruined observatory, repair its lenses, and decode a star map.",
  "difficulty": 4,
  "skill": "Cartography",
  "durationMinutes": 90,
  "cooldownSeconds": 2,
  "staminaCost": 1,
  "party": { "min": 1, "max": 8, "teams": 1 },
  "entry": { "gold": 0, "tokens": 0 },
  "availability": {
    "maps": [], "regions": [], "daysOfWeek": [],
    "startHourUtc": 0, "endHourUtc": 24,
    "minAccountAgeDays": 0, "requiredCompletions": {}
  },
  "antiExploit": {
    "completionCooldownMinutes": 30,
    "dailyCompletionLimit": 5,
    "maxActionsPerMinute": 30,
    "maxEventContribution": 80,
    "minParticipationPercent": 10,
    "requireUniqueEventTarget": true,
    "accountWide": true
  },
  "reward": {
    "gold": 500, "tokens": 20, "title": "Observatory Scholar",
    "reputation": 8,
    "unlocks": ["observatory-completed"],
    "items": [{
      "id": "observatory-star-chart", "name": "Recovered Star Chart",
      "artId": 5359, "hue": 1150, "amount": 1,
      "chancePermille": 250, "accountBound": true
    }]
  },
  "clientMode": "hybrid",
  "enhancedView": "star-map",
  "stages": [{
    "id": "find", "name": "Find the ruined observatory",
    "description": "Visit a new candidate mountain region.",
    "goal": 3, "event": "region:enter", "skill": "Cartography",
    "actions": ["inspect-status"], "allowManual": false,
    "targetKinds": [], "sourceKinds": [], "regions": [], "maps": [],
    "uniqueTargets": 3, "contributionCap": 3, "nextStageByAction": {}
  }, {
    "id": "repair", "name": "Repair the primary lenses",
    "description": "Craft and install replacement lens assemblies.",
    "goal": 12, "event": "craft:completed", "skill": "Tinkering",
    "actions": ["inspect-status"], "allowManual": false,
    "targetKinds": [], "sourceKinds": [], "regions": [], "maps": [],
    "uniqueTargets": 0, "contributionCap": 12, "nextStageByAction": {}
  }, {
    "id": "decode", "name": "Decode the recovered star map",
    "description": "Complete the interactive decoding challenge.",
    "goal": 20, "event": "activity:action", "skill": "Cartography",
    "actions": ["study", "compare", "publish"], "allowManual": true,
    "targetKinds": [], "sourceKinds": [], "regions": [], "maps": [],
    "uniqueTargets": 0, "contributionCap": 10, "nextStageByAction": {}
  }]
}
```

## Advanced stages

```json
"stages": [
  {
    "id": "survey",
    "name": "Find the ruined observatory",
    "description": "Visit three candidate mountain regions.",
    "goal": 3,
    "event": "region:enter",
    "skill": "Cartography",
    "actions": ["inspect-status"],
    "allowManual": false,
    "uniqueTargets": 3
  },
  {
    "id": "repair",
    "name": "Repair the primary lenses",
    "goal": 12,
    "event": "craft:completed",
    "skill": "Tinkering",
    "actions": ["contribute", "research", "deliver"]
  },
  {
    "id": "decode",
    "name": "Decode the recovered star map",
    "goal": 20,
    "event": "activity:action",
    "skill": "Cartography",
    "actions": ["study", "compare", "publish"]
  }
]
```

Do not use a high goal with a one-time event unless its payload supplies a larger contribution. `actions` still provides status labels for world-event stages, but set `allowManual` to false so a button cannot impersonate a kill, craft, delivery, or location event.

## Versioning and live reload

Increment `version` whenever rules, stages, entry, or rewards change. Reload validates the complete replacement catalog and every adapter before swapping it in. Existing runs retain an immutable normalized definition snapshot and finish under the rules on which they started; only new runs use the new version.

## Schedules and access

- Empty `maps`, `regions`, and `daysOfWeek` arrays mean unrestricted.
- Hours are UTC and support overnight windows such as `startHourUtc: 20`, `endHourUtc: 4`.
- `requiredCompletions` maps stable system IDs to required counts.
- `accountWide` prevents two characters from the same account entering one run and moves cooldown/daily enforcement to persistent account-scoped state.
- Completion cooldown and daily completion limits are checked again on join.
- Unique event targets and contribution caps prevent repeated packets or one extreme damage value from completing an objective.

## Add specialized server behavior

Most additions need no protocol change. Put the deeper mechanic in a normal script and emit a world event after the server has verified it:

```js
export default function register(api) {
  const stop = api.events.on('observatory:lens-installed', ({ player, quality }) => {
    api.systems.gameSystems.recordEvent('observatory:lens-installed', {
      player,
      amount: Math.max(1, Math.min(5, quality | 0)),
      gameSystemId: 'lost-observatory',
    });
  });
  return () => stop();
}
```

Reference that event in the stage. The script works for every client because it uses ordinary server state and the shared event bus.

## Add an enhanced view

Only add a NodeUO view when ordinary gumps, speech, targeting, and world objects cannot provide a usable interaction.

1. Add a string-keyed feature to `packages/nodeuo-protocol/src/index.js` only if the feature is genuinely independent. Reuse `game.systems` for another activity view.
2. Add or extend its payload schema and dependencies in `manifest.js`.
3. Keep all validation and mutations in the server runtime or handler.
4. Add a lazy-loaded client gump and subscribe to a dedicated event bus event.
5. Preserve the Classic fallback gump and its required-client explanation.
6. Generate protocol types and fixtures.
7. Test both negotiated and non-negotiated sessions.

The shipped `game.systems` workbench already supports catalog browsing, filtering, live state, joining, leaving, contributing, and leaderboards. A specialized view should focus only on the interaction it adds, such as a card table or music timeline.

## Validate and publish

Before publishing:

- validate the complete catalog in Content Studio;
- verify IDs are unique and every system has at least three stages;
- run a balance simulation at skill 30, 70, and 100;
- test `[activities` on a Classic session;
- test the enhanced workbench on a negotiated NodeUO session;
- save during an active instance, restart, and verify stage and membership restoration;
- finish the final stage and verify that rewards are issued once;
- verify `[wipeworld` clears live instances but keeps earned character progression;
- update English documentation when adding a new event or client-only interaction.

If a reload fails validation, the runtime keeps the existing in-memory catalog and reports the error. Correct the draft and reload again; do not edit live instance state by hand.
