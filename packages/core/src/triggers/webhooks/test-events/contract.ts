import type { WebhookAuthentication } from '@pertexo/contracts';
import type {
  WebhookVerificationReference,
  SealedWebhookTriggerSecret,
} from '../runtime/contract.js';

export type TestEventScope = Readonly<{
  workspaceId: string;
  workflowId: string;
  nodeId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
export type TestEventReference = Omit<
  WebhookVerificationReference,
  'workflowVersionId'
>;
export type TestEventSnapshot = Readonly<{
  state: 'waiting' | 'captured' | 'expired' | 'changed';
  expiresAt: string | null;
  output: unknown;
}>;
export type StartTestEventInput = TestEventScope &
  Readonly<{
    id: string;
    endpointKeyHash: string;
    expectedDraftRevision: number;
    authentication: WebhookAuthentication;
    secret: SealedWebhookTriggerSecret;
  }>;
export type TestEventListenerInput = TestEventScope & Readonly<{ id: string }>;
