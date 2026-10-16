export const WEBHOOK_RESPONSE_MAX_BYTES = 1_048_576;
export const WEBHOOK_RESPONSE_HEADER_NAMES = [
  'content-language',
  'retry-after',
  'x-request-id',
  'x-correlation-id',
] as const;

/** Already validated and serialized by the Respond to webhook step. */
export type NodeWebhookResponse = Readonly<{
  statusCode: number;
  contentType: 'application/json' | 'text/plain';
  headers: Readonly<
    Partial<Record<(typeof WEBHOOK_RESPONSE_HEADER_NAMES)[number], string>>
  >;
  body: string;
}>;
export type NodeWebhookResponseReceipt = Readonly<{
  outcome: 'responded' | 'already_responded' | 'not_waiting' | 'preview';
  statusCode: number | null;
}>;
export interface NodeWebhookResponseRuntime {
  respond(
    input: Readonly<{
      response: NodeWebhookResponse;
      signal: AbortSignal;
    }>,
  ): Promise<NodeWebhookResponseReceipt>;
}
