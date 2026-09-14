import { createHash, randomBytes } from 'node:crypto';

import type {
  WebhookManagementCommandResponse,
  WebhookTriggerHealthResponse,
} from '@pertexo/contracts/webhooks';
import { webhookCredentialSchema } from '@pertexo/contracts/webhooks';
import {
  WebhookTriggerIdempotencyConflictError,
  WebhookTriggerNotFoundError,
  generatePersistedId,
  type WebhookTriggerDatabase,
  type WorkflowTriggerHealth,
} from '@pertexo/database/api';
import type { WebhookTriggerEnvelopeEncryption } from '@pertexo/integrations/server';

import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';

export type WebhookCommandInput = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  triggerId: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}>;

export type WebhookRotateSecretInput = WebhookCommandInput &
  Readonly<{ endpointKey: string }>;

export type WebhookManagementServiceOptions = Readonly<{
  generateMaterial?: () => Buffer;
  generateId?: () => string;
}>;

export class WebhookManagementService {
  private readonly generateMaterial: () => Buffer;
  private readonly generateId: () => string;

  public constructor(
    private readonly database: WebhookTriggerDatabase,
    private readonly encryption: WebhookTriggerEnvelopeEncryption,
    options: WebhookManagementServiceOptions = {},
  ) {
    this.generateMaterial = options.generateMaterial ?? (() => randomBytes(32));
    this.generateId = options.generateId ?? generatePersistedId;
  }

  public async list(
    input: Readonly<{
      workspaceId: string;
      actorId: string;
      workflowId: string;
    }>,
  ): Promise<Readonly<{ items: readonly WebhookTriggerHealthResponse[] }>> {
    try {
      const health = await this.database.getHealth(input);
      return {
        items: health
          .filter(({ kind }) => kind === 'webhook')
          .map(publicHealth),
      };
    } catch (error: unknown) {
      return mapManagementError(error);
    }
  }

  public provision(
    input: WebhookCommandInput,
  ): Promise<WebhookManagementCommandResponse> {
    return this.mapCommandErrors(() => this.provisionWebhook(input));
  }

  public rotateEndpoint(
    input: WebhookCommandInput,
  ): Promise<WebhookManagementCommandResponse> {
    return this.mapCommandErrors(() => this.rotateWebhookEndpoint(input));
  }

  public rotateSecret(
    input: WebhookRotateSecretInput,
  ): Promise<WebhookManagementCommandResponse> {
    const endpointKey = webhookCredentialSchema.parse(input.endpointKey);
    return this.mapCommandErrors(() =>
      this.rotateWebhookSecret(input, endpointKey),
    );
  }

  private async provisionWebhook(
    input: WebhookCommandInput,
  ): Promise<WebhookManagementCommandResponse> {
    const signal = commandSignal(input);
    let endpointBytes: Buffer | undefined;
    let secretBytes: Buffer | undefined;
    try {
      signal.throwIfAborted();
      endpointBytes = this.generateMaterial();
      const endpointKey = endpointBytes.toString('base64url');
      const endpointKeyHash = sha256(endpointKey);
      secretBytes = this.generateMaterial();
      const signingSecret = secretBytes.toString('base64url');
      const secretVersionId = this.generateId();
      const secret = {
        id: secretVersionId,
        ...(await this.encryption.seal(
          secretBytes,
          secretContext(input, secretVersionId),
          signal,
        )),
      };
      signal.throwIfAborted();
      const trigger = await this.database.provision({
        ...commandBase('provision', input),
        endpointId: this.generateId(),
        endpointKeyHash,
        secret,
      });
      const resolved = await this.database.resolveVerification(endpointKeyHash);
      const original = resolved?.triggerId === input.triggerId;
      return original
        ? {
            trigger: publicHealth(trigger),
            replayed: false,
            endpointKey,
            signingSecret,
          }
        : { trigger: publicHealth(trigger), replayed: true };
    } finally {
      endpointBytes?.fill(0);
      secretBytes?.fill(0);
    }
  }

