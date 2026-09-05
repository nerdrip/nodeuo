import path from 'node:path';
import { ContentDependencyGraph } from './content-dependency-graph.js';
import { EconomyTransactionLedger } from './economy/transaction-ledger.js';
import { WorldVerificationService } from './state-verification.js';
import { PlatformOperations } from './platform-operations.js';

/** Install low-overhead verification observers while keeping startup wiring out
 * of the server entry point. Full scans and graph rebuilds stay lazy. */
export function installVerificationSuite({ world, scheduler, saveDir, scriptsDir, assetsDir }) {
  const stateVerifier = new WorldVerificationService(world);
  const economyLedger = new EconomyTransactionLedger(path.join(saveDir, 'economy-ledger.ndjson'))
    .attach(world, scheduler);
  const contentDependencies = new ContentDependencyGraph({ scriptsDir, assetsDir });
  const platformOperations = new PlatformOperations({ saveDir, scriptsDir,
    emitEvent: (name, payload) => world.events?.emit?.(name, payload) });
  const interestDrainTimer = scheduler.every('world-interest-drain', 50, () => {
    world.interest?.consume?.(2048);
  });
  return Object.freeze({
    services: Object.freeze({ stateVerifier, economyLedger, contentDependencies, platformOperations }),
    interestDrainTimer,
    invalidateContent: (reason) => contentDependencies.invalidate(reason),
    close: () => { economyLedger.close(); platformOperations.close(); },
  });
}
