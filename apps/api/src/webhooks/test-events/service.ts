import { randomBytes, createHash } from 'node:crypto';
import { generatePersistedId } from '@pertexo/database/platform';
import {
  WebhookTestEventError,
  type WebhookTestEventStore,
  type TestEventScope,
} from '@pertexo/database/triggers';
import { WorkflowNotFoundError } from '@pertexo/database/authoring';
import {
  webhookTestEventStartedSchema,
  webhookTestEventSnapshotSchema,
  type WebhookAuthentication,
} from '@pertexo/contracts';
import type { WebhookTriggerEnvelopeEncryption } from '@pertexo/integrations/server';
import {
  applicationError,
  throwApplicationError,
} from '../../platform/http/index.js';

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
      const result = await this.map(() =>
        this.store.start({
          ...input,
          id,
          endpointKeyHash: createHash('sha256').update(key).digest('hex'),
          secret: { ...sealed, id },
        }),
      );
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
    return webhookTestEventSnapshotSchema.parse(
      await this.map(() => this.store.get(input)),
    );
  }
  stop(input: TestEventScope & { id: string }) {
    return this.map(() => this.store.stop(input));
  }
  private async map<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof WorkflowNotFoundError)
        return throwApplicationError(applicationError('resource.not_found'));
      if (error instanceof WebhookTestEventError)
        return throwApplicationError(
          applicationError('workspace.conflict', {
            safeDetail:
              error.reason === 'limit_reached'
                ? 'Ten webhook test listeners are already open in this workspace. Stop one or wait for it to expire.'
                : error.reason === 'changed'
                  ? 'Save the current draft and listen again.'
                  : 'This saved step is no longer an available webhook trigger.',
          }),
        );
      throw error;
    }
  }
}
