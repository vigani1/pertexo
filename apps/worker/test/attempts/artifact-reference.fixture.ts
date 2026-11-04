import { createHash } from 'node:crypto';

import { describe } from 'vitest';

const integration =
  process.env.ARTIFACT_STORE_INTEGRATION === 'true' &&
  process.env.WORKER_TRANSPORT_INTEGRATION === 'true';

export const describeIntegration = integration ? describe : describe.skip;

export function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export function sha256Base64(body: Buffer): string {
  return createHash('sha256').update(body).digest('base64');
}
