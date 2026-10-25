import {
  workflowPublishResponseSchema,
  workflowValidateResponseSchema,
} from '@pertexo/contracts';
import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { csrfHeaders } from '../../../test/support/browser/csrf';
export async function saveGraph(page: Page, path: string, graph: unknown) {
  const response = await page.request.get(`${path}/draft`);
  const saved = await page.request.put(`${path}/draft`, {
    headers: {
      ...(await csrfHeaders(page)),
      'If-Match': response.headers().etag ?? '',
    },
    data: { graph },
  });
  expect(saved.status()).toBe(200);
}

export async function publishGraph(page: Page, path: string) {
  const checked = await page.request.post(`${path}/validate`, {
    headers: await csrfHeaders(page),
    data: {},
  });
  expect(checked.status()).toBe(200);
  expect(workflowValidateResponseSchema.parse(await checked.json()).valid).toBe(
    true,
  );
  const published = await page.request.post(`${path}/publish`, {
    headers: {
      ...(await csrfHeaders(page)),
      'If-Match': checked.headers().etag ?? '',
      'Idempotency-Key': randomUUID(),
    },
    data: {},
  });
  expect(published.status()).toBe(200);
  return workflowPublishResponseSchema.parse(await published.json()).version;
}
