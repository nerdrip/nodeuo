import path from 'node:path';
import { NODEUO_FEATURE_CATALOG } from '@uo/nodeuo-protocol';
import { ContentReleaseManager } from './content-release-manager.js';
import { FeatureRolloutController } from './feature-rollouts.js';
import { GlobalTrafficGovernor } from './global-traffic-governor.js';
import { NodeUOSettingsStore } from './nodeuo-settings.js';
import { protocolCosts } from './protocol-costs.js';

/** Build the shared, persistent NodeUO delivery control plane. */
export function createPerformanceDelivery({ saveDir, here, config }) {
  const nodeUOSettings = new NodeUOSettingsStore(path.join(saveDir, 'nodeuo-settings.json'), {
    theme: config.nodeUOTheme, localization: config.nodeUOLocalization,
    webTransportUrl: config.nodeUOWebTransportUrl,
  });
  const globalTrafficGovernor = new GlobalTrafficGovernor();
  const featureRollouts = new FeatureRolloutController(path.join(saveDir, 'nodeuo-rollouts.json'), {
    knownFeatures: NODEUO_FEATURE_CATALOG.map((entry) => entry.id),
  });
  const contentReleases = new ContentReleaseManager(path.join(saveDir, 'nodeuo-content-releases.json'),
    path.resolve(here, '..', '..', 'client', 'public', 'assets'));
  return { nodeUOSettings, protocolCosts, globalTrafficGovernor, featureRollouts, contentReleases };
}
