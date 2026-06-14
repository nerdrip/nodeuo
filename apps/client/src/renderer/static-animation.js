import { staticFlags } from '../shared/tiledata.js';
import { FLAG_ANIMATION } from '../shared/tiledata-flags.js';

/** True when this static graphic has both a valid animdata row and the
 *  TileFlag.Animation bit. The bit is 0x01000000 in ServUO / CUO; using
 *  StairBack (0x40000000) here disables every animated static in our
 *  extracted tiledata set. */
export function isAnimdataStaticGraphic(tiledata, animdata, graphicId) {
  const id = graphicId | 0;
  if (!animdata?.entries?.[id]) return false;
  return (staticFlags(tiledata, id) & FLAG_ANIMATION) !== 0;
}
