import { allMobiles } from '../../_spatial.js';
// `[vendorhue` — GM clickable swatch picker for the nearest vendor's
// custom title hue. Spawns a 4×4 grid (16 swatches) plus a Clear
// button. Click swatch → stamp `_customTitleHue` + immediate
// mobileIncoming broadcast (refresh hue on every observer's screen).
//
// Mirrors `[vendortitle <kind> ... #hue` mechanic but targets the
// single nearest vendor (no kind filter, no title text mutation),
// and offers a UI alternative to typing hex codes.

const RANGE = 6;

// Wave 35: tracks which named palette currently fills SWATCHES (if
// any). `palette load <name>` sets it; `palette delete <name>` uses
// it for a confirm gate; clearing happens implicitly when the
// process restarts (defaults reload).
let _activePaletteName = null;

// Curated palette of common UO body hues that read well on humanoid
// vendors. Mix of warm/cool tones plus the existing tier defaults.
const SWATCHES = [
  0x021E, 0x044E, 0x047E, 0x04B5,
  0x0481, 0x025A, 0x0260, 0x0399,
  0x0455, 0x03E2, 0x044D, 0x0490,
  0x0524, 0x05A1, 0x05F4, 0x070E,
];

function findNearestVendor(world, mob) {
  let best = null, bestD = RANGE + 1;
  for (const m of allMobiles({ world })) {
    if (!m.vendorKind) continue;
    if (m.map !== mob.map) continue;
    const d = Math.max(Math.abs(m.x - mob.x), Math.abs(m.y - mob.y));
    if (d <= bestD) { best = m; bestD = d; }
  }
  return best;
}

