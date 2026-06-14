import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveSaveDir } from '../src/save-dir.js';

describe('save directory resolution', () => {
  it('defaults to the repository-level saves directory', () => {
    const here = path.resolve('repo/apps/server/src');
    expect(resolveSaveDir({ env: {}, here })).toBe(path.resolve(here, '../../../saves'));
  });

  it('allows production save storage to be moved with UO_SAVE_DIR', () => {
    expect(resolveSaveDir({
      env: { UO_SAVE_DIR: 'runtime/saves' },
      here: path.resolve('repo/apps/server/src'),
    })).toBe(path.resolve('runtime/saves'));
  });
});
