import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import type { WorkflowInputCaseDatabase } from '@pertexo/database/api';
import { createApiWorkflowMetadataRuntime } from '../../src/platform/workflow/workflow-metadata-runtime.js';

// Construction/ownership tests use lazy real stores and never send a query.
const config = parseDatabaseConfig({
  connectionString:
    'postgresql://pertexo_api:unused@127.0.0.1:1/pertexo_test_f07_no_connection',
  max: 1,
});
const testAuthoring = {
  databaseFactory: () => {
    throw new Error('Unused explicit test authoring factory');
  },
};
function inputCases() {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    listCases: vi.fn(),
    getCase: vi.fn(),
    createCase: vi.fn(),
    updateCase: vi.fn(),
    deleteCase: vi.fn(),
  } satisfies WorkflowInputCaseDatabase;
}
describe('organization metadata runtime ownership', () => {
  it('leaves missing organization key unsupported and preserves explicitly opted-in test adapters', async () => {
    const runtime = await createApiWorkflowMetadataRuntime(
      config,
      testAuthoring,
    );
    expect(runtime.organization).toBeUndefined();
    expect(runtime.inputCases).toBeUndefined();
    await runtime.close();
  });
  it('composes real stores and distinct-purpose cryptographic capabilities without querying', async () => {
    const runtime = await createApiWorkflowMetadataRuntime(
      config,
      testAuthoring,
      { cursorSigningKey: Buffer.alloc(32, 29).toString('base64') },
    );
    try {
      const organization = runtime.organization;
      if (organization === undefined)
        throw new Error('Missing configured organization capability');
      expect(Object.keys(organization).sort()).toEqual([
        'cursors',
        'favorites',
        'reader',
        'tags',
      ]);
      const workspaceId = randomUUID(),
        actorId = randomUUID(),
        id = randomUUID();
      const wire = organization.cursors.pages.encode(
        { purpose: 'tags', workspaceId, actorId, selectedTagId: null },
        { id },
      );
      expect(
        organization.cursors.pages.decode(wire, {
          purpose: 'tags',
          workspaceId,
          actorId,
          selectedTagId: null,
        }),
      ).toEqual({ id });
      expect(() =>
        organization.cursors.workflows.decode(wire, {
          workspaceId,
          actorId,
          order: 'created_asc',
          filterHash: 'ab'.repeat(32),
        }),
      ).toThrow('workflow cursor is invalid');
    } finally {
      await runtime.close();
      await runtime.close();
    }
  });
  it('owns supplied input cases once and returns one shared close promise', async () => {
    const cases = inputCases();
    const runtime = await createApiWorkflowMetadataRuntime(config, {
      ...testAuthoring,
      inputCasePersistence: cases,
    });
    expect(runtime.inputCases).toBe(cases);
    const first = runtime.close(),
      second = runtime.close();
    expect(first).toBe(second);
    await first;
    expect(cases.close).toHaveBeenCalledTimes(1);
  });
  it('closes already acquired metadata on invalid configuration without leaking key material', async () => {
    const cases = inputCases(),
      key = 'private-invalid-key';
    await expect(
      createApiWorkflowMetadataRuntime(
        config,
        { ...testAuthoring, inputCasePersistence: cases },
        { cursorSigningKey: key },
      ),
    ).rejects.toThrow('Workflow organization configuration is invalid');
    expect(cases.close).toHaveBeenCalledTimes(1);
  });
  it('preserves an individual close failure and aggregates startup plus cleanup failure', async () => {
    const cases = inputCases(),
      failure = new Error('owned close failure');
    cases.close.mockRejectedValue(failure);
    const runtime = await createApiWorkflowMetadataRuntime(config, {
      ...testAuthoring,
      inputCasePersistence: cases,
    });
    await expect(runtime.close()).rejects.toBe(failure);
    await expect(
      createApiWorkflowMetadataRuntime(
        config,
        { ...testAuthoring, inputCasePersistence: cases },
        { cursorSigningKey: 'invalid' },
      ),
    ).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.any(Error), failure],
    });
  });
});
