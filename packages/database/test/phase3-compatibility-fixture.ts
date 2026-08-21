import { readFileSync } from 'node:fs';

import type { CompatibilityReleaseExpectation } from '../src/compatibility-release.js';

const migration = readFileSync(
  new URL(
    '../migrations/0017_node_compatibility_releases.sql',
    import.meta.url,
  ),
  'utf8',
);
const catalogMatch = /\$catalog\$([\s\S]+?)\$catalog\$::jsonb/u.exec(migration);
if (catalogMatch?.[1] === undefined)
  throw new Error('Phase 3 compatibility catalog fixture is unavailable');

export const PHASE3_COMPATIBILITY_EXPECTATION = Object.freeze({
  epoch: 1,
  fingerprint:
    'node-compat:v1:sha256:cf21b2e644563beb8b031481e9d5182b361b4ae2d4abd1d7d86d7b3fe0299f59',
  catalogJson: JSON.stringify(JSON.parse(catalogMatch[1]) as unknown),
}) satisfies CompatibilityReleaseExpectation;
