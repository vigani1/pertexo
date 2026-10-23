import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';

import { useOrganizationOwnedApi } from '../support/owned-api.fixture.js';

export function createFoldersBulkFixture() {
  const { api, fixture } = useOrganizationOwnedApi('f07-folders-bulk');

  async function createFolder(
    f: Awaited<ReturnType<typeof fixture>>,
    name = 'Ops',
    parentId: string | null = null,
  ) {
    const response = await api.send('POST', `${f.route}/workflow-folders`, {
      browser: f.browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: { name, parentId },
    });
    expect(response.statusCode, response.payload).toBe(201);
    return response.json<{
      folder: { id: string; name: string; revision: number; depth: number };
    }>().folder;
  }
  return { fixture, createFolder, api };
}
