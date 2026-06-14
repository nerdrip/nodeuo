import { loadBodyConfig } from './body-config.js';
const cfg = loadBodyConfig('D:/Games/Electronic Arts/Ultima Online Classic');
for (const id of [400, 431, 434, 449, 466, 469, 477]) {
  const t = cfg.mobTypes.get(id);
  const c = cfg.bodyConv.get(id);
  console.log('body', id, '(0x' + id.toString(16) + '):', 'type=' + (t?.type || '-'), 'conv=', c);
}
