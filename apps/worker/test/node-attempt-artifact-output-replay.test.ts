import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import {
  createDatabaseRuntime,
  createNodeAttemptRunStore,
} from '@pertexo/database/execution';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import {
  ValueClient,
  current,
} from './support/node-attempt-artifact-values.fixture.js';

it.each([
  'same',
  'changed_same_length',
  'changed_length',
  'same_after_barrier',
  'changed_after_barrier',
  'same_after_failed',
  'changed_after_failed',
  'same_after_canceled',
  'changed_after_canceled',
  'same_after_timed_out',
  'changed_after_timed_out',
  'same_after_outcome_unknown',
  'changed_after_outcome_unknown',
] as const)(
  'reconciles %s artifact bytes at the actual completed run-store seam (external pg simulated)',
  async (replay) => {
    const client = new ValueClient();
    const checkout = vi
      .spyOn(Pool.prototype, 'connect')
      .mockReturnValue(
        Promise.resolve(client as unknown as PoolClient) as never,
      );
    const config = parseDatabaseConfig({
      connectionString:
        'postgresql://pertexo_worker:unused@invalid.invalid/pertexo',
      max: 1,
    });
    const runtime = createDatabaseRuntime(config, { monitorLockWaits: false });
    const store = createNodeAttemptRunStore(config, runtime);
    const reference = {
      schemaVersion: 1 as const,
      kind: 'artifact' as const,
      artifactId: '99999999-9999-4999-8999-999999999999',
    };
    const request = (output: string) => ({
      lease: current,
      outcome: { status: 'succeeded' as const, output },
      nativeOutput: {
        reference,
        sha256: createHash('sha256')
          .update(JSON.stringify(output))
          .digest('hex'),
        byteLength: Buffer.byteLength(JSON.stringify(output)),
      },
      signal: new AbortController().signal,
    });
    try {
      const original = 'x'.repeat(300_000);
      await expect(store.complete(request(original))).resolves.toMatchObject({
        kind: 'committed',
      });
      const before = client.statements.length;
      client.logicalNodeStatus = replay.endsWith('_barrier')
        ? 'waiting'
        : replay.endsWith('_failed')
          ? 'failed'
          : replay.endsWith('_canceled')
            ? 'canceled'
            : replay.endsWith('_timed_out')
              ? 'timed_out'
              : replay.endsWith('_outcome_unknown')
                ? 'outcome_unknown'
                : undefined;
      const output =
        replay === 'same' || replay.startsWith('same_after_')
          ? original
          : 'y'.repeat(replay === 'changed_same_length' ? 300_000 : 300_001);
      const result = store.complete(request(output));
      if (replay === 'same' || replay.startsWith('same_after_'))
        await expect(result).resolves.toEqual({
          kind: 'duplicate',
          outboxEventId: null,
        });
      else
        await expect(result).rejects.toMatchObject({
          name: 'NodeAttemptStateCorruptError',
        });
      const statements = client.statements.slice(before);
      expect(
        statements.filter((text) =>
          text.includes('native_attempt_artifact_output_replay_matches'),
        ),
      ).toHaveLength(1);
      expect(
        statements.some((text) =>
          /record_native_workflow_attempt_output|prelock_native_attempt_value_owner|update app.node_attempts|insert into app.outbox_events|artifacts/u.test(
            text,
          ),
        ),
      ).toBe(false);
      expect(
        client.parameters
          .flat()
          .some(
            (parameter) =>
              typeof parameter === 'string' && parameter.includes(output),
          ),
      ).toBe(false);
    } finally {
      checkout.mockRestore();
      await store.close();
      await runtime.close();
    }
  },
);
