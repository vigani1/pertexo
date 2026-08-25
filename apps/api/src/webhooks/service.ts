import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  WebhookTriggerIdempotencyConflictError,
  WebhookTriggerNotFoundError,
  type WebhookTriggerDatabase,
  type WorkflowTriggerHealth,
} from '@pertexo/database';
import type { WebhookTriggerEnvelopeEncryption } from '@pertexo/integrations/server';
import { applicationError } from '../platform/http/index.js';

export class WebhookManagementService {
  public constructor(
    private readonly database: WebhookTriggerDatabase,
    private readonly encryption: WebhookTriggerEnvelopeEncryption,
  ) {}

  public async list(
    input: Readonly<{
      workspaceId: string;
      actorId: string;
      workflowId: string;
    }>,
  ) {
    try {
      const health = await this.database.getHealth(input);
      return {
        items: health
          .filter(({ kind }) => kind === 'webhook')
          .map(publicHealth),
      };
    } catch (error) {
      if (error instanceof WebhookTriggerNotFoundError)
        return throwManagementError(applicationError('resource.not_found'));
      throw error;
    }
  }

  public provision(input: CommandInput) {
    return this.command('provision', input);
  }

  public rotateEndpoint(input: CommandInput) {
    return this.command('rotateEndpoint', input);
  }

  public rotateSecret(input: CommandInput) {
    return this.command('rotateSecret', input);
  }

  private async command(operation: Operation, input: CommandInput) {
    const endpointBytes =
      operation === 'rotateSecret' ? undefined : randomBytes(32);
    const secretBytes =
      operation === 'rotateEndpoint' ? undefined : randomBytes(32);
    const endpointKey = endpointBytes?.toString('base64url');
    const signingSecret = secretBytes?.toString('base64url');
    const endpointHash =
      endpointKey === undefined
        ? input.endpointKey === undefined
          ? undefined
          : sha256(input.endpointKey)
        : sha256(endpointKey);
    const secretVersionId =
      secretBytes === undefined ? undefined : randomUUID();
    try {
      const base = {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        triggerId: input.triggerId,
        idempotencyKey: input.idempotencyKey,
        requestHash: sha256(
          `${operation}\0${input.workspaceId}\0${input.triggerId}\0${
            operation === 'rotateSecret' ? (endpointHash ?? '') : ''
          }`,
        ),
      };
      const secret =
        secretBytes === undefined || secretVersionId === undefined
          ? undefined
          : {
              id: secretVersionId,
              ...(await this.encryption.seal(secretBytes, {
                workspaceId: input.workspaceId,
                triggerId: input.triggerId,
                secretVersionId,
              })),
            };
      let trigger: WorkflowTriggerHealth;
      if (operation === 'provision') {
        if (endpointHash === undefined || secret === undefined)
          throw new Error('Webhook provision material is unavailable');
        trigger = await this.database.provision({
          ...base,
          endpointId: randomUUID(),
          endpointKeyHash: endpointHash,
          secret,
        });
      } else if (operation === 'rotateEndpoint') {
        if (endpointHash === undefined)
          throw new Error('Webhook endpoint rotation material is unavailable');
        trigger = await this.database.rotateEndpoint({
          ...base,
          endpointKeyHash: endpointHash,
        });
      } else {
        if (secret === undefined)
          throw new Error('Webhook secret rotation material is unavailable');
        trigger = await this.database.rotateSecret({
          ...base,
          endpointKeyHash:
            endpointHash ??
            (() => {
              throw new Error('Webhook endpoint authentication is unavailable');
            })(),
          secret,
        });
      }
      const resolved = await this.database.resolveVerification(endpointHash);
      const original =
        operation === 'rotateSecret'
          ? resolved?.currentSecret.id === secretVersionId
          : resolved?.triggerId === input.triggerId;
      return {
        trigger: publicHealth(trigger),
        replayed: !original,
        ...(original && endpointKey !== undefined ? { endpointKey } : {}),
        ...(original && signingSecret !== undefined ? { signingSecret } : {}),
      };
    } catch (error) {
      if (error instanceof WebhookTriggerNotFoundError)
        return throwManagementError(applicationError('resource.not_found'));
      if (error instanceof WebhookTriggerIdempotencyConflictError)
        return throwManagementError(
          applicationError('request.idempotency_conflict', {
            safeDetail:
              'The idempotency key was already used for another request.',
          }),
        );
      throw error;
    } finally {
      endpointBytes?.fill(0);
      secretBytes?.fill(0);
    }
  }
}

type Operation = 'provision' | 'rotateEndpoint' | 'rotateSecret';
type CommandInput = Readonly<{
  workspaceId: string;
  actorId: string;
  triggerId: string;
  idempotencyKey: string;
  endpointKey?: string;
}>;

function throwManagementError(
  error: ReturnType<typeof applicationError>,
): never {
  // The global problem filter consumes the frozen application error value.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw error;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function publicHealth(trigger: WorkflowTriggerHealth) {
  return {
    ...trigger,
    reconciledAt: trigger.reconciledAt?.toISOString() ?? null,
  };
}
