// Full animation extractor — every (body, action, direction, frame).
//
// Mirrors ClassicUO.Assets/AnimationsLoader.cs (ReadMULAnimationFrames +
// ReadSpriteData), with body-conversion via bodyconv.def / body.def /
// mobtypes.txt for the body → file lookup.
//
// We extract a focused subset of action ids — the ones a player actually
// sees most of the time — so the manifest stays manageable. Missing
// actions fall back to action 0 client-side.
//
// Output:
//   mobiles-atlas-NN.png   atlas pages, RGBA, ARGB1555 → ARGB8888
//   mobiles-atlas.json     {
//                             pageCount, atlasW, atlasH,
//                             aliases: { bodyId: { body, hue } },
//                             bodies: {
//                               <bodyId>: {
//                                 actions: {
//                                   <action>: {
//                                     dirs: {
//                                       <dir>: [
//                                         { page, u, v, w, h, cx, cy }, ...
//                                       ]
//                                     }
//                                   }
//                                 }
//                               }
//                             }
//                          }

import { open } from 'node:fs/promises';
import { writeFile } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { loadBodyConfig, resolveIdxIndex, pickAnimFile } from './body-config.js';
import { loadAnimUopFiles } from './anim-uop.js';
import {
  MAX_UOP_ACTIONS,
  loadAnimationSequence,
  resolveUopAction,
} from './animation-sequence.js';

const ATLAS_W = 4096;
const ATLAS_H = 4096;
// Body range — covers monsters/animals/humans (0..400) plus the
// equipment-animation range (~400..1024) plus 1024..2048 for misc.
// Equipment items default to `animBody = itemId` when there's no
// Equipconv override; we have to pull frames for those too.
const MAX_BODY = 2048;
// Action set — per-body-type the meaning of these IDs differs (CUO
// `AnimationsLoader.PeopleAnimationGroup` / `HighAnimationGroup` /
// `LowAnimationGroup`). We extract a SUPERSET so the client can pick
// the right one based on body type.
//
//  PeopleAnimationGroup (humans, anim5.mul):
//   0 WalkUnarmed   1 WalkArmed   2 RunUnarmed   3 RunArmed
//   4 Stand         5 Fidget1     6 Fidget2      7 StandOnehandedAttack
//   8 StandTwohandedAttack    9 AttackOnehanded   10 AttackUnarmed1
//   11 AttackUnarmed2  12-14 AttackTwohanded*    15 WalkWarmode
//   16 CastDirected   17 CastArea     18 AttackBow   19 AttackCrossbow
//   20 GetHit        21 Die1         22 Die2
//  HighAnimationGroup (monsters):
//   0 Walk    1 Stand    2 Die1    3 Die2    4-6 Attack1..3
//   12 Cast   13-16 GetHit / Misc   17-18 Fidget1..2
//  LowAnimationGroup (animals):
//   0 Walk    1 Run     2 Stand    5 Attack1    8 Die1    9-10 Fidget
//
// Earlier the extractor pulled [0,1,2,3,6,8,21,22] which had NO Stand
// pose for humans (group 4). Without it the client played group 2
// (RunUnarmed) as "Idle" — the avatar looked like it was perpetually
// running in place. The legacy range now continues through 34 so mounted
// movement/combat is also present; UOP bodies expose their full 0..79 range.
// Legacy People animations continue through group 34 (mounted movement and
// combat included). UOP bodies can address as many as 80 logical groups.
// The old 0..22 limit silently omitted every mounted animation and all
// high-numbered SA groups used for modern creature walk/run/idle states.
const LEGACY_ACTIONS = Array.from({ length: 35 }, (_v, i) => i);
const UOP_ACTIONS = Array.from({ length: MAX_UOP_ACTIONS }, (_v, i) => i);
const DIRECTIONS = 5;
const USE_UOP_ANIMATION = 0x10000;

