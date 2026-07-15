import { itemBySerial, mobileBySerial } from '../../_entities.js';
import { nearbyClients, onlineMobiles } from '../../_spatial.js';
// Default context menu provider — supplies generic entries for mobiles and items.
//
// Gameplay-specific providers (e.g. the Town Crier has "Hear the news") can
// replace this by calling `api.contextMenus.setProvider(...)` themselves; this
// default runs only when no other provider is installed.

const clilocs = {
  PaperDoll: 3006123,
  Profile: 3006124,
  OpenBackpack: 3006145,
  Followers: 3006108,
  HearNews: 3006109,
  Cancel: 3006168,
  Buy: 3006121,
  Sell: 3006122,
  Train: 3006146,
  PetGuard: 3006107,
  PetFollow: 3006108,
  PetKill: 3006111,
  PetStay: 3006114,
  PetRelease: 3006118,
  Mount: 1157587,
  Dismount: 1028843,
  Use: 3006132,
  Properties: 1062761,
  SetHue: 1151720,
};

function refreshItem(api, state, item) {
  const parent = item.parent == null ? null : (item.parent >>> 0);
  const owner = parent == null ? null : mobileBySerial(api, parent);
  if (owner && item.layer && api.protocol?.equipUpdate) {
    const pkt = api.protocol.equipUpdate({
      serial: item.serial, itemId: item.itemId, layer: item.layer,
      parent: owner.serial, hue: item.hue ?? 0,
    });
    for (const viewer of nearbyClients(api, owner, null, 18)) viewer.client.send(pkt);
    return;
  }
  if (parent != null && api.protocol?.containerContentUpdate) {
    const pkt = api.protocol.containerContentUpdate({
      serial: item.serial, itemId: item.itemId, amount: item.amount ?? 1,
      gridX: item.gridX ?? 0, gridY: item.gridY ?? 0,
      gridLocation: item.gridLocation ?? 0, hue: item.hue ?? 0,
    }, parent);
    for (const mob of onlineMobiles(api)) {
      if (mob.client?.openContainers?.has?.(parent)) mob.client.send(pkt);
    }
    return;
  }
  for (const viewer of nearbyClients(api, state.mobile, null, 18)) {
    viewer.client.sendItem?.(item);
  }
}

function openHueEditor(api, state, item) {
  if (!api.gumps?.send) return;
  const texts = [
    `Set Hue — ${item.name ?? `item 0x${(item.itemId | 0).toString(16)}`}`,
    'Hue (decimal or 0x...):',
    `0x${(item.hue ?? 0).toString(16)}`,
    'Apply',
  ];
  api.gumps.send(state, {
    gumpId: 0x48554500 ^ (item.serial & 0xffff), x: 120, y: 100,
    layout: [
      '{ resizepic 0 0 5054 340 128 }',
      '{ text 18 14 1153 0 }',
      '{ text 18 48 1152 1 }',
      '{ textentry 180 46 130 20 1152 1 2 }',
      '{ button 18 88 4005 4007 1 0 1 }',
      '{ text 50 89 1153 3 }',
      '{ button 300 8 4017 4018 1 0 0 }',
    ].join(''),
    texts,
  }, (resp) => {
    if ((resp?.buttonId | 0) !== 1) return;
    const raw = resp.textEntries?.find?.((e) => (e.entryId | 0) === 1)?.text?.trim() ?? '';
    const hue = /^0x/i.test(raw) ? parseInt(raw, 16) : parseInt(raw, 10);
    if (!Number.isFinite(hue) || hue < 0 || hue > 0x0fff) {
      state.sendSystemMessage?.('Hue must be between 0 and 0x0FFF.');
      return;
    }
    item.hue = hue | 0;
    refreshItem(api, state, item);
    const result = state.ctx?.propertyProvider?.(item.serial, state);
    if (result?.entries) api.properties?.send?.(state, item.serial, result.entries);
  });
}

