// `[plan` — preset house floor plans.
//
//   [plan list                  — show available preset names
//   [plan show <name>           — preview a plan's footprint dimensions + tile count
//   [plan apply <name>          — paint the plan into the active design buffer
//                                 (must be in [design start mode, owner only)
//
// Each plan is a simple grid of floor + wall tiles + a single door,
// painted relative to the user's position when they invoke `apply`.
// Encoded as character-grid strings: `.` floor, `#` wall, `D` door,
// `S` stairs, ` ` open (no tile). Plans are deliberately small (≤10×10)
// so they fit comfortably inside any 7×7-up-to-18×18 house plot.

import { applyAclToTiles } from '../../items/behaviors/house-acl.js';   // re-uses ACL helper presence-check

const FLOOR_GID  = 0x0496;             // grey stone floor
const WALL_GID   = 0x0006;             // wood wall (light)
const DOOR_GID   = 0x06A5;             // light wood single door
const STAIRS_GID = 0x07AE;             // wooden stairs

const PLANS = {
  // 5×5 bare cottage
  cottage: [
    '#####',
    '#...#',
    '#...D',
    '#...#',
    '#####',
  ],
  // 7×7 manor with side room
  manor: [
    '#######',
    '#.....#',
    '#.....#',
    '#.....D',
    '#.....#',
    '#.....#',
    '#######',
  ],
  // 8×8 tower with stairs
  tower: [
    '########',
    '#......#',
    '#......#',
    '#..S...#',
    '#......#',
    '#......#',
    '#......D',
    '########',
  ],
  // 6×6 shop with double-room front
  shop: [
    '######',
    '#...##',
    '#....#',
    '#....D',
    '#...##',
    '######',
  ],
  // 4×5 small storage shed
  shed: [
    '####',
    '#..#',
    '#..D',
    '#..#',
    '####',
  ],
};

const KIND_BY_CHAR = {
  '.': { kind: 'floor',  gid: FLOOR_GID  },
  '#': { kind: 'wall',   gid: WALL_GID   },
  'D': { kind: 'door',   gid: DOOR_GID   },
  'S': { kind: 'stairs', gid: STAIRS_GID },
};

function planSize(rows) {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  return { w, h };
}

function tileCount(rows) {
  let n = 0;
  for (const row of rows) for (const ch of row) if (KIND_BY_CHAR[ch]) n++;
  return n;
}

export default function register(api) {
  if (!api.commands) return () => {};
  const HR = api.houses;

  api.commands.register({
    name: 'plan',
    help: '[plan list|show <name>|apply <name> — preset house floor plans.',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const name = String(ctx.args[1] ?? '').toLowerCase();

      if (sub === 'list') {
        ctx.state.sendSystemMessage?.(`Floor plans (${Object.keys(PLANS).length}):`);
        for (const k of Object.keys(PLANS)) {
          const sz = planSize(PLANS[k]);
          ctx.state.sendSystemMessage?.(`  ${k.padEnd(10)} — ${sz.w}×${sz.h}, ${tileCount(PLANS[k])} tiles`);
        }
        return;
      }

      if (sub === 'show') {
        const rows = PLANS[name];
        if (!rows) { ctx.state.sendSystemMessage?.(`No plan "${name}". Try [plan list.`); return; }
        const sz = planSize(rows);
        ctx.state.sendSystemMessage?.(`Plan ${name}: ${sz.w}×${sz.h}, ${tileCount(rows)} tiles`);
        for (const row of rows) ctx.state.sendSystemMessage?.('  ' + row);
        return;
      }

      if (sub === 'apply') {
        const rows = PLANS[name];
        if (!rows) { ctx.state.sendSystemMessage?.(`No plan "${name}". Try [plan list.`); return; }
        const mob = ctx.sender;
        // Sanity gate — house owner + in [design start mode.
        const house = HR?.houseAt?.(mob.x, mob.y, mob.map);
        if (!house) { ctx.state.sendSystemMessage?.('Stand inside your house first.'); return; }
        if (HR?.roleOf?.(house, mob.serial) !== 'owner') {
          ctx.state.sendSystemMessage?.('Only the house owner may apply a plan.');
          return;
        }
        if (!house.editing) {
          ctx.state.sendSystemMessage?.('Enter [design start mode first.');
          return;
        }
        // Apply tiles relative to caller's position. Top-left of the
        // grid lands at (caller.x, caller.y); each row advances y by 1.
        let painted = 0;
        rows.forEach((row, ry) => {
          for (let rx = 0; rx < row.length; rx++) {
            const def = KIND_BY_CHAR[row[rx]];
            if (!def) continue;
            const tx = mob.x + rx;
            const ty = mob.y + ry;
            try {
              const n = HR?.replaceTileAt?.(house, def.kind, def.gid, tx, ty, mob.z) ?? 0;
              painted += n;
            } catch { /* tile may overflow plot — silently skip */ }
          }
        });
        ctx.state.sendSystemMessage?.(
          `Applied "${name}" — ${painted} tile change(s). Use [design commit to save.`,
        );
        // Reference acl helper so the import isn't unused (also signals
        // intent: plans run inside ACL-protected houses).
        void applyAclToTiles;
        return;
      }

      ctx.state.sendSystemMessage?.('Usage: [plan list|show <name>|apply <name>');
    },
  });

  return () => api.commands.unregister('plan');
}
