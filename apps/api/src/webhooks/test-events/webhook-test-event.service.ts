import { randomBytes, createHash } from 'node:crypto';
import { generatePersistedId } from '@pertexo/database/platform';
import type {
  WebhookTestEventStore,
  TestEventScope,
} from '@pertexo/core/triggers';

import type { WebhookAuthentication } from '@pertexo/contracts';
import type { WebhookTriggerEnvelopeEncryption } from '@pertexo/secrets/server';
import {
  randomSecretToken,
  SECRET_TOKEN_BYTES,
} from '../../identity/secret-token.js';
import { WEBHOOK_COMMAND_TIMEOUT_MILLIS } from '../command-deadline.js';

export class WebhookTestEventService {
  constructor(
    private readonly store: WebhookTestEventStore,
    private readonly encryption: WebhookTriggerEnvelopeEncryption,
  ) {}
  async start(
    input: TestEventScope & {
      expectedDraftRevision: number;
      authentication: WebhookAuthentication;
    },
  ) {
    const id = generatePersistedId();
    const key = randomSecretToken();
    const secret = randomBytes(SECRET_TOKEN_BYTES);
    const signingSecret = secret.toString('base64url');
    try {
      const sealed = await this.encryption.seal(
        secret,
        { workspaceId: input.workspaceId, triggerId: id, secretVersionId: id },
        input.signal ?? AbortSignal.timeout(WEBHOOK_COMMAND_TIMEOUT_MILLIS),
      );
      const result = await this.store.start({
        ...input,
        id,
        endpointKeyHash: createHash('sha256').update(key).digest('hex'),
        secret: { ...sealed, id },
      });
      return {
        id,
        path: `/hooks/${key}/test`,
        ...result,
        authentication: input.authentication,
        ...(input.authentication.mode === 'secret_url'
          ? {}
          : { signingSecret }),
      };
    } finally {
      secret.fill(0);
    }
  }
  get(input: TestEventScope & { id: string }) {
    return this.store.get(input);
  }
  stop(input: TestEventScope & { id: string }) {
    return this.store.stop(input);
  }
}
