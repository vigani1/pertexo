import type {
  NodeWebhookResponse,
  NodeWebhookResponseReceipt,
} from '@pertexo/node-sdk';

export type WebhookResponseScope = Readonly<{
  workspaceId: string;
  runId: string;
  signal?: AbortSignal;
}>;
export type WebhookResponseSnapshot =
  | Readonly<{ state: 'pending' | 'failed' | 'finished' }>
  | Readonly<{ state: 'responded'; response: NodeWebhookResponse }>;
export type WriteWebhookResponse = Readonly<{
  workspaceId: string;
  runId: string;
  nodeRunId: string;
  attemptId: string;
  attemptNumber: number;
  nodeId: string;
  invocationKey: string;
  workerId: string;
  fenceToken: number;
  response: NodeWebhookResponse;
  signal: AbortSignal;
}>;
export interface WebhookResponseStore {
  respond(input: WriteWebhookResponse): Promise<NodeWebhookResponseReceipt>;
  close(): Promise<void>;
}