export async function extractAnim(srcDir, outDir) {
  const cfg = loadBodyConfig(srcDir);
  console.log(`[anim]    bodyConv=${cfg.bodyConv.size}  alias=${cfg.bodyAlias.size}  mobTypes=${cfg.mobTypes.size}`);

  // Open all five anim files we have.
  const handles = [];
  for (const i of [1, 2, 3, 4, 5]) {
    const mulName = i === 1 ? 'anim.mul'  : `anim${i}.mul`;
    const idxName = i === 1 ? 'anim.idx'  : `anim${i}.idx`;
    try {
      const mulFd = await open(join(srcDir, mulName), 'r');
      const idxFd = await open(join(srcDir, idxName), 'r');
      const idxStat = await idxFd.stat();
      const idxBuf = Buffer.alloc(idxStat.size);
      await idxFd.read(idxBuf, 0, idxStat.size, 0);
      handles.push({ mulFd, idxBuf });
      await idxFd.close();
    } catch {
      handles.push(null);
    }
  }

  /** @type {{ pixels: Uint8Array, w: number, h: number, cx: number, cy: number, body: number, action: number, dir: number, frame: number }[]} */
  const sprites = [];
  let bodiesSeen = 0;
  let entriesScanned = 0;

  // Body set = mob bodies (0..MAX_BODY) ∪ animBody values from Equipconv.def
  // ∪ corpse bodies. Equipment animations live at high body ids (typically
  // 0x4000+) so we have to scan past 1024 for those.
  const bodySet = new Set();
  for (let i = 0; i < MAX_BODY; i++) bodySet.add(i);
  for (const m of cfg.equipConv.values()) {
    for (const v of m.values()) {
      if (v.animBody > 0) bodySet.add(v.animBody);
    }
  }
  for (const v of cfg.corpseConv.values()) {
    if (v.corpseBody > 0) bodySet.add(v.corpseBody);
  }
  // Sort numerically for deterministic atlas layout.
  const bodyList = [...bodySet].sort((a, b) => a - b);

  // Open AnimationFrame*.uop containers — Stygian Abyss + every
  // post-AOS body redraw lives here, the matching MUL idx slot is
  // either zeroed or reduced to a 1×1 placeholder. UOP fallback
  // closes the gap.
  const uop = await loadAnimUopFiles(srcDir);
  console.log(`[anim]    UOP fallback ${uop.available ? 'enabled' : 'disabled (no AnimationFrame*.uop in src)'}`);
  const sequence = await loadAnimationSequence(srcDir);
  console.log(`[anim]    AnimationSequence ${sequence.available ? `enabled (${sequence.mappings.size} bodies)` : 'disabled'}`);
  let uopHits = 0;
  let uopRemaps = 0;
  const actionAliasesByBody = new Map();

  const equipmentBodies = new Set();
  for (const conversions of cfg.equipConv.values()) {
    for (const value of conversions.values()) {
      if (value.animBody > 0) equipmentBodies.add(value.animBody);
    }
  }

  for (const body of bodyList) {
    let touched = false;
    const mobType = cfg.mobTypes.get(body);
    const useUop = uop.available && ((mobType?.flags ?? 0) & USE_UOP_ANIMATION) !== 0;
    const equipment = mobType?.type === 'EQUIPMENT' || equipmentBodies.has(body);
    const actionAliases = {};

    if (useUop) {
      // Group every logical action by the physical UOP group it resolves to.
      // Extract each physical group once and retain lightweight aliases in
      // the manifest instead of duplicating identical sprites in the atlas.
      const plans = new Map();
      for (const requestedAction of UOP_ACTIONS) {
        const physicalAction = resolveUopAction(sequence.mappings, body, requestedAction);
        let requested = plans.get(physicalAction);
        if (!requested) plans.set(physicalAction, requested = []);
        requested.push(requestedAction);
      }
      for (const [physicalAction, requestedActions] of plans) {
        let actionTouched = false;
        for (let dir = 0; dir < DIRECTIONS; dir++) {
          const frames = await uop.read(body, physicalAction, dir, { equipment });
          if (!frames?.length) continue;
          actionTouched = true;
          uopHits++;
          for (let f = 0; f < frames.length; f++) {
            const fr = frames[f];
            if (!fr || fr.w <= 0 || fr.h <= 0) continue;
            sprites.push({ ...fr, body, action: physicalAction, dir, frame: f });
          }
        }
        if (!actionTouched) continue;
        touched = true;
        for (const requestedAction of requestedActions) {
          if (requestedAction === physicalAction) continue;
          actionAliases[requestedAction] = physicalAction;
          uopRemaps++;
        }
      }
    } else for (const action of LEGACY_ACTIONS) {
      /** @type {({ pixels:Uint8Array,w:number,h:number,cx:number,cy:number }[] | null)[]} */
      const mulFrames = new Array(DIRECTIONS).fill(null);
      for (let dir = 0; dir < DIRECTIONS; dir++) {
        const fileIndex = pickAnimFile(body, cfg.bodyConv, cfg.mobTypes);
        const fh = handles[fileIndex];
        let frames = null;
        if (fh) {
          const idxIndex = resolveIdxIndex(body, fileIndex, action, dir, cfg.bodyConv, cfg.mobTypes);
          if (idxIndex >= 0) {
            const off = idxIndex * 12;
            if (off >= 0 && off + 12 <= fh.idxBuf.length) {
              const pos  = fh.idxBuf.readUInt32LE(off);
              const size = fh.idxBuf.readInt32LE (off + 4);
              if (pos !== 0xFFFFFFFF && size > 0) {
                entriesScanned++;
                const buf = Buffer.alloc(size);
                await fh.mulFd.read(buf, 0, size, pos);
                frames = decodeFrames(buf);
                mulFrames[dir] = frames;
              }
            }
          }
        }
      }

      // Reject placeholder actions as a unit. Mixing valid MUL directions
      // with remapped UOP directions under one alias produces direction-
      // dependent action ids and broken mirroring.
      const isStub = mulFrames.some((frames) => !frames || !frames.length
        || frames.every((f) => !f || (f.w < 16 && f.h < 16)));
      let outputAction = action;
      let selectedFrames = mulFrames;
      if (isStub && uop.available) {
        const physicalAction = resolveUopAction(sequence.mappings, body, action);
        const uopFrames = await Promise.all(
          Array.from({ length: DIRECTIONS }, (_v, dir) => (
            uop.read(body, physicalAction, dir, { equipment })
          )),
        );
        if (uopFrames.some((frames) => frames?.length)) {
          selectedFrames = uopFrames;
          outputAction = physicalAction;
          uopHits += uopFrames.filter((frames) => frames?.length).length;
          if (physicalAction !== action) {
            actionAliases[action] = physicalAction;
            uopRemaps++;
          }
        }
      }

      for (let dir = 0; dir < DIRECTIONS; dir++) {
        const frames = selectedFrames[dir];
        if (!frames || !frames.length) continue;
        touched = true;
        for (let f = 0; f < frames.length; f++) {
          const fr = frames[f];
          if (!fr || fr.w <= 0 || fr.h <= 0) continue;
          sprites.push({ ...fr, body, action: outputAction, dir, frame: f });
        }
      }
    }
    if (Object.keys(actionAliases).length) {
      // `registerFrame` creates the body entry later during atlas packing.
      // Keep the aliases temporarily; they are attached after packing.
      actionAliasesByBody.set(body, actionAliases);
    }
    if (touched) bodiesSeen++;
  }
  for (const fh of handles) if (fh) await fh.mulFd.close();
  await uop.close();
  console.log(`[anim]    bodiesSeen=${bodiesSeen} entries=${entriesScanned} sprites=${sprites.length} uopHits=${uopHits} uopRemaps=${uopRemaps}`);

  // ---------------- shelf-pack into atlas pages ----------------
  // Keep every body's frames adjacent, then sort by height within the body.
  // The previous global height sort spread one human across as many as 59
  // 4096² pages; a single walk cycle could therefore stream gigabytes of
  // decoded GPU textures. Body-local packing trades a little empty atlas
  // space for stable, bounded runtime page residency.
  sprites.sort(compareAnimationPackingOrder);
  const pages = [];
  /** @type {Record<number, any>} */
  const bodies = {};
  let packingBody = -1;
  let bodyPageIndices = [];
  for (const sp of sprites) {
    if (sp.body !== packingBody) {
      packingBody = sp.body;
      // Let a new body reuse only the most recent page. If it spills, all
      // additional pages are dedicated to that same body until it is done.
      bodyPageIndices = pages.length ? [pages.length - 1] : [];
    }
    let placed = false;
    for (const pi of bodyPageIndices) {
      const p = pages[pi];
      const shelf = p.shelf;
      if (shelf.x + sp.w <= ATLAS_W && sp.h <= shelf.rowH) {
        blit(p.buf, ATLAS_W, sp.pixels, sp.w, sp.h, shelf.x, shelf.y);
        registerFrame(bodies, sp, pi, shelf.x, shelf.y);
        shelf.x += sp.w;
        placed = true; break;
      }
      const newY = shelf.y + shelf.rowH;
      if (newY + sp.h <= ATLAS_H && sp.w <= ATLAS_W) {
        p.shelf = { x: sp.w, y: newY, rowH: sp.h };
        blit(p.buf, ATLAS_W, sp.pixels, sp.w, sp.h, 0, newY);
        registerFrame(bodies, sp, pi, 0, newY);
        placed = true; break;
      }
    }
    if (!placed) {
      const buf = Buffer.alloc(ATLAS_W * ATLAS_H * 4);
      blit(buf, ATLAS_W, sp.pixels, sp.w, sp.h, 0, 0);
      registerFrame(bodies, sp, pages.length, 0, 0);
      pages.push({ buf, shelf: { x: sp.w, y: 0, rowH: sp.h } });
      bodyPageIndices.push(pages.length - 1);
    }
  }

  for (const [body, actionAliases] of actionAliasesByBody) {
    if (bodies[body]) bodies[body].actionAliases = actionAliases;
  }

  for (let i = 0; i < pages.length; i++) {
    await sharp(pages[i].buf, { raw: { width: ATLAS_W, height: ATLAS_H, channels: 4 } })
      .png({ compressionLevel: 9 })
      .toFile(join(outDir, `mobiles-atlas-${i.toString().padStart(2, '0')}.png`));
  }

  /** @type {Record<number,{body:number,hue:number}>} */
  const aliases = {};
  for (const [k, v] of cfg.bodyAlias) aliases[k] = v;

  /** @type {Record<number, Record<number, {animBody:number,gump:number,hue:number}>>} */
  const equipConv = {};
  for (const [bodyType, m] of cfg.equipConv) {
    const inner = {};
    for (const [itemID, v] of m) inner[itemID] = v;
    equipConv[bodyType] = inner;
  }

  /** @type {Record<number,{corpseBody:number,corpseHue:number}>} */
  const corpseConv = {};
  for (const [k, v] of cfg.corpseConv) corpseConv[k] = v;

  /** @type {Record<number,{type:string,flags:number}>} */
  const mobTypes = {};
  for (const [body, value] of cfg.mobTypes) mobTypes[body] = value;

  await writeFilePromise(join(outDir, 'mobiles-atlas.json'), JSON.stringify({
    schemaVersion: 2,
    pageCount: pages.length, atlasW: ATLAS_W, atlasH: ATLAS_H,
    actions: LEGACY_ACTIONS, uopActions: UOP_ACTIONS, directions: DIRECTIONS,
    aliases, equipConv, corpseConv, mobTypes, bodies,
  }));

  return { count: bodiesSeen, sprites: sprites.length, pages: pages.length };
}

