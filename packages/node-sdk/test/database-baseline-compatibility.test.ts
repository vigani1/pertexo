import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  computeCompatibilityReleaseFingerprint,
  type RegistryReleaseInput,
} from '../src/release.js';

const migration = readFileSync(
  new URL(
    '../../database/migrations/0017_node_compatibility_releases.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('historical database compatibility identity', () => {
  it('matches the node-sdk canonical fingerprint producer', () => {
    const catalogMatch = /\$catalog\$([\s\S]+?)\$catalog\$::jsonb/u.exec(
      migration,
    );
    const fingerprintMatch = /node-compat:v1:sha256:[0-9a-f]{64}/u.exec(
      migration,
    );
    if (catalogMatch?.[1] === undefined || fingerprintMatch?.[0] === undefined)
      throw new Error('historical compatibility fixture is unavailable');
    const catalog = JSON.parse(catalogMatch[1]) as unknown as Pick<
      RegistryReleaseInput,
      'definitions' | 'executors' | 'policies'
    >;

    expect(
      computeCompatibilityReleaseFingerprint({
        epoch: 1,
        definitions: catalog.definitions,
        executors: catalog.executors,
        policies: catalog.policies,
      }),
    ).toBe(fingerprintMatch[0]);
  });
});
