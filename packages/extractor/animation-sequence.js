// AnimationSequence.uop maps the logical action groups requested by the
// client to the physical groups stored in AnimationFrame*.uop.  Modern UO
// bodies frequently keep walk/idle/combat frames under different group ids;
// ignoring this file makes the extractor miss those frames entirely.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openUop, readEntryContent } from './uop.js';

export const MAX_UOP_ACTIONS = 80;
const REPLACEMENT_RECORD_BYTES = 72; // oldGroup + frameCount + newGroup + 60 bytes

/**
 * Decode one AnimationSequence entry.
 *
 * The returned action table starts as an identity map. Records whose
 * frameCount is zero replace a logical group with the physical UOP group.
 * Counts 48 and 68 are sentinels used by the original data and do not carry
 * the regular replacement table (matching ClassicUO's loader behaviour).
 *
 * @param {Buffer} buffer
 * @returns {{ body:number, actions:number[] } | null}
 */
export function decodeAnimationSequenceEntry(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 56) return null;

  const body = buffer.readUInt32LE(0);
  const replacementCount = buffer.readInt32LE(52);
  if (body > 0xFFFF || replacementCount < 0 || replacementCount > 4096) return null;

  const actions = Array.from({ length: MAX_UOP_ACTIONS }, (_v, i) => i);
  if (replacementCount === 48 || replacementCount === 68) {
    return { body, actions };
  }

  let pos = 56;
  for (let i = 0; i < replacementCount; i++) {
    if (pos + REPLACEMENT_RECORD_BYTES > buffer.length) return null;
    const oldGroup = buffer.readInt32LE(pos);
    const frameCount = buffer.readUInt32LE(pos + 4);
    const newGroup = buffer.readInt32LE(pos + 8);
    if (
      frameCount === 0
      && oldGroup >= 0 && oldGroup < MAX_UOP_ACTIONS
      && newGroup >= 0 && newGroup < MAX_UOP_ACTIONS
    ) {
      actions[oldGroup] = newGroup;
    }
    pos += REPLACEMENT_RECORD_BYTES;
  }

  return { body, actions };
}

/** Load every usable mapping from AnimationSequence.uop. */
export async function loadAnimationSequence(srcDir) {
  const path = findSequencePath(srcDir);
  if (!path) return { available: false, mappings: new Map() };

  const mappings = new Map();
  let archive;
  try {
    archive = await openUop(path);
    for (const entry of archive.entries) {
      if (entry.compressedSize <= 0) continue;
      try {
        const decoded = decodeAnimationSequenceEntry(
          await readEntryContent(archive.fd, entry),
        );
        if (decoded) mappings.set(decoded.body, decoded.actions);
      } catch (error) {
        console.warn(`[animation-sequence] skipped entry: ${error.message}`);
      }
    }
  } catch (error) {
    console.warn(`[animation-sequence] failed to open ${path}: ${error.message}`);
    return { available: false, mappings };
  } finally {
    await archive?.fd?.close().catch(() => {});
  }

  return { available: true, mappings };
}

/** Resolve a logical group while remaining compatible with old data sets. */
export function resolveUopAction(mappings, body, action) {
  const requested = action | 0;
  const mapped = mappings?.get(body | 0)?.[requested];
  return Number.isInteger(mapped) ? mapped : requested;
}

function findSequencePath(srcDir) {
  for (const name of ['AnimationSequence.uop', 'animationsequence.uop']) {
    const path = join(srcDir, name);
    if (existsSync(path)) return path;
  }
  return null;
}