export function compareAnimationPackingOrder(a, b) {
  return (a.body - b.body)
    || (b.h - a.h)
    || (a.action - b.action)
    || (a.dir - b.dir)
    || (a.frame - b.frame);
}

function registerFrame(bodies, sp, page, u, v) {
  const b = bodies[sp.body] ??= { actions: {} };
  const a = b.actions[sp.action] ??= { dirs: {} };
  const d = a.dirs[sp.dir] ??= [];
  d[sp.frame] = { page, u, v, w: sp.w, h: sp.h, cx: sp.cx, cy: sp.cy };
}

/** Decode every frame of an anim.mul entry. */
function decodeFrames(buf) {
  if (buf.length < 512 + 4) return null;
  // 256-entry u16 ARGB1555 palette.
  const palette = new Array(256);
  for (let i = 0; i < 256; i++) palette[i] = buf.readUInt16LE(i * 2);
  const dataStart = 512;
  const frameCount = buf.readUInt32LE(dataStart);
  if (frameCount <= 0 || frameCount > 200) return null;
  const offsets = new Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    offsets[i] = buf.readUInt32LE(dataStart + 4 + i * 4);
  }
  const out = new Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let p = dataStart + offsets[f];
    if (p + 8 > buf.length) continue;
    const cx = buf.readInt16LE(p); p += 2;
    const cy = buf.readInt16LE(p); p += 2;
    const w  = buf.readInt16LE(p); p += 2;
    const h  = buf.readInt16LE(p); p += 2;
    if (w <= 0 || h <= 0 || w > 1024 || h > 1024) continue;
    const pixels = new Uint8Array(w * h * 4);
    while (p + 4 <= buf.length) {
      const header = buf.readUInt32LE(p); p += 4;
      if (header === 0x7FFF7FFF) break;
      const runLength = header & 0xFFF;
      let x = (header >> 22) & 0x3FF;
      if (x & 0x200) x = x - 0x400;
      let y = (header >> 12) & 0x3FF;
      if (y & 0x200) y = y - 0x400;
      x += cx;
      y += cy + h;
      for (let i = 0; i < runLength; i++) {
        if (p + 1 > buf.length) break;
        const idx = buf.readUInt8(p); p++;
        const c = palette[idx];
        const px = x + i;
        if (px < 0 || px >= w || y < 0 || y >= h) continue;
        if (c === 0) continue;
        const r5 = (c >> 10) & 0x1f, g5 = (c >> 5) & 0x1f, b5 = c & 0x1f;
        const o = (y * w + px) * 4;
        pixels[o + 0] = (r5 << 3) | (r5 >> 2);
        pixels[o + 1] = (g5 << 3) | (g5 >> 2);
        pixels[o + 2] = (b5 << 3) | (b5 >> 2);
        pixels[o + 3] = 255;
      }
    }
    out[f] = { pixels, w, h, cx, cy };
  }
  return out;
}

function blit(dst, dstW, src, srcW, srcH, dstX, dstY) {
  for (let y = 0; y < srcH; y++) {
    const so = y * srcW * 4;
    const dox = ((dstY + y) * dstW + dstX) * 4;
    dst.set(src.subarray(so, so + srcW * 4), dox);
  }
}

function writeFilePromise(p, data) {
  return new Promise((resolve, reject) => {
    writeFile(p, data, (err) => err ? reject(err) : resolve());
  });
}
