import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function requireCompatibleRelease(
  config,
  verifier = fileURLToPath(new URL('./verify.mjs', import.meta.url)),
) {
  if ('mode' in config && !existsSync(verifier))
    throw new Error(
      'Self-managed encryption requires a release with stored-key verification',
    );
}
