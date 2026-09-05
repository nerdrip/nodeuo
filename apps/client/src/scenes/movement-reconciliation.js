import { world } from '../world/world.js';
import { recordMovementTrace } from '../managers/walker.js';

/** Apply an optional NodeUO movement result without racing the canonical UO
 * 0x21/0x22 packets or newer locally predicted inputs. */
export function reconcileNegotiatedMovement(scene, result = {}) {
  const sequence = Number(result.inputSequence) & 0xff;
  const position = result.position;
  if (result.accepted === false) {
    if (scene._pendingMoves.has(sequence) && position) scene._onMovementRej({
      sequence, x: position.x, y: position.y, z: position.z, direction: position.direction,
    });
    return;
  }
  if (result.accepted !== true || !scene._pendingMoves.has(sequence)) return;
  scene._onMovementAck({ sequence, notoriety: world.player?.notoriety ?? 0 });
  // A final authoritative position may repair drift; a newer prediction must
  // never be snapped backwards by a late side-channel response.
  if (scene._pendingMoves.size || !position || !world.player) return;
  const player = world.player;
  if (player.x === (position.x | 0) && player.y === (position.y | 0)
      && player.z === (position.z | 0) && player.map === (position.map | 0)) return;
  const oldX = player.x;
  const oldY = player.y;
  const oldMap = player.map;
  player.x = position.x | 0;
  player.y = position.y | 0;
  player.z = position.z | 0;
  player.map = position.map | 0;
  player.direction = position.direction & 7;
  player.offsetX = player.offsetY = player.offsetZ = 0;
  player.offsetEndAt = 0;
  world.reindexMobile?.(player, oldX, oldY, oldMap);
  recordMovementTrace('json-reconcile', {
    seq: sequence, reason: String(result.reason ?? ''),
  });
}
