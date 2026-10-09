import { readFileSync } from 'node:fs';

import type { CompatibilityReleaseExpectation } from '../src/compatibility/compatibility-release.js';

const catalog: unknown = JSON.parse(
  readFileSync(
    new URL('./fixtures/baseline-compatibility-catalog.json', import.meta.url),
    'utf8',
  ),
);

/** The first node release, which every published workflow in tests pins. */
export const BASELINE_COMPATIBILITY_EXPECTATION = Object.freeze({
  epoch: 1,
  fingerprint:
    'node-compat:v1:sha256:cf21b2e644563beb8b031481e9d5182b361b4ae2d4abd1d7d86d7b3fe0299f59',
  catalogJson: JSON.stringify(catalog),
}) satisfies CompatibilityReleaseExpectation;
