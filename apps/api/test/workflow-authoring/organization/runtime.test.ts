import { describe, expect, it, vi } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import type { WorkflowInputCaseDatabase } from '@pertexo/database/authoring';
import { createApiWorkflowMetadataRuntime } from '../../../src/platform/workflow/metadata-runtime.js';

// Construction/ownership tests use lazy real stores and never send a query.
const config = parseDatabaseConfig({
  connectionString:
    'postgresql://pertexo_app:unused@127.0.0.1:1/pertexo_test_f07_no_connection',
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
  it('composes the organization stores without querying', async () => {
    const runtime = await createApiWorkflowMetadataRuntime(
      config,
      testAuthoring,
    );
    try {
      expect(Object.keys(runtime.organization).sort()).toEqual([
        'batches',
        'favorites',
        'folders',
        'reader',
        'tags',
      ]);
      expect(runtime.inputCases).toBeUndefined();
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
  it('preserves an individual close failure', async () => {
    const cases = inputCases(),
      failure = new Error('owned close failure');
    cases.close.mockRejectedValue(failure);
    const runtime = await createApiWorkflowMetadataRuntime(config, {
      ...testAuthoring,
      inputCasePersistence: cases,
    });
    await expect(runtime.close()).rejects.toBe(failure);
  });
});
