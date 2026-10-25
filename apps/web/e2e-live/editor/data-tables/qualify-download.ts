import { dataTableCreatedSchema } from '@pertexo/contracts';
import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readCsrfToken } from '../../../test/support/browser/csrf';

export async function qualifyLargeDownload(page: Page, workspaceId: string) {
  const cookie = await readCsrfToken(page, {
    missingMessage: 'Owned CSRF cookie missing',
  });
  const base = `/v1/workspaces/${workspaceId}/data-tables`;
  const headers = () => ({
    'x-csrf-token': cookie,
    'Idempotency-Key': randomUUID(),
  });
  const created = await page.request.post(base, {
    headers: headers(),
    data: {
      name: 'Large_download',
      columns: [
        { name: 'key', type: 'text', required: true },
        { name: 'note', type: 'text', required: false },
      ],
    },
  });
  expect(created.status()).toBe(200);
  const table = dataTableCreatedSchema.parse(await created.json());
  for (let batch = 0; batch < 2; batch += 1) {
    const imported = await page.request.post(`${base}/${table.id}/import`, {
      headers: headers(),
      data: {
        csv:
          'key,note\n' +
          Array.from(
            { length: 10 },
            (_, index) =>
              `${String(batch * 10 + index)},${'=formula'.padEnd(60000, 'x')}`,
          ).join('\n'),
      },
    });
    expect(imported.status()).toBe(200);
  }
  await page.goto(`/w/${workspaceId}/data-tables/${table.id}`);
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export all rows', exact: true })
    .click();
  const file = await download;
  expect(await file.failure()).toBeNull();
  const csv = await readFile(await file.path(), 'utf8');
  expect(Buffer.byteLength(csv)).toBeGreaterThan(1048576);
  expect(csv.trimEnd().split('\r\n')).toHaveLength(21);
  expect(csv).toContain('"\'=formula');
  const refused = await page.request.post(`${base}/${table.id}/export`, {
    form: { payload: '{"filters":[]}', csrfToken: 'incorrect' },
  });
  expect(refused.status()).toBe(403);
}
