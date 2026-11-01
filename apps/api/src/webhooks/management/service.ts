import { createHash, randomBytes } from 'node:crypto';

import type {
  WebhookDeliveryListResponse,
  WebhookDeliveryResponse,
  WebhookManagementCommandResponse,
  WebhookTriggerHealthResponse,
  WebhookAuthentication,
} from '@pertexo/contracts';
import type {
  WebhookDeliveryRecord,
  WebhookTriggerDatabase,
  WorkflowTriggerHealth,
} from '@pertexo/core/triggers';
import { generatePersistedId } from '@pertexo/database/platform';
import type { WebhookTriggerEnvelopeEncryption } from '@pertexo/integrations/server';

import {
  decodeWebhookDeliveryCursor,
  encodeWebhookDeliveryCursor,
} from './cursor.js';

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

export type WebhookDeliveryListInput = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  triggerId: string;
  limit?: number;
  after?: string;
}>;

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
    const health = await this.database.getHealth(input);
    return {
      items: health.filter(({ kind }) => kind === 'webhook').map(publicHealth),
    };
  }

  /** ADR 045: one trigger's retained delivery metadata, newest first. */
  public async listDeliveries(
    input: WebhookDeliveryListInput,
  ): Promise<WebhookDeliveryListResponse> {
    const page = await this.database.listDeliveries({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      workflowId: input.workflowId,
      triggerId: input.triggerId,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined
        ? {}
        : {
            after: decodeWebhookDeliveryCursor(input.after, input.triggerId),
          }),
    });
    return {
      items: page.items.map(publicDelivery),
      nextCursor:
        page.nextCursor === undefined
          ? null
          : encodeWebhookDeliveryCursor(input.triggerId, page.nextCursor),
    };
  }

  public async configureAuthentication(
    input: WebhookCommandInput &
      Readonly<{ authentication: WebhookAuthentication }>,
  ): Promise<WebhookManagementCommandResponse> {
    const signal = commandSignal(input);
    const endpointBytes = this.generateMaterial();
    const secretBytes = this.generateMaterial();
    try {
      signal.throwIfAborted();
      const endpointKey = endpointBytes.toString('base64url');
      const signingSecret = secretBytes.toString('base64url');
      const id = this.generateId();
      const sealed = await this.encryption.seal(
        secretBytes,
        secretContext(input, id),
        signal,
      );
      signal.throwIfAborted();
      const result = await this.database.configureAuthentication({
        ...commandBase(
          'configureAuthentication',
          input,
          JSON.stringify(input.authentication),
        ),
        authentication: input.authentication,
        endpointKeyHash: sha256(endpointKey),
        secret: { id, ...sealed },
      });
      const trigger = publicHealth(result.trigger);
      if (result.replayed) return { trigger, replayed: true };
      return {
        trigger,
        replayed: false,
        ...(result.rotated
          ? {
              endpointKey,
              ...(input.authentication.mode === 'secret_url'
                ? {}
                : { signingSecret }),
            }
          : {}),
      };
    } finally {
      endpointBytes.fill(0);
      secretBytes.fill(0);
    }
  }

  public async provision(
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
      const result = await this.database.provision({
        ...commandBase('provision', input),
        endpointId: this.generateId(),
        endpointKeyHash,
        secret,
      });
      const trigger = publicHealth(result.trigger);
      return result.replayed
        ? { trigger, replayed: true }
        : { trigger, replayed: false, endpointKey, signingSecret };
    } finally {
      endpointBytes?.fill(0);
      secretBytes?.fill(0);
    }
  }

  public async rotateEndpoint(
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
      const result = await this.database.rotateEndpoint({
        ...commandBase('rotateEndpoint', input),
        endpointKeyHash,
      });
      const trigger = publicHealth(result.trigger);
      return result.replayed
        ? { trigger, replayed: true }
        : { trigger, replayed: false, endpointKey };
    } finally {
      endpointBytes?.fill(0);
    }
  }

  public async rotateSecret(
    input: WebhookRotateSecretInput,
  ): Promise<WebhookManagementCommandResponse> {
    const signal = commandSignal(input);
    const endpointKeyHash = sha256(input.endpointKey);
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
      const result = await this.database.rotateSecret({
        ...commandBase('rotateSecret', input, endpointKeyHash),
        endpointKeyHash,
        secret,
      });
      const trigger = publicHealth(result.trigger);
      return result.replayed
        ? { trigger, replayed: true }
        : { trigger, replayed: false, signingSecret };
    } finally {
      secretBytes?.fill(0);
    }
  }
}

type Operation =
  'provision' | 'rotateEndpoint' | 'rotateSecret' | 'configureAuthentication';

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
    authentication: trigger.authentication ?? {
      mode: 'signed',
      allowedOrigins: [],
    },
    reconciledAt: trigger.reconciledAt?.toISOString() ?? null,
  };
}

function publicDelivery(
  delivery: WebhookDeliveryRecord,
): WebhookDeliveryResponse {
  return {
    id: delivery.id,
    receivedAt: delivery.receivedAt,
    outcome: delivery.outcome,
    httpStatus: delivery.httpStatus,
    signatureCheck: delivery.signatureCheck,
    replayCheck: delivery.replayCheck,
    byteLength: delivery.bodyBytes,
    ...(delivery.coordination === undefined
      ? {}
      : { coordination: delivery.coordination }),
    runId: delivery.runId,
    ...(delivery.skipReason === undefined
      ? {}
      : { skipReason: delivery.skipReason }),
  };
}
