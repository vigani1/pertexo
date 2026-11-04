import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createWorkflowExecutionReader } from '../../src/runs/queries/execution/source.repository.js';
import { isStoredDataError } from '../../src/shared/stored-values.js';

it('keeps a database connection refusal outside permanent frozen-data classification', async () => {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined)
    throw new Error('Missing test database URL');
  const url = new URL(connectionString);
  url.pathname = `/missing_reader_${randomUUID().replaceAll('-', '')}`;
  const reader = createWorkflowExecutionReader(
    parseDatabaseConfig({
      connectionString: url.toString(),
      max: 1,
      connectionTimeoutMillis: 1_000,
    }),
  );
  try {
    const error: unknown = await reader
      .readForExecution({
        workspaceId: randomUUID(),
        workflowVersionId: randomUUID(),
        nodeId: 'provider',
        signal: new AbortController().signal,
      })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(isStoredDataError(error)).toBe(false);
  } finally {
    await reader.close();
  }
});
