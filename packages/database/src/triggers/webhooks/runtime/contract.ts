import type { CORE_WEBHOOK_CONFIG_SCHEMA } from '@pertexo/workflow-model';

import type { EventCoordinationReceipt } from '@pertexo/workflow-model';

import type { WebhookAuthentication } from '@pertexo/contracts';

import type {
  WebhookResponseScope,
  WebhookResponseSnapshot,
} from '../responses/contract.js';
import type { InitialCheckpointFactory } from '../../../runs/commands/initial-checkpoint.js';

import { z } from 'zod';

import type { WorkflowTriggerHealth } from '../../reconciliation/repository.js';

import type { WebhookDeliveryLog } from '../deliveries.repository.js';

export const uuidSchema = z.uuid();

export const sealedSchema = z
  .object({
    id: z.uuid(),
    kmsKeyReference: z.string().min(1).max(2048),
    encryptedDataKey: z.string().min(1),
    ciphertext: z.string().min(1),
    nonce: z.string().min(1).max(64),
    authTag: z.string().min(1).max(64),
  })
  .strict();

export type SealedWebhookTriggerSecret = Readonly<z.input<typeof sealedSchema>>;

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
  currentSecret: SealedWebhookTriggerSecret;
  previousSecret?: SealedWebhookTriggerSecret & Readonly<{ validUntil: Date }>;
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

export interface WebhookTriggerDatabase extends WebhookDeliveryLog {
  readResponse(input: WebhookResponseScope): Promise<WebhookResponseSnapshot>;
  configureAuthentication(
    input: Command &
      Readonly<{
        authentication: WebhookAuthentication;
        endpointKeyHash: string;
        secret: SealedWebhookTriggerSecret;
      }>,
  ): Promise<
    Readonly<{
      trigger: WorkflowTriggerHealth;
      replayed: boolean;
      rotated: boolean;
    }>
  >;
  provision(
    input: Command &
      Readonly<{
        endpointId: string;
        endpointKeyHash: string;
        secret: SealedWebhookTriggerSecret;
      }>,
  ): Promise<WorkflowTriggerHealth>;
  rotateEndpoint(
    input: Command & Readonly<{ endpointKeyHash: string }>,
  ): Promise<WorkflowTriggerHealth>;
  rotateSecret(
    input: Command &
      Readonly<{
        endpointKeyHash: string;
        secret: SealedWebhookTriggerSecret;
      }>,
  ): Promise<WorkflowTriggerHealth>;
  getHealth(
    input: Readonly<{
      workspaceId: string;
      actorId: string;
      workflowId: string;
    }>,
  ): Promise<readonly WorkflowTriggerHealth[]>;
  resolveVerification(
    endpointKeyHash: string,
  ): Promise<WebhookVerificationReference | null>;
  consumeIngressLimit(endpointKeyHash: string): Promise<void>;
  acceptVerifiedDelivery(input: AcceptVerifiedWebhookDeliveryInput): Promise<
    | Readonly<{
        runId: string;
        replayed: boolean;
        responseWaitSeconds?: number;
      }>
    | Readonly<{ skipped: true; reason: 'concurrency_limit' }>
    | EventCoordinationReceipt
  >;
  close(): Promise<void>;
}
