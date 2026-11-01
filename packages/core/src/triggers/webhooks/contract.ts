import type { CoordinatedEvent } from '@pertexo/contracts';
import type { HTTP_STATUS } from './delivery.js';
import type { REPLAY_CHECKS, SIGNATURE_CHECKS } from './input.js';

export type WebhookDeliveryOutcome = keyof typeof HTTP_STATUS;

export type WebhookSignatureCheck = (typeof SIGNATURE_CHECKS)[number];

export type WebhookReplayCheck = (typeof REPLAY_CHECKS)[number];

/** The resolved endpoint an attempt is attributed to. */
export type WebhookDeliveryEndpoint = Readonly<{
  workspaceId: string;
  endpointId: string;
}>;

export type RejectedWebhookDelivery = Readonly<{
  endpoint: WebhookDeliveryEndpoint;
  outcome: Exclude<
    WebhookDeliveryOutcome,
    'accepted' | 'replayed' | 'skipped' | 'coordinated'
  >;
  signatureCheck: WebhookSignatureCheck;
  replayCheck: WebhookReplayCheck;
  bodyBytes: number;
}>;

// Projection formats timestamps and includes skip/coordination evidence.
export type WebhookDeliveryRecord = Readonly<{
  id: string;
  receivedAt: string;
  outcome: WebhookDeliveryOutcome;
  httpStatus: number;
  signatureCheck: WebhookSignatureCheck;
  replayCheck: WebhookReplayCheck;
  bodyBytes: number | null;
  runId: string | null;
  skipReason?: 'concurrency_limit';
  coordination?: CoordinatedEvent;
}>;

/** Newest-first keyset position: `(received_at desc, id asc)`. */
export type WebhookDeliveryPosition = Readonly<{
  receivedAt: string;
  id: string;
}>;

export type WebhookDeliveryPage = Readonly<{
  items: readonly WebhookDeliveryRecord[];
  nextCursor?: WebhookDeliveryPosition;
}>;

export type ListWebhookDeliveriesInput = Readonly<{
  workspaceId: string;
  actorId: string;
  workflowId: string;
  triggerId: string;
  limit?: number;
  after?: WebhookDeliveryPosition;
}>;

export interface WebhookDeliveryLog {
  listDeliveries(
    input: ListWebhookDeliveriesInput,
  ): Promise<WebhookDeliveryPage>;
  recordRejectedDelivery(input: RejectedWebhookDelivery): Promise<void>;
}

export type WebhookReplayIdentity = Readonly<{
  endpointId: string;
  dedupeKeyHash: string;
}>;
