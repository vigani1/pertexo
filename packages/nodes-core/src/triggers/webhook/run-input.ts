import type { z } from 'zod';

import type { CORE_WEBHOOK_CONFIG_SCHEMA } from './validation.js';

/** One authenticated webhook call with its body already parsed. */
export type WebhookRequest = Readonly<{
  method: 'GET' | 'POST';
  body: unknown;
  query: Readonly<Record<string, string | readonly string[]>>;
  headers: Readonly<Record<string, string>>;
}>;

type WebhookRunInputMode = z.output<
  typeof CORE_WEBHOOK_CONFIG_SCHEMA
>['runInput'];

/**
 * By default the run gets the data the caller sent: a POST's body or a GET's
 * query, as Zapier and Make do. "request" adds what n8n shows.
 */
export function webhookRunInput(
  mode: WebhookRunInputMode,
  request: WebhookRequest,
): unknown {
  if (mode === 'request')
    return {
      method: request.method,
      body: request.body,
      query: request.query,
      headers: request.headers,
    };
  return request.method === 'GET' ? request.query : request.body;
}
