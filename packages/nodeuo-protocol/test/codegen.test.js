import { describe, expect, it } from 'vitest';
import {
  buildNodeUOConformanceFixtures,
  generateNodeUOTypeDefinitions,
  NODEUO_FEATURE_CATALOG,
  NODEUO_SCHEMA_VERSION,
} from '../src/index.js';

describe('NodeUO schema-derived tooling', () => {
  it('generates declarations and valid conformance probes from one schema source', () => {
    const declarations = generateNodeUOTypeDefinitions();
    expect(declarations).toContain(`NODEUO_SCHEMA_VERSION: ${NODEUO_SCHEMA_VERSION}`);
    expect(declarations).toContain('"protocol.subscription-leases"');
    expect(declarations).toContain('"world.live-event-director"');
    const fixtures = buildNodeUOConformanceFixtures();
    expect(fixtures.schemaVersion).toBe(7);
    expect(fixtures.fixtures).toHaveLength(NODEUO_FEATURE_CATALOG.length);
    expect(fixtures.fixtures.every((fixture) => fixture.valid)).toBe(true);
    expect(fixtures.fingerprint).toMatch(/^fnv1a64:[0-9a-f]{16}$/u);
  });
});
