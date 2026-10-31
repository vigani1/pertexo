import { createHmac } from 'node:crypto';

import { currentSecret, timestamp, verification } from './environment.js';
import { acceptedInputs } from './acceptance.js';
import type { createIngressFixture } from './fixture.js';

export function createRequestShapeFixture(
  parent: Readonly<{ setup: ReturnType<typeof createIngressFixture>['setup'] }>,
) {
  const { setup } = parent;

  const open = () =>
    setup({
      reference: {
        ...verification,
        authentication: { mode: 'secret_url', allowedOrigins: [] },
      },
    });

  const accepted = (f: ReturnType<typeof setup>) => acceptedInputs(f.database);
  return { open, accepted, setup };
}

export function createDeliveryLogFixture(
  parent: Readonly<{ setup: ReturnType<typeof createIngressFixture>['setup'] }>,
) {
  const { setup } = parent;

  const endpoint = {
    workspaceId: verification.workspaceId,
    endpointId: verification.endpointId,
  };

  const stale = String(Number(timestamp) - 301);

  const staleSignature = `v1=${createHmac('sha256', currentSecret)
    .update(stale)
    .update('.')
    .update('{}')
    .digest('hex')}`;

  const mismatch = `v1=${'0'.repeat(64)}`;

  const verified = { signatureCheck: 'verified' } as const;
  return { stale, staleSignature, mismatch, verified, setup, endpoint };
}