export default function (api) {
  const { contextMenus, world } = api;
  if (!contextMenus) return;

  contextMenus.setProvider(api.ctx, (state, serial) => {
    // Mobile target → paperdoll + follow.
    const mob = mobileBySerial({ world }, serial);
    if (mob) {
      const entries = [
        {
          responseId: 1,
          cliloc: clilocs.PaperDoll,
          onPick: () => {
            state.send(api.protocol.openPaperdoll({
              serial: mob.serial,
              title: `${mob.name ?? 'You'}, the Wanderer`,
              flags: 0x02,
            }));
          },
        },
        {
          // Profile context entry — server replies with 0xB8 ProfileResp
          // unconditionally; the client's ProfileGump intercepts the
          // packet and opens its window. Real CUO clients do the same.
          responseId: 3,
          cliloc: clilocs.Profile,
          onPick: () => {
            if (!api.protocol.profileResponse) return;
            state.send(api.protocol.profileResponse({
              serial: mob.serial,
              header: `Profile of ${mob.name ?? 'a stranger'}`,
              title: '',
              body: mob.profileBody ?? '',
            }));
          },
        },
      ];
      if (mob === state.mobile && state.mobile?.mountedFrom) {
        entries.push({
          responseId: 4,
          cliloc: clilocs.Dismount,
          onPick: () => state.ctx?.commands?.dispatch?.('mount', {
            sender: state.mobile, state, world, args: [],
          }),
        });
      }
      if ((mob.controlMaster >>> 0) === (state.mobile?.serial >>> 0)) {
        const order = (command, targetSerial = 0) => {
          mob.petCommand = command;
          const binding = api.ai?.bindings?.get?.(mob.serial);
          if (binding?.state) { binding.state.command = command; binding.state.targetSerial = targetSerial >>> 0; }
        };
        entries.push(
          { responseId: 100, cliloc: clilocs.PetFollow, onPick: () => order('follow') },
          { responseId: 101, cliloc: clilocs.PetStay, onPick: () => order('stay') },
          { responseId: 102, cliloc: clilocs.PetGuard, onPick: () => order('guard') },
          { responseId: 103, cliloc: clilocs.PetKill, onPick: () => {
            state.sendSystemMessage?.('Choose a target for your pet.');
            api.targeting?.request?.(state, (picked) => {
              if (picked?.serial) order('attack', picked.serial);
            }, { kind: 0 });
          } },
          { responseId: 104, cliloc: clilocs.Train, onPick: () => {
            const PT = api.systems?.petTraining;
            const sn = PT?.xpProgressOf?.(mob) ?? { level: 0, pct: 0, intoLevel: 0 };
            state.sendSystemMessage?.(`@@OPEN_PETTRAINING_GUMP@@${[
              (mob.serial >>> 0).toString(16), (mob.name ?? '?').replace(/[|;]/g, '_'),
              sn.level | 0, sn.pct | 0, sn.intoLevel | 0,
              PT?.trainingPointsAvailable?.(mob) ?? 0,
              (mob.petTrainingAbilities ?? []).join(','),
            ].join('|')}`);
          } },
          { responseId: 105, cliloc: clilocs.PetRelease, onPick: () => {
            mob.controlMaster = 0; mob.notoriety = 3;
            delete mob.petCommand; delete mob.bonded;
            api.ai?.attach?.(mob, 'wander');
            state.sendSystemMessage?.(`${mob.name ?? 'The pet'} has been released.`);
          } },
        );
        const mountCfg = api.monsters?.get?.(mob.kind) ?? {};
        if (mountCfg.mount || mob._mountCargoSerial) {
          entries.push({ responseId: 106, cliloc: clilocs.OpenBackpack, onPick: () => {
            state.ctx?.commands?.dispatch?.('mount cargo', { sender: state.mobile, state, world });
          } });
        }
        if (mountCfg.mount) {
          entries.push({ responseId: 107, cliloc: clilocs.Mount, onPick: () => {
            state.ctx?.commands?.dispatch?.('mount', { sender: state.mobile, state, world });
          } });
        }
      }
      if (mob.ai === 'townCrier') {
        entries.push({
          responseId: 2,
          cliloc: clilocs.HearNews,
          onPick: () => {
            state.send(api.protocol.unicodeMessage({
              serial: mob.serial, graphic: mob.body, name: mob.name,
              type: 6, hue: 52, font: 3, language: 'ENU',
              text: 'Hear ye, hear ye! The roads are safe today!',
            }));
          },
        });
      }
      // FAZA BE: trainer NPCs get a "Train …" entry that opens a small
      // gump listing the skills they teach. Cliloc 3006146 is "Train"
      // in CUO's context menu space. Each gump button sends a generic
      // 0xB1 response back; trainer.js reacts via `_pendingTrainRequest`
      // (set by onPick here) on the next AI tick.
      if (Array.isArray(mob.teaches) && mob.teaches.length > 0) {
        entries.push({
          responseId: 30,
          cliloc: clilocs.Train ?? 3006146,
          onPick: () => {
            if (!api.gumps?.send) return;
            const skillNames = api.skills?.byId
              ? mob.teaches.map((id) => ({
                  id,
                  name: api.skills.byId.get(id)?.name ?? `Skill ${id}`,
                }))
              : mob.teaches.map((id) => ({ id, name: `Skill ${id}` }));
            // Single-page gump: header + N buttons (button id == skill id).
            const W = 260, H = 60 + 22 * skillNames.length;
            const layoutParts = [
              '{ resizepic 0 0 5054 ' + W + ' ' + H + ' }',
              '{ text 20 14 1153 0 }',
              '{ text 20 32 1152 1 }',
            ];
            // texts[0] = title, texts[1] = subtitle, then per-skill entries
            // texts[2..2+N] = skill names. button payloads use the skill id.
            const texts = [
              `${mob.name} — Training`,
              `25 gold per skill, capped at 30.0`,
            ];
            for (let i = 0; i < skillNames.length; i++) {
              const yOff = 60 + i * 22;
              layoutParts.push(`{ button 18 ${yOff} 4005 4007 1 0 ${skillNames[i].id} }`);
              layoutParts.push(`{ text 50 ${yOff + 1} 1153 ${2 + i} }`);
              texts.push(skillNames[i].name);
            }
            api.gumps.send(state, {
              gumpId: 0x47524E + (mob.serial & 0xFFF),
              x: 100, y: 100,
              layout: layoutParts.join(''),
              texts,
              onResponse: (response) => {
                const requestedSkill = response.buttonId | 0;
                if (!requestedSkill) return; // close
                if (!mob.teaches.includes(requestedSkill)) return;
                // Stash a synthetic speech entry on the trainer's queue
                // so the existing trainer behaviour (speech-driven) does
                // the gold deduction + skill bump on its next tick. The
                // text of the synthetic entry is the skill's lower-case
                // name so the keyword matcher inside trainer.js fires.
                const skName = api.skills?.byId?.get?.(requestedSkill)?.name?.toLowerCase()
                  ?? '';
                if (!skName) return;
                mob._heardSpeech ??= [];
                mob._heardSpeech.push({ speaker: state.mobile, text: skName, hue: 0 });
              },
            });
          },
        });
      }
      if (api.vendors?.get?.(mob.serial)) {
        entries.push({
          responseId: 10, cliloc: clilocs.Buy,
          onPick: () => api.vendors.openBuy(state, mob.serial),
        });
        entries.push({
          responseId: 11, cliloc: clilocs.Sell,
          onPick: () => {
            const ok = api.vendors.openSell(state, mob.serial);
            if (!ok) state.sendSystemMessage?.('You have nothing I would buy.');
          },
        });
      }
      return entries;
    }
    // Item target → use / open.
    const item = itemBySerial({ world }, serial);
    // Wave 19: showcase display case context menu — `Inspect` entry
    // emits the same multi-line readout `[showcaseinspect` produces,
    // but reachable via right-click instead of typing the command.
    // Detected via `item.display.itemSerial` set by the showcase pin
    // command (graphic 0x10A6).
    if (!item) return null;
    const entries = [
      {
        responseId: 1,
        cliloc: clilocs.Use,
        onPick: () => api.contextMenus?.use?.(state, item.serial),
      },
      {
        responseId: 2,
        cliloc: clilocs.Properties,
        onPick: () => {
          const result = state.ctx?.propertyProvider?.(item.serial, state);
          if (result?.entries) api.properties?.send?.(state, item.serial, result.entries);
          else state.sendSystemMessage?.('No properties are available for this item.');
          state.sendSystemMessage?.([
            item.name ?? `item 0x${(item.itemId | 0).toString(16)}`,
            `serial=0x${(item.serial >>> 0).toString(16)}`,
            `graphic=0x${(item.itemId | 0).toString(16)}`,
            `hue=0x${(item.hue ?? 0).toString(16)}`,
            `amount=${item.amount ?? 1}`,
          ].join(' • '));
        },
      },
    ];
    const access = state.account?.accessLevel ?? 'Player';
    if (access === 'GM' || access === 'Admin') {
      entries.push({
        responseId: 3,
        cliloc: clilocs.SetHue,
        onPick: () => openHueEditor(api, state, item),
      });
    }
    if (item.display?.itemSerial) {
      const pinned = itemBySerial({ world }, item.display.itemSerial);
      if (pinned) {
        entries.push({
          responseId: 50,
          cliloc: 3006117,        // "Examine" (closest fit) cliloc
          onPick: () => {
            const lines = ['Display case contents:'];
            if (pinned._artifact) lines.push(`  Artifact: ${pinned._artifact}`);
            else if (pinned.name) lines.push(`  Item: ${pinned.name}`);
            else lines.push(`  Item id: 0x${(pinned.itemId | 0).toString(16)}`);
            if (Array.isArray(pinned._magicProps) && pinned._magicProps.length) {
              lines.push('  Properties:');
              for (const p of pinned._magicProps) {
                if (p.kind === 'skill') {
                  lines.push(`    +${(p.value ?? 0).toFixed(1)} ${p.skill ?? ''}`);
                } else if (p.isFlag) {
                  lines.push(`    ${p.attribute ?? '?'}`);
                } else {
                  const sign = (p.intensity ?? 0) >= 0 ? '+' : '';
                  lines.push(`    ${sign}${p.intensity ?? 0} ${p.attribute ?? '?'}`);
                }
              }
            }
            if (pinned._magicResists && typeof pinned._magicResists === 'object') {
              const order = ['physical','fire','cold','poison','energy'];
              const parts = order.map((k) => `${k.slice(0,4)} ${pinned._magicResists[k] ?? 0}`);
              lines.push(`  Resists: ${parts.join(' / ')}`);
            }
            state.sendSystemMessage?.(lines.join('\n'));
          },
        });
      }
      return entries;
    }
    return entries;
  });
}