  private async rotateWebhookEndpoint(
    input: WebhookCommandInput,
  ): Promise<WebhookManagementCommandResponse> {
    const signal = commandSignal(input);
    let endpointBytes: Buffer | undefined;
    try {
      signal.throwIfAborted();
      endpointBytes = this.generateMaterial();
      const endpointKey = endpointBytes.toString('base64url');
      const endpointKeyHash = sha256(endpointKey);
      signal.throwIfAborted();
      const trigger = await this.database.rotateEndpoint({
        ...commandBase('rotateEndpoint', input),
        endpointKeyHash,
      });
      const resolved = await this.database.resolveVerification(endpointKeyHash);
      const original = resolved?.triggerId === input.triggerId;
      return original
        ? {
            trigger: publicHealth(trigger),
            replayed: false,
            endpointKey,
          }
        : { trigger: publicHealth(trigger), replayed: true };
    } finally {
      endpointBytes?.fill(0);
    }
  }

  private async rotateWebhookSecret(
    input: WebhookRotateSecretInput,
    endpointKey: string,
  ): Promise<WebhookManagementCommandResponse> {
    const signal = commandSignal(input);
    const endpointKeyHash = sha256(endpointKey);
    let secretBytes: Buffer | undefined;
    try {
      signal.throwIfAborted();
      secretBytes = this.generateMaterial();
      const signingSecret = secretBytes.toString('base64url');
      const secretVersionId = this.generateId();
      const secret = {
        id: secretVersionId,
        ...(await this.encryption.seal(
          secretBytes,
          secretContext(input, secretVersionId),
          signal,
        )),
      };
      signal.throwIfAborted();
      const trigger = await this.database.rotateSecret({
        ...commandBase('rotateSecret', input, endpointKeyHash),
        endpointKeyHash,
        secret,
      });
      const resolved = await this.database.resolveVerification(endpointKeyHash);
      const original = resolved?.currentSecret.id === secretVersionId;
      return original
        ? {
            trigger: publicHealth(trigger),
            replayed: false,
            signingSecret,
          }
        : { trigger: publicHealth(trigger), replayed: true };
    } finally {
      secretBytes?.fill(0);
    }
  }

  private async mapCommandErrors<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error: unknown) {
      return mapManagementError(error);
    }
  }
}

type Operation = 'provision' | 'rotateEndpoint' | 'rotateSecret';

function commandSignal(input: WebhookCommandInput): AbortSignal {
  return input.signal ?? AbortSignal.timeout(30_000);
}

function commandBase(
  operation: Operation,
  input: WebhookCommandInput,
  endpointKeyHash = '',
) {
  return {
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    actorId: input.actorId,
    triggerId: input.triggerId,
    idempotencyKey: input.idempotencyKey,
    requestHash: sha256(
      `${operation}\0${input.workspaceId}\0${input.workflowId}\0${input.triggerId}\0${endpointKeyHash}`,
    ),
  };
}

function secretContext(input: WebhookCommandInput, secretVersionId: string) {
  return {
    workspaceId: input.workspaceId,
    triggerId: input.triggerId,
    secretVersionId,
  };
}

function mapManagementError(error: unknown): never {
  if (error instanceof WebhookTriggerNotFoundError)
    return throwApplicationError(applicationError('resource.not_found'));
  if (error instanceof WebhookTriggerIdempotencyConflictError)
    return throwApplicationError(
      applicationError('request.idempotency_conflict', {
        safeDetail: 'The idempotency key was already used for another request.',
      }),
    );
  throw error;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function publicHealth(
  trigger: WorkflowTriggerHealth,
): WebhookTriggerHealthResponse {
  if (trigger.kind !== 'webhook')
    throw new Error('Webhook health projection received another trigger kind');
  return {
    id: trigger.id,
    workflowId: trigger.workflowId,
    workflowVersionId: trigger.workflowVersionId,
    nodeId: trigger.nodeId,
    kind: trigger.kind,
    status: trigger.status,
    healthStatus: trigger.healthStatus,
    lastErrorCode: trigger.lastErrorCode,
    endpointReady: trigger.endpointReady,
    reconciledAt: trigger.reconciledAt?.toISOString() ?? null,
  };
}
