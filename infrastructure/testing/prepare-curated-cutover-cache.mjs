#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CURATED_PRE_ORIGIN_SOURCE,
  prepareCuratedCutoverCache,
} from './curated-cutover-artifact-build.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));

export async function prepareCuratedQualificationCache() {
  for (const key of ['PNPM_CONFIG_STORE_DIR', 'PNPM_CONFIG_CACHE_DIR'])
    if (!path.isAbsolute(process.env[key] ?? ''))
      throw new Error(`Cache preparation requires explicit absolute ${key}`);
  const current = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  const receipts = [];
  for (const [label, ref] of [
    ['pre-origin-cache', CURATED_PRE_ORIGIN_SOURCE],
    ['compatible-cache', current],
  ]) {
    const receipt = await prepareCuratedCutoverCache({
      repository,
      ref,
      label,
    });
    receipts.push(receipt);
    process.stdout.write(
      `Curated frozen cache prepared: ${JSON.stringify(receipt)}\n`,
    );
  }
  return receipts;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.length !== 2)
    throw new Error('usage: prepare-curated-cutover-cache.mjs');
  await prepareCuratedQualificationCache();
}
