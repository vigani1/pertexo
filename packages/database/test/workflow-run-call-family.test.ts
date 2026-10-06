import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { readWorkflowRunCallFamily } from '../src/execution/runs/workflow-run-call-family.js';
import {
  parseWorkspaceId,
  type WorkspaceTransaction,
} from '../src/tenant-access/workspace.js';

const id = '00000000-0000-4000-8000-000000000101';
const nativeVersion = { schema_version: 2, executable_schema_version: 3 };
const retainedV1 = { schema_version: 1, executable_schema_version: null };
const retainedV2 = { schema_version: 1, executable_schema_version: 2 };
const family = {
  rootRunId: id,
  parentRunId: null,
  parentInvocationKey: null,
  children: [],
};
function fixture(version: unknown = nativeVersion, value: unknown = family) {
  const execute = vi
    .fn<(query: SQL) => Promise<{ rows: unknown[] }>>()
    .mockResolvedValueOnce({ rows: [version] })
    .mockResolvedValueOnce({ rows: [{ family: value }] });
  const transaction = {
    workspaceId: parseWorkspaceId(id),
    db: { execute },
  } as unknown as WorkspaceTransaction;
  return { execute, transaction };
}
describe('existing run detail native family read', () => {
  it.each([
    [2, 2],
    [1, 3],
  ])(
    'rejects an impossible version pair %s/%s before family SQL',
    async (schemaVersion, executableSchemaVersion) => {
      const execute = vi.fn((query: SQL) => {
        const statement = new PgDialect().sqlToQuery(query);
        return Promise.resolve({
          rows: statement.sql.includes('as native')
            ? [{ native: false }]
            : [
                {
                  schema_version: schemaVersion,
                  executable_schema_version: executableSchemaVersion,
                },
              ],
        });
      });
      const transaction = {
        workspaceId: parseWorkspaceId(id),
        db: { execute },
      } as unknown as WorkspaceTransaction;
      await expect(
        readWorkflowRunCallFamily(transaction, id),
      ).rejects.toThrow();
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );
  it('preserves summary lineage after native checkpoint detail expires', async () => {
    const dialect = new PgDialect();
    const execute = vi.fn((query: SQL) => {
      const statement = dialect.sqlToQuery(query);
      if (statement.sql.includes('app.run_checkpoints'))
        return Promise.resolve({ rows: [] });
      if (statement.sql.includes('app.workflow_versions'))
        return Promise.resolve({ rows: [nativeVersion] });
      return Promise.resolve({ rows: [{ family }] });
    });
    const transaction = {
      workspaceId: parseWorkspaceId(id),
      db: { execute },
    } as unknown as WorkspaceTransaction;
    await expect(readWorkflowRunCallFamily(transaction, id)).resolves.toEqual(
      family,
    );
  });
  it.each([retainedV1, retainedV2])(
    'does not call unregistered native SQL for accepted retained format %j',
    async (version) => {
      const f = fixture(version);
      await expect(
        readWorkflowRunCallFamily(f.transaction, id),
      ).resolves.toBeUndefined();
      expect(f.execute).toHaveBeenCalledTimes(1);
    },
  );
  it('decodes an accepted bounded native family from the existing read snapshot', async () => {
    const f = fixture();
    await expect(readWorkflowRunCallFamily(f.transaction, id)).resolves.toEqual(
      family,
    );
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it('binds classification to the requested workspace, run and exact workflow version', async () => {
    const f = fixture();
    await readWorkflowRunCallFamily(f.transaction, id);
    const query = f.execute.mock.calls[0]?.[0];
    if (query === undefined)
      throw new Error('Expected version classification read');
    const statement = new PgDialect().sqlToQuery(query);
    expect(statement.params).toEqual([id, id]);
    expect(statement.sql).toContain('version.workspace_id=run.workspace_id');
    expect(statement.sql).toContain('version.workflow_id=run.workflow_id');
    expect(statement.sql).toContain('version.id=run.workflow_version_id');
    expect(statement.sql).toContain(
      'select version.schema_version,version.executable_schema_version',
    );
    expect(statement.sql).not.toContain('as native');
    expect(statement.sql).not.toContain('app.run_checkpoints');
  });
  it('rejects ambiguous native version classification without reading a family', async () => {
    const f = fixture();
    f.execute
      .mockReset()
      .mockResolvedValueOnce({ rows: [nativeVersion, nativeVersion] });
    await expect(readWorkflowRunCallFamily(f.transaction, id)).rejects.toThrow(
      'Native run version read is ambiguous',
    );
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it.each([
    null,
    undefined,
    {},
    { schema_version: null, executable_schema_version: null },
    { schema_version: 3, executable_schema_version: 3 },
    { schema_version: 1, executable_schema_version: 1 },
    { schema_version: 2, executable_schema_version: null },
    { schema_version: '2', executable_schema_version: 3 },
    { schema_version: 2, executable_schema_version: '3' },
    { schema_version: 2 },
    { ...nativeVersion, native: true },
  ])(
    'rejects unavailable or malformed pinned version metadata %s',
    async (version) => {
      const f = fixture();
      f.execute.mockReset().mockResolvedValueOnce({ rows: [version] });
      await expect(
        readWorkflowRunCallFamily(f.transaction, id),
      ).rejects.toThrow();
      expect(f.execute).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects a missing classification row before family SQL', async () => {
    const f = fixture();
    f.execute.mockReset().mockResolvedValueOnce({ rows: [] });
    await expect(readWorkflowRunCallFamily(f.transaction, id)).rejects.toThrow(
      'Native run version read missing',
    );
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('rejects a missing native family instead of fabricating an empty lineage', async () => {
    const f = fixture();
    f.execute
      .mockReset()
      .mockResolvedValueOnce({ rows: [nativeVersion] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(readWorkflowRunCallFamily(f.transaction, id)).rejects.toThrow(
      'Native run family read missing',
    );
  });
  it.each([
    { ...family, rootRunId: 'untrusted' },
    {
      ...family,
      children: Array.from({ length: 65 }, () => ({
        runId: id,
        nodeId: 'call',
        invocationKey: 'key',
        status: 'waiting',
      })),
    },
    {
      ...family,
      children: [
        { runId: id, nodeId: 'call', invocationKey: 'key', status: 'unknown' },
      ],
    },
    { ...family, input: { secret: 'not a link' } },
  ])(
    'rejects malformed, excessive or value-bearing family projection',
    async (value) => {
      const f = fixture(nativeVersion, value);
      await expect(
        readWorkflowRunCallFamily(f.transaction, id),
      ).rejects.toThrow();
    },
  );
});
