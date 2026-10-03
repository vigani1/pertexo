import { describe, expect, it, vi } from 'vitest';
import { readWorkflowRunCallFamily } from '../src/execution/runs/workflow-run-call-family.js';
import {
  parseWorkspaceId,
  type WorkspaceTransaction,
} from '../src/tenant-access/workspace.js';

const id = '00000000-0000-4000-8000-000000000101';
const family = {
  rootRunId: id,
  parentRunId: null,
  parentInvocationKey: null,
  children: [],
};
function fixture(native: boolean | undefined, value: unknown = family) {
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ rows: native === undefined ? [] : [{ native }] })
    .mockResolvedValueOnce({ rows: [{ family: value }] });
  const transaction = {
    workspaceId: parseWorkspaceId(id),
    db: { execute },
  } as unknown as WorkspaceTransaction;
  return { execute, transaction };
}
describe('existing run detail native family read', () => {
  it.each([false, undefined])(
    'does not call unregistered native SQL for retained or missing checkpoint %s',
    async (native) => {
      const f = fixture(native);
      await expect(
        readWorkflowRunCallFamily(f.transaction, id),
      ).resolves.toBeUndefined();
      expect(f.execute).toHaveBeenCalledTimes(1);
    },
  );
  it('decodes an accepted bounded native family from the existing read snapshot', async () => {
    const f = fixture(true);
    await expect(readWorkflowRunCallFamily(f.transaction, id)).resolves.toEqual(
      family,
    );
    expect(f.execute).toHaveBeenCalledTimes(2);
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
      const f = fixture(true, value);
      await expect(
        readWorkflowRunCallFamily(f.transaction, id),
      ).rejects.toThrow();
    },
  );
});
