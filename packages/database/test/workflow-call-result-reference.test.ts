import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { readWorkflowCallResultReference } from '../src/execution/workflow-calls/workflow-call-result-reference.js';

const id = '00000000-0000-4000-8000-000000000101';
const input = {
  workspaceId: id,
  parentRunId: id,
  childRunId: id,
  invocationKey: 'call',
  consumer: {
    workspaceId: id,
    runId: id,
    workflowVersionId: id,
    expectedRevision: 0,
    delivery: { outboxEventId: id, payloadChecksum: 'a'.repeat(64) },
  },
};
function row(bytes = '{"name":"result"}', value: unknown = { name: 'result' }) {
  return {
    reference_json: JSON.stringify({ schemaVersion: 1, kind: 'inline', value }),
    serialized_value: bytes,
    byte_length: Buffer.byteLength(bytes),
    value_checksum: createHash('sha256').update(bytes).digest('hex'),
  };
}
function fixture(value: unknown) {
  const query = vi.fn().mockResolvedValue({ rows: [value] });
  return { query, client: { query } as unknown as PoolClient };
}
describe('protected child result snapshot adapter', () => {
  it('fails closed before reading bytes when a current consumer is absent or belongs to another parent', async () => {
    const f = fixture(row());
    const { consumer: _consumer, ...withoutConsumer } = input;
    await expect(
      readWorkflowCallResultReference(f.client, withoutConsumer),
    ).rejects.toThrow('consumer authority');
    await expect(
      readWorkflowCallResultReference(f.client, {
        ...input,
        consumer: {
          ...input.consumer,
          runId: '00000000-0000-4000-8000-000000000102',
        },
      }),
    ).rejects.toThrow('consumer scope');
    expect(f.query).not.toHaveBeenCalled();
  });

  it('carries the exact current consumer to the protected owner without inferring authority from result metadata', async () => {
    const f = fixture(row());
    await readWorkflowCallResultReference(f.client, input);
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('$4::jsonb'), [
      input.parentRunId,
      input.invocationKey,
      input.childRunId,
      JSON.stringify(input.consumer),
    ]);
  });

  it.each([
    ['{ "name": "result" }', { name: 'result' }],
    ['9007199254740993', 9007199254740992],
    ['1e-400', 0],
    ['-0', 0],
  ])(
    'uses the shared verifier for original %s bytes and preserves the first reference',
    async (bytes, value) => {
      const saved = row(bytes, value);
      const f = fixture(saved);
      await expect(
        readWorkflowCallResultReference(f.client, input),
      ).resolves.toBe(saved.reference_json);
      expect(f.query).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { value_checksum: 'f'.repeat(64) },
    { byte_length: 1 },
    { serialized_value: null },
    {
      reference_json: JSON.stringify({
        schemaVersion: 1,
        kind: 'inline',
        value: { name: 'forged' },
      }),
    },
  ])('rejects shared snapshot corruption %j', async (mutation) => {
    const f = fixture({ ...row(), ...mutation });
    await expect(
      readWorkflowCallResultReference(f.client, input),
    ).rejects.toThrow();
  });
  it('retains result-specific artifact availability checks', async () => {
    const saved = {
      ...row(),
      reference_json: JSON.stringify({
        schemaVersion: 1,
        kind: 'artifact',
        artifactId: id,
      }),
      serialized_value: null,
    };
    const f = fixture(saved);
    f.query
      .mockResolvedValueOnce({ rows: [saved] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      readWorkflowCallResultReference(f.client, input),
    ).rejects.toThrow('artifact is unavailable');
    expect(f.query).toHaveBeenCalledTimes(2);
  });
});
