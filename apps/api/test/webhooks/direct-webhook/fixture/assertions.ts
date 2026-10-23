import { expect } from 'vitest';

import type { BoundedWebhookResponse } from '../../support/bounded-client.js';

export type HttpResponse = BoundedWebhookResponse;

export function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected secret material');
  return value;
}

export function expectProblem(
  response: HttpResponse,
  status: number,
  code: string,
): void {
  expect(response.status).toBe(status);
  expect(response.json).toMatchObject({ status, code });
}