export default function (api) {
  const { commands, world } = api;
  if (!commands) return () => {};

  commands.register({
    name: 'vendorhue',
    help: '[vendorhue | palette save|load|list|delete|rename|duplicate|swap <name> — picker + palette ops (GM).',
    access: 'GM',
    run(ctx) {
      const mob = ctx.sender;
      if (!mob) return;
      // Wave 33: palette presets. Stored on the GM mob as
      // `_huePalettes: Map<name, number[]>` (cap 16 hues per palette).
      const subArg = String(ctx.args[0] ?? '').toLowerCase();
      if (subArg === 'palette') {
        const action = String(ctx.args[1] ?? '').toLowerCase();
        const name = ctx.args[2]?.toLowerCase();
        mob._huePalettes ??= new Map();
        if (action === 'list') {
          const keys = [...mob._huePalettes.keys()];
          ctx.state.sendSystemMessage(
            keys.length ? `Saved palettes: ${keys.join(', ')}` : 'No saved palettes.',
          );
          return;
        }
        // Wave 36: palette rename + duplicate.
        if (action === 'rename') {
          const newName = ctx.args[3]?.toLowerCase();
          if (!name || !newName) {
            ctx.state.sendSystemMessage('Usage: [vendorhue palette rename <old> <new>');
            return;
          }
          const palette = mob._huePalettes.get(name);
          if (!palette) {
            ctx.state.sendSystemMessage(`No palette "${name}" to rename.`);
            return;
          }
          if (mob._huePalettes.has(newName)) {
            ctx.state.sendSystemMessage(`Palette "${newName}" already exists. Delete it first.`);
            return;
          }
          mob._huePalettes.delete(name);
          mob._huePalettes.set(newName, palette);
          if (_activePaletteName === name) _activePaletteName = newName;
          ctx.state.sendSystemMessage(`Renamed palette "${name}" → "${newName}".`);
          return;
        }
        if (action === 'duplicate') {
          const newName = ctx.args[3]?.toLowerCase();
          if (!name || !newName) {
            ctx.state.sendSystemMessage('Usage: [vendorhue palette duplicate <src> <dst>');
            return;
          }
          const src = mob._huePalettes.get(name);
          if (!src) {
            ctx.state.sendSystemMessage(`No palette "${name}" to duplicate.`);
            return;
          }
          if (mob._huePalettes.has(newName)) {
            ctx.state.sendSystemMessage(`Palette "${newName}" already exists. Delete it first.`);
            return;
          }
          // Independent copy — slice() so subsequent edits to one
          // don't leak to the other.
          mob._huePalettes.set(newName, src.slice());
          ctx.state.sendSystemMessage(`Duplicated palette "${name}" → "${newName}".`);
          return;
        }
        // Wave 37: swap two palette names atomically. Useful for
        // rotating an "experimental" palette into the canonical slot
        // without going through delete/rename ping-pong.
        if (action === 'swap') {
          const otherName = ctx.args[3]?.toLowerCase();
          if (!name || !otherName) {
            ctx.state.sendSystemMessage('Usage: [vendorhue palette swap <a> <b>');
            return;
          }
          if (name === otherName) {
            ctx.state.sendSystemMessage('Swap targets must differ.');
            return;
          }
          const a = mob._huePalettes.get(name);
          const b = mob._huePalettes.get(otherName);
          if (!a || !b) {
            ctx.state.sendSystemMessage(
              !a && !b
                ? `Neither "${name}" nor "${otherName}" exist.`
                : `No palette "${!a ? name : otherName}".`,
            );
            return;
          }
          mob._huePalettes.set(name, b);
          mob._huePalettes.set(otherName, a);
          // Active palette pointer follows the data — if "a" was the
          // loaded swatch set, after swap "a" still points at SWATCHES'
          // contents, but those contents now correspond to b's hues.
          // _activePaletteName remains valid (still points at the
          // currently-loaded name); SWATCHES isn't touched here so the
          // GM has to `palette load` again to see the swap visually.
          ctx.state.sendSystemMessage(`Swapped palettes "${name}" ↔ "${otherName}".`);
          return;
        }
        // Wave 34: palette delete.
        // Wave 35: confirm-gate gdy palette jest aktualnie loaded —
        // accidental delete of the in-use SWATCHES would silently
        // strip the picker. Caller passes `CONFIRM` (case-sensitive)
        // jako 4th arg żeby pokonać guard.
        if (action === 'delete') {
          if (!name) { ctx.state.sendSystemMessage('Usage: [vendorhue palette delete <name> [CONFIRM]'); return; }
          if (!mob._huePalettes.has(name)) {
            ctx.state.sendSystemMessage(`No palette "${name}" to delete.`);
            return;
          }
          if (_activePaletteName === name && ctx.args[3] !== 'CONFIRM') {
            ctx.state.sendSystemMessage(
              `Palette "${name}" is currently loaded as the active swatch set. ` +
              `Run [vendorhue palette delete ${name} CONFIRM to delete anyway.`,
            );
            return;
          }
          mob._huePalettes.delete(name);
          if (_activePaletteName === name) _activePaletteName = null;
          ctx.state.sendSystemMessage(`Deleted palette "${name}".`);
          return;
        }
        if (!name || (action !== 'save' && action !== 'load')) {
          ctx.state.sendSystemMessage(
            'Usage: [vendorhue palette <save|load|list|delete|rename|duplicate|swap> [name]',
          );
          return;
        }
        if (action === 'save') {
          // Combine GM-recent + nearest-vendor favorites + current
          // SWATCHES, dedup, cap 16. Captures the GM's working set.
          const target = findNearestVendor(world, mob);
          const fav = Array.isArray(target?._favoriteHues) ? target._favoriteHues : [];
          const rec = Array.isArray(mob._lastVendorHues) ? mob._lastVendorHues : [];
          const combined = [...rec, ...fav, ...SWATCHES];
          const dedup = [];
          for (const h of combined) {
            if (!dedup.includes(h)) dedup.push(h);
            if (dedup.length >= 16) break;
          }
          mob._huePalettes.set(name, dedup);
          ctx.state.sendSystemMessage(`Saved palette "${name}" (${dedup.length} hues).`);
          return;
        }
        if (action === 'load') {
          const palette = mob._huePalettes.get(name);
          if (!palette) {
            ctx.state.sendSystemMessage(`No palette "${name}".`);
            return;
          }
          // Overwrite the active SWATCHES array (module-level) so the
          // next gump open uses the loaded palette. Active for the
          // current process — survives via `_huePalettes` on save.
          SWATCHES.length = 0;
          for (const h of palette.slice(0, 16)) SWATCHES.push(h);
          // Wave 35: track the active palette name globally so delete
          // can warn if the user is about to delete the live palette.
          _activePaletteName = name;
          ctx.state.sendSystemMessage(`Loaded palette "${name}" — open [vendorhue to use.`);
          return;
        }
      }

      const vendor = findNearestVendor(world, mob);
      if (!vendor) {
        ctx.state.sendSystemMessage('No vendor within 6 tiles.');
        return;
      }
      if (!api.gumps?.send) {
        ctx.state.sendSystemMessage('Gump host unavailable.');
        return;
      }

      // Layout: 4×4 grid of "tilepic" swatches using gumpic 5018
      // (small square frame). The hue parameter on `tilepic` itself
      // controls the visible color when applied to a flat graphic.
      // gumpic format: { gumppic x y gumpid hue }
      // Wave 30: row of recently-used quick-picks above the main grid.
      // Stored per-GM mob via `_lastVendorHues` (FIFO cap 4, dedup).
      const recentHues = Array.isArray(mob._lastVendorHues) ? mob._lastVendorHues.slice(-4) : [];
      // Wave 31: per-vendor favorite hues. Distinct from the GM's
      // global recents so a busy curator can keep separate palettes
      // for each themed vendor (e.g. blacksmith always re-applies
      // its smoky greys, alchemist its violets).
      const favHues = Array.isArray(vendor._favoriteHues) ? vendor._favoriteHues.slice(-4) : [];
      const W = 320;
      const extraRows = (recentHues.length ? 1 : 0) + (favHues.length ? 1 : 0);
      const H = 200 + extraRows * 40;
      const layout = [
        `{ resizepic 0 0 5054 ${W} ${H} }`,
        `{ text 16 14 1153 0 }`,
      ];
      const texts = [`Hue picker — ${vendor.name}`];
      let txIdx = 1;
      const SW_SIZE = 32;
      const COLS = 4;
      let startX = 24, startY = 40;
      // Helper: render a labelled row of swatches at startY, returns
      // updated startY.
      const renderSwatchRow = (label, hues, btnBase) => {
        layout.push(`{ text ${startX} ${startY} 1153 ${txIdx} }`);
        texts.push(label);
        txIdx++;
        let rx = startX + 64;
        for (let r = 0; r < hues.length; r++) {
          const hue = hues[r];
          layout.push(`{ tilepichue ${rx} ${startY - 4} 0x520 ${hue} }`);
          layout.push(`{ button ${rx} ${startY - 4} 4011 4012 1 0 ${btnBase + r} }`);
          rx += SW_SIZE + 4;
        }
        startY += SW_SIZE + 12;
      };
      if (favHues.length) renderSwatchRow('Vendor:', favHues, 280);   // 280..283
      if (recentHues.length) renderSwatchRow('Recent:', recentHues, 250);   // 250..253
      for (let i = 0; i < SWATCHES.length; i++) {
        const hue = SWATCHES[i];
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const sx = startX + col * (SW_SIZE + 8);
        const sy = startY + row * (SW_SIZE + 8);
        // tilepic with hue argument paints the small square in that hue.
        layout.push(`{ tilepichue ${sx} ${sy} 0x520 ${hue} }`);
        // Click button overlaid on the swatch.
        layout.push(`{ button ${sx} ${sy} 4011 4012 1 0 ${100 + i} }`);
        // Hue label below.
        layout.push(`{ text ${sx - 2} ${sy + SW_SIZE} 1152 ${txIdx} }`);
        texts.push(`0x${hue.toString(16).toUpperCase()}`);
        txIdx++;
      }
      // Clear button — restores baseline (uses the existing path in
      // refreshVendorTitle which falls back to _originalHue).
      layout.push(`{ button 24 ${H - 30} 4017 4018 1 0 200 }`);
      layout.push(`{ text 56 ${H - 30} 1153 ${txIdx} }`);
      texts.push('Clear');
      txIdx++;
      // Wave 32: "Freeze" button — snapshot current hue as
      // `_baselineHue`. Subsequent Clear reverts to `_baselineHue`
      // (if set) instead of `_originalHue`. Lets a GM lock in a
      // theme color as canonical and undo only later experiments.
      layout.push(`{ button 110 ${H - 30} 4023 4024 1 0 201 }`);
      layout.push(`{ text 142 ${H - 30} 1153 ${txIdx} }`);
      texts.push('Freeze');
      txIdx++;
      // Close.
      layout.push(`{ button ${W - 60} ${H - 30} 4020 4021 1 0 0 }`);
      layout.push(`{ text ${W - 30} ${H - 30} 1153 ${txIdx} }`);
      texts.push('OK');

      api.gumps.send(ctx.state, {
        gumpId: 0xB10B10C0, x: 100, y: 80,
        layout: layout.join(''), texts,
      }, (resp) => {
        const btnId = resp?.buttonId | 0;
        if (btnId === 0) return;
        // Snapshot baseline before any override.
        if (vendor._originalHue == null) vendor._originalHue = vendor.hue ?? 0;
        let pickedHue = null;
        if (btnId === 200) {
          // Wave 32: revert to `_baselineHue` if a Freeze snapshot
          // exists; otherwise fall back to `_originalHue` (pre-tier
          // body color). Drop the override either way.
          delete vendor._customTitleHue;
          vendor.hue = vendor._baselineHue ?? vendor._originalHue ?? 0;
          ctx.state.sendSystemMessage(
            vendor._baselineHue != null
              ? `Reverted to baseline 0x${vendor._baselineHue.toString(16).toUpperCase()}.`
              : `Cleared title hue on ${vendor.name}.`,
          );
        } else if (btnId === 201) {
          // Wave 32: Freeze — snapshot current hue.
          vendor._baselineHue = vendor.hue ?? 0;
          ctx.state.sendSystemMessage(
            `Baseline frozen at 0x${vendor._baselineHue.toString(16).toUpperCase()}.`,
          );
          // No broadcast needed — color hasn't changed.
          return;
        } else if (btnId >= 250 && btnId < 250 + recentHues.length) {
          // Wave 30: recently-used quick-pick.
          pickedHue = recentHues[btnId - 250];
          vendor._customTitleHue = pickedHue;
          vendor.hue = pickedHue;
          ctx.state.sendSystemMessage(
            `Set ${vendor.name} hue → 0x${pickedHue.toString(16).toUpperCase()} (recent).`,
          );
        } else if (btnId >= 280 && btnId < 280 + favHues.length) {
          // Wave 31: per-vendor favorite quick-pick.
          pickedHue = favHues[btnId - 280];
          vendor._customTitleHue = pickedHue;
          vendor.hue = pickedHue;
          ctx.state.sendSystemMessage(
            `Set ${vendor.name} hue → 0x${pickedHue.toString(16).toUpperCase()} (favorite).`,
          );
        } else if (btnId >= 100 && btnId < 100 + SWATCHES.length) {
          pickedHue = SWATCHES[btnId - 100];
          vendor._customTitleHue = pickedHue;
          vendor.hue = pickedHue;
          ctx.state.sendSystemMessage(`Set ${vendor.name} hue → 0x${pickedHue.toString(16).toUpperCase()}.`);
        } else {
          return;
        }
        // Wave 30: record the pick into the GM's recently-used list
        // (FIFO cap 4, dedup). Skip Clear (no hue picked).
        // Wave 31: also stamp into the per-vendor `_favoriteHues`
        // ring so this vendor's quick-pick row stays curated.
        if (pickedHue != null) {
          mob._lastVendorHues = Array.isArray(mob._lastVendorHues) ? mob._lastVendorHues : [];
          mob._lastVendorHues = mob._lastVendorHues.filter((h) => h !== pickedHue);
          mob._lastVendorHues.push(pickedHue);
          if (mob._lastVendorHues.length > 4) mob._lastVendorHues.shift();

          vendor._favoriteHues = Array.isArray(vendor._favoriteHues) ? vendor._favoriteHues : [];
          vendor._favoriteHues = vendor._favoriteHues.filter((h) => h !== pickedHue);
          vendor._favoriteHues.push(pickedHue);
          if (vendor._favoriteHues.length > 4) vendor._favoriteHues.shift();
        }
        // Broadcast the hue change like vendor.js refreshVendorTitle does.
        if (api.protocol?.mobileIncoming) {
          const pkt = api.protocol.mobileIncoming({
            serial: vendor.serial, body: vendor.body,
            x: vendor.x, y: vendor.y, z: vendor.z,
            direction: vendor.direction, hue: vendor.hue,
            flags: vendor.flags, notoriety: 1,
          });
          for (const m of allMobiles({ world })) {
            if (!m.client || m.map !== vendor.map) continue;
            if (Math.abs(m.x - vendor.x) > 18 || Math.abs(m.y - vendor.y) > 18) continue;
            m.client.send(pkt);
          }
        }
      });
    },
  });

  return () => commands.unregister('vendorhue');
}
