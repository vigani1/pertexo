import type { WebhookAuthentication } from '@pertexo/contracts';
import type {
  WebhookVerificationReference,
  SealedWebhookTriggerSecret,
} from '../repository.js';

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
export interface WebhookTestEventStore {
  start(
    input: TestEventScope &
      Readonly<{
        id: string;
        endpointKeyHash: string;
        expectedDraftRevision: number;
        authentication: WebhookAuthentication;
        secret: SealedWebhookTriggerSecret;
      }>,
  ): Promise<{ expiresAt: string }>;
  get(
    input: TestEventScope & Readonly<{ id: string }>,
  ): Promise<TestEventSnapshot>;
  stop(input: TestEventScope & Readonly<{ id: string }>): Promise<void>;
  resolve(endpointKeyHash: string): Promise<TestEventReference | null>;
  consume(reference: TestEventReference): Promise<void>;
  capture(reference: TestEventReference, runInput: unknown): Promise<boolean>;
  close(): Promise<void>;
}
export class WebhookTestEventError extends Error {
  override readonly name = 'WebhookTestEventError';
  constructor(
    readonly reason:
      'changed' | 'limit_reached' | 'unavailable' | 'value_invalid',
  ) {
    super(`webhook.test_${reason}`);
  }
}
