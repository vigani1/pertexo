import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { loadNodeAttemptInputs } from '../src/execution/node-attempts/node-attempt-run-store-inputs.js';
import { readNativeAttemptValueSource } from '../src/execution/node-attempts/node-attempt-native-value-read.js';
import { parseNativeNodeAttemptValueSource } from '../src/execution/node-attempts/native-node-attempt-value-sources.js';
import { workflowCallAttemptAuthorityJson } from '../src/execution/node-attempts/node-attempt-call-input-record.js';
import type { NodeAttemptLease } from '../src/execution/node-attempts/node-attempt-run-store-contract.js';

const id = (n: number) =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const lease: NodeAttemptLease = {
  workspaceId: id(1),
  runId: id(2),
  workflowVersionId: id(3),
  nodeRunId: id(4),
  attemptId: id(5),
  attemptNumber: 1,
  admissionKind: 'execute',
  invocationKey: `${id(3)}|call|b:|i:`,
  nodeId: 'call',
  sideEffectClass: 'unsafe',
  workerId: 'worker',
  fenceToken: 2,
  leaseExpiresAt: new Date('2099-01-01T00:00:00Z'),
  delivery: { outboxEventId: id(6), payloadChecksum: 'a'.repeat(64) },
};
const source = {
  slot: 'run_input',
  source: {
    kind: 'run_input',
    workspaceId: id(1),
    runId: id(2),
    workflowVersionId: id(3),
    provenanceId: id(7),
  },
  snapshot: {
    reference: { schemaVersion: 1, kind: 'inline', value: null },
    serializedValue: 'null',
    byteLength: 4,
    sha256: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
  },
};
const waitLease: NodeAttemptLease = {
  ...lease,
  nodeId: 'wait',
  invocationKey: `${id(3)}|wait|b:|i:`,
  attemptNumber: 2,
  admissionKind: 'wait_resume',
  sideEffectClass: 'safe',
};
const resumeSource = {
  slot: 'wait_resume_output',
  source: {
    kind: 'physical_output',
    workspaceId: id(1),
    runId: id(2),
    workflowVersionId: id(3),
    provenanceId: id(8),
    nodeId: 'wait',
    invocationKey: waitLease.invocationKey,
    attemptId: id(9),
  },
  snapshot: source.snapshot,
};

