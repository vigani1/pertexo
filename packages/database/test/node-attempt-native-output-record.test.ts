import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { recordNativeAttemptInlineOutput } from '../src/execution/node-attempts/node-attempt-native-output-record.js';
import { serializeStoredExecutionValueV1 } from '../src/execution/stored-execution-value.js';

const id = '00000000-0000-4000-8000-000000000101';
const lease = {
  runId: id,
  workflowVersionId: id,
  nodeRunId: id,
  attemptId: id,
  attemptNumber: 2,
  invocationKey: 'ordinary',
  nodeId: 'ordinary',
  workerId: 'worker',
  fenceToken: 3,
  delivery: { outboxEventId: id, payloadChecksum: 'a'.repeat(64) },
};

describe('native physical output byte ingress (mocked SQL)', () => {
  it('passes original first-write value bytes, checksum and actual lease/delivery', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const value = { text: 'é', number: 1.25 };
    const bytes = '{"number":1.25,"text":"é"}';
    const reference = serializeStoredExecutionValueV1({
      schemaVersion: 1,
      kind: 'inline',
      value,
    });
    await recordNativeAttemptInlineOutput(
      { query } as unknown as PoolClient,
      lease,
      value,
      reference,
    );
    const parameters = query.mock.calls[0]?.[1] as unknown[];
    expect(JSON.parse(parameters[0] as string)).toEqual(lease);
    expect(parameters.slice(1)).toEqual([
      reference,
      createHash('sha256').update(bytes).digest('hex'),
      Buffer.byteLength(bytes, 'utf8'),
      bytes,
    ]);
  });

  it('rejects invalid JSON before calling the protected writer', async () => {
    const query = vi.fn();
    await expect(
      recordNativeAttemptInlineOutput(
        { query } as unknown as PoolClient,
        lease,
        { number: Infinity },
        '{}',
      ),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('propagates protected writer denial without a fallback projection', async () => {
    const query = vi
      .fn()
      .mockRejectedValue(new Error('protected output denied'));
    await expect(
      recordNativeAttemptInlineOutput(
        { query } as unknown as PoolClient,
        lease,
        null,
        '{"kind":"inline","schemaVersion":1,"value":null}',
      ),
    ).rejects.toThrow('protected output denied');
    expect(query).toHaveBeenCalledOnce();
  });
});
