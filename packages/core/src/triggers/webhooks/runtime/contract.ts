import type { CORE_WEBHOOK_CONFIG_SCHEMA } from '@pertexo/workflow-model';

import type { EventCoordinationReceipt } from '@pertexo/workflow-model';

import type { WebhookAuthentication } from '@pertexo/contracts';

import type { InitialCheckpointFactory } from '../../../runs/commands/initial-checkpoint.js';
import type { z } from 'zod';

import type { WorkflowTriggerHealth } from '../../reconciliation/contract.js';

export type SealedWebhookTriggerSecret = Readonly<{
  id: string;
  kmsKeyReference: string;
  encryptedDataKey: string;
  ciphertext: string;
  nonce: string;
  authTag: string;
}>;

/** Opens only with the trigger id it was sealed under, which outlives later publishes. */
export type StoredWebhookTriggerSecret = SealedWebhookTriggerSecret &
  Readonly<{ triggerId: string }>;

export type Command = Readonly<{
  workspaceId: string;
  workflowId: string;
  actorId: string;
  triggerId: string;
  idempotencyKey: string;
  requestHash: string;
}>;

export type WebhookConfig = z.output<typeof CORE_WEBHOOK_CONFIG_SCHEMA>;

export type WebhookVerificationReference = Readonly<{
  endpointId: string;
  endpointKeyHash: string;
  workspaceId: string;
  triggerId: string;
  workflowId: string;
  workflowVersionId: string;
  nodeId: string;
  databaseTime: Date;
  authentication: WebhookAuthentication;
  runInputMode?: WebhookConfig['runInput'];
  currentSecret: StoredWebhookTriggerSecret;
  previousSecret?: StoredWebhookTriggerSecret & Readonly<{ validUntil: Date }>;
}>;

export type AcceptVerifiedWebhookDeliveryInput = Readonly<{
  verification: WebhookVerificationReference;
  verifiedSecretVersionId: string;
  requestFingerprint: string;
  idempotencyKeyHash?: string;
  bodyBytes: number;
  runInput: unknown;
  checkpointFactory: InitialCheckpointFactory;
  traceparent?: string;
  signal?: AbortSignal;
}>;

export type WebhookCommandResult = Readonly<{
  trigger: WorkflowTriggerHealth;
  replayed: boolean;
}>;

export type ConfigureWebhookAuthenticationInput = Command &
  Readonly<{
    authentication: WebhookAuthentication;
    endpointKeyHash: string;
    secret: SealedWebhookTriggerSecret;
  }>;

export type ProvisionWebhookInput = Command &
  Readonly<{
    endpointId: string;
    endpointKeyHash: string;
    secret: SealedWebhookTriggerSecret;
  }>;

export type RotateWebhookEndpointInput = Command &
  Readonly<{ endpointKeyHash: string }>;

export type RotateWebhookSecretInput = Command &
  Readonly<{ endpointKeyHash: string; secret: SealedWebhookTriggerSecret }>;

export type ReadWebhookHealthInput = Readonly<{
  workspaceId: string;
  actorId: string;
  workflowId: string;
}>;

export type WebhookAcceptance =
  | Readonly<{
      runId: string;
      replayed: boolean;
      responseWaitSeconds?: number;
    }>
  | Readonly<{ skipped: true; reason: 'concurrency_limit' }>
  | EventCoordinationReceipt;
