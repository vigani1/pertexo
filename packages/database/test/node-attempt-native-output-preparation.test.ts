import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { completionSchema } from '../src/execution/node-attempts/node-attempt-run-store-contract.js';
import { prepareNativeAttemptCompletionOutput } from '../src/execution/node-attempts/node-attempt-native-output-preparation.js';
import { completeNodeAttempt } from '../src/execution/node-attempts/node-attempt-run-store-completion.js';

const id = '00000000-0000-4000-8000-000000000101';
const value = 'x'.repeat(300_000);
const original = JSON.stringify(value);
const input = {
  lease: {
    workspaceId: id,
    runId: id,
    workflowVersionId: id,
    nodeRunId: id,
    attemptId: id,
    attemptNumber: 1,
    admissionKind: 'execute' as const,
    invocationKey: 'ordinary',
    nodeId: 'ordinary',
    workerId: 'worker',
    fenceToken: 1,
    sideEffectClass: 'safe' as const,
    leaseExpiresAt: new Date('2099-01-01'),
    delivery: { outboxEventId: id, payloadChecksum: 'a'.repeat(64) },
  },
  outcome: { status: 'succeeded' as const, output: value },
  nativeOutput: {
    reference: {
      schemaVersion: 1 as const,
      kind: 'artifact' as const,
      artifactId: id,
    },
    sha256: createHash('sha256').update(original).digest('hex'),
    byteLength: Buffer.byteLength(original),
  },
  signal: new AbortController().signal,
};

describe('native physical producer byte reconciliation before SQL', () => {
  it('keeps only exact detached artifact identity and never transports producer bytes to the writer', () => {
    const prepared = prepareNativeAttemptCompletionOutput(
      completionSchema.parse(input),
    );
    expect(prepared).toEqual({
      snapshot: input.nativeOutput,
      serializedReference: `{"artifactId":"${id}","kind":"artifact","schemaVersion":1}`,
    });
    expect(JSON.stringify(prepared)).not.toContain(value);
  });
  it.each(['sha256', 'byteLength', 'value', 'inline'] as const)(
    'rejects mismatched %s before acquiring a write client',
    async (kind) => {
      const connect = vi.fn(() =>
        Promise.reject(new Error('must not acquire')),
      );
      const request = {
        ...input,
        outcome:
          kind === 'value'
            ? { ...input.outcome, output: 'different' }
            : input.outcome,
        nativeOutput: {
          ...input.nativeOutput,
          ...(kind === 'sha256' ? { sha256: 'b'.repeat(64) } : {}),
          ...(kind === 'byteLength' ? { byteLength: 10 } : {}),
          ...(kind === 'inline'
            ? {
                reference: {
                  schemaVersion: 1 as const,
                  kind: 'inline' as const,
                  value: 'different',
                },
              }
            : {}),
        },
      };
      await expect(
        completeNodeAttempt({ connect } as unknown as Pool, request),
      ).rejects.toMatchObject({ name: 'NodeAttemptOutputInvalidError' });
      expect(connect).not.toHaveBeenCalled();
    },
  );
  it('preserves absent retained metadata and refuses prepared output on Call alias completion', async () => {
    expect(
      prepareNativeAttemptCompletionOutput(
        completionSchema.parse({ ...input, nativeOutput: undefined }),
      ),
    ).toBeUndefined();
    const connect = vi.fn();
    await expect(
      completeNodeAttempt(
        { connect } as unknown as Pool,
        input,
        'workflow_call_input_alias',
      ),
    ).rejects.toMatchObject({ name: 'NodeAttemptStateCorruptError' });
    expect(connect).not.toHaveBeenCalled();
  });
});
