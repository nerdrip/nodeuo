import path from 'node:path';

export function resolveSaveDir({ env = process.env, here } = {}) {
  if (env.UO_SAVE_DIR) return path.resolve(env.UO_SAVE_DIR);
  if (!here) throw new Error('resolveSaveDir requires here when UO_SAVE_DIR is not set');
  return path.resolve(here, '../../../saves');
}
