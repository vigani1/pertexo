import type { webhookRunInput } from '@pertexo/nodes-core';

import type { createWebhookResponseWaiter } from '../responses/wait.js';

import type {
  WebhookTestEventStore,
  TestEventReference,
  WebhookTriggerStore,
  WebhookVerificationReference,
} from '@pertexo/core/triggers';
import type { InitialCheckpointFactory } from '@pertexo/core/runs';
import type { WebhookTriggerEnvelopeEncryption } from '@pertexo/integrations/server';
import type { StructuredLogger } from '@pertexo/observability';

import type { RejectedAttempt } from '../management/delivery-log.js';

import type { WebhookIngressTelemetry } from './telemetry.js';

export type WebhookIngressDependencies = Readonly<{
  database: WebhookTriggerStore;
  testEvents?: WebhookTestEventStore;
  encryption: WebhookTriggerEnvelopeEncryption;
  checkpointFactory: InitialCheckpointFactory;
  telemetry?: WebhookIngressTelemetry;
  /** This Fastify scope bypasses the Nest problem filter, which logs the rest. */
  logger: StructuredLogger;
}>;

export type WebhookMethod = 'GET' | 'POST';

export type WebhookAcceptanceOptions = Readonly<{
  method: WebhookMethod;
  dependencies: WebhookIngressDependencies;
  telemetry: WebhookIngressTelemetry;
  encryptionSignal: AbortSignal;
  responseWaiter: ReturnType<typeof createWebhookResponseWaiter>;
  testEvent: boolean;
}>;

export interface PreparedWebhookRequest {
  readonly requestId: string;
  readonly body: Uint8Array;
  readonly mediaType: string;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
  readonly endpointKey: string;
}

export interface IngressReferences {
  readonly productionReference: WebhookVerificationReference | null;
  readonly verification: TestEventReference;
}

export type IngressRejectionRecorder = (
  attempt: RejectedAttempt,
) => Promise<void>;

export type WebhookRequestData = Parameters<typeof webhookRunInput>[1];
