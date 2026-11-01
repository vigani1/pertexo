import { randomBytes, createHash } from 'node:crypto';
import { generatePersistedId } from '@pertexo/database/platform';
import type {
  WebhookTestEventStore,
  TestEventScope,
} from '@pertexo/core/triggers';

import {
  webhookTestEventStartedSchema,
  webhookTestEventSnapshotSchema,
  type WebhookAuthentication,
} from '@pertexo/contracts';
import type { WebhookTriggerEnvelopeEncryption } from '@pertexo/integrations/server';

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
    const key = randomBytes(32).toString('base64url');
    const secret = randomBytes(32);
    const signingSecret = secret.toString('base64url');
    try {
      const sealed = await this.encryption.seal(
        secret,
        { workspaceId: input.workspaceId, triggerId: id, secretVersionId: id },
        input.signal ?? AbortSignal.timeout(30_000),
      );
      const result = await this.store.start({
        ...input,
        id,
        endpointKeyHash: createHash('sha256').update(key).digest('hex'),
        secret: { ...sealed, id },
      });
      return webhookTestEventStartedSchema.parse({
        id,
        path: `/hooks/${key}/test`,
        ...result,
        authentication: input.authentication,
        ...(input.authentication.mode === 'secret_url'
          ? {}
          : { signingSecret }),
      });
    } finally {
      secret.fill(0);
    }
  }
  async get(input: TestEventScope & { id: string }) {
    return webhookTestEventSnapshotSchema.parse(await this.store.get(input));
  }
  stop(input: TestEventScope & { id: string }) {
    return this.store.stop(input);
  }
}