/** External pg only: actual loader, parser and tenant owner remain composed. */
class SourceClient extends EventEmitter {
  public readonly statements: { sql: string; values: unknown[] }[] = [];
  public readonly releases: (boolean | Error | undefined)[] = [];
  public resumeProjection: unknown = resumeSource;
  private workspace: string | null = null;
  public constructor(
    private readonly controller: AbortController,
    private readonly stop?: 'control' | 'source' | 'denial' | 'abort_requested',
  ) {
    super();
  }
  public async query(sql: string, values: unknown[] = []) {
    await Promise.resolve();
    this.statements.push({ sql, values });
    if (sql.includes("set_config('app.workspace_id'"))
      this.workspace = values[0] as string;
    if (sql === 'commit' || sql === 'rollback') this.workspace = null;
    if (sql.includes('current_setting'))
      return {
        rows: [
          {
            workspace_id: this.workspace,
            actor_id: null,
            discovery_scope: null,
          },
        ],
      };
    if (sql.includes('select run.input_ref')) {
      if (this.stop === 'control') this.controller.abort();
      return {
        rows: [
          {
            abort_requested: this.stop === 'abort_requested',
            abort_reason: this.stop === 'abort_requested' ? 'canceled' : null,
            deadline_at: new Date('2099-01-01T00:00:00Z'),
            input_ref: {
              get value(): never {
                throw new Error('Decoded native input was accessed');
              },
            },
            graph_schema_version: 2,
            executable_schema_version: 3,
            executable_checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
            scheduler_state: {
              schemaVersion: 3,
              engineVersion: 'engine-v3',
              workflowVersionId: id(3),
              revision: 0,
              runStatus: 'running',
              nextEventSequence: 1,
              readySet: [],
              admittedInvocationKeys: [],
              invocations: [],
              joins: [],
              loops: [],
              calls: [],
              branchSelections: [],
              remainingIterationBudget: 1000,
              cancelRequested: false,
              deadlineExpired: false,
            },
          },
        ],
      };
    }
    if (sql.includes('read_native_attempt_value_source')) {
      if (this.stop === 'source') this.controller.abort();
      if (this.stop === 'denial') throw new Error('actual source owner denied');
      return {
        rows: [
          {
            source:
              (JSON.parse(String(values[1])) as { slot: string }).slot ===
              'wait_resume_output'
                ? this.resumeProjection
                : source,
          },
        ],
      };
    }
    return { rows: [] };
  }
  public release(error?: boolean | Error): void {
    this.releases.push(error);
    if (error) this.emit('end');
  }
}
function run(stop?: ConstructorParameters<typeof SourceClient>[1]) {
  const controller = new AbortController();
  const client = new SourceClient(controller, stop);
  const pool = {
    connect: () => Promise.resolve(client as unknown as PoolClient),
  } as unknown as Pool;
  const result = loadNodeAttemptInputs(pool, {
    lease,
    upstreamNodeOutputs: [],
    signal: controller.signal,
  });
  return { result, client };
}
describe('native attempt source ownership through actual tenant composition', () => {
  it('loads Wait resume metadata serially under the actual resumed lease, without decoded output', async () => {
    const controller = new AbortController();
    const client = new SourceClient(controller);
    const pool = {
      connect: () => Promise.resolve(client as unknown as PoolClient),
    } as unknown as Pool;
    await expect(
      loadNodeAttemptInputs(pool, {
        lease: waitLease,
        upstreamNodeOutputs: [],
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      runInput: null,
      nativeValueSources: { runInput: source, resumeOutput: resumeSource },
    });
    expect(
      client.statements
        .filter(({ sql }) => sql.includes('read_native_attempt_value_source'))
        .map(({ values }) => values),
    ).toEqual([
      [workflowCallAttemptAuthorityJson(waitLease), '{"slot":"run_input"}'],
      [
        workflowCallAttemptAuthorityJson(waitLease),
        '{"slot":"wait_resume_output"}',
      ],
    ]);
    expect(client.releases).toHaveLength(1);
  });
  it('reauthorizes selected Wait snapshots and rejects a substituted preceding attempt before hydration', async () => {
    const controller = new AbortController();
    const client = new SourceClient(controller);
    const pool = {
      connect: () => Promise.resolve(client as unknown as PoolClient),
    } as unknown as Pool;
    const request = {
      lease: waitLease,
      source: parseNativeNodeAttemptValueSource(resumeSource),
      signal: controller.signal,
    };
    await expect(readNativeAttemptValueSource(pool, request)).resolves.toEqual(
      request.source,
    );
    client.resumeProjection = {
      ...resumeSource,
      source: { ...resumeSource.source, attemptId: id(10) },
    };
    await expect(readNativeAttemptValueSource(pool, request)).rejects.toThrow(
      'independently accepted source scope differs',
    );
    expect(client.statements.at(-2)?.sql).toBe('rollback');
    expect(client.releases).toHaveLength(2);
  });
  it('independently reauthorizes hydration with the real lease and rejects historical routing IDs', async () => {
    const controller = new AbortController();
    const client = new SourceClient(controller);
    const pool = {
      connect: () => Promise.resolve(client as unknown as PoolClient),
    } as unknown as Pool;
    const parsed = parseNativeNodeAttemptValueSource(source);
    await expect(
      readNativeAttemptValueSource(pool, {
        lease,
        source: parsed,
        signal: controller.signal,
      }),
    ).resolves.toEqual(parsed);
    const wrong = parseNativeNodeAttemptValueSource({
      ...source,
      source: { ...source.source, provenanceId: id(8) },
    });
    await expect(
      readNativeAttemptValueSource(pool, {
        lease,
        source: wrong,
        signal: controller.signal,
      }),
    ).rejects.toThrow('independently accepted source scope differs');
    expect(client.releases).toHaveLength(2);
  });
  it('forwards only the existing actual lease carrier and preserves original snapshots', async () => {
    const { result, client } = run();
    await expect(result).resolves.toMatchObject({
      runInput: null,
      nativeValueSources: { runInput: source },
    });
    expect(
      client.statements.find(({ sql }) =>
        sql.includes('read_native_attempt_value_source'),
      )?.values,
    ).toEqual([
      workflowCallAttemptAuthorityJson(lease),
      '{"slot":"run_input"}',
    ]);
    expect(
      client.statements.some(({ sql }) =>
        sql.includes('read_workflow_call_result_reference'),
      ),
    ).toBe(false);
    expect(client.releases).toHaveLength(1);
  });
  it.each(['control', 'source'] as const)(
    'starts no further SQL after %s cancellation',
    async (stop) => {
      const { result, client } = run(stop);
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      const index = client.statements.findIndex(({ sql }) =>
        sql.includes(
          stop === 'control'
            ? 'select run.input_ref'
            : 'read_native_attempt_value_source',
        ),
      );
      expect(client.statements.slice(index + 1)).toEqual([]);
      expect(client.releases[0]).toBeInstanceOf(Error);
    },
  );
  it('performs no source read after actual canceled controls', async () => {
    const { result, client } = run('abort_requested');
    await expect(result).resolves.toMatchObject({
      abortRequested: true,
      abortReason: 'canceled',
    });
    expect(
      client.statements.some(({ sql }) =>
        sql.includes('read_native_attempt_value_source'),
      ),
    ).toBe(false);
  });
  it('rolls back source denial without retained decoding fallback', async () => {
    const { result, client } = run('denial');
    await expect(result).rejects.toThrow('actual source owner denied');
    expect(client.statements.map(({ sql }) => sql)).toContain('rollback');
    expect(client.statements.map(({ sql }) => sql)).not.toContain('commit');
  });
});
