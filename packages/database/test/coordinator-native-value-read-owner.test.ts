import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { createNativeCoordinatorValueReads } from '../src/execution/coordinator/coordinator-native-value-reads.js';
import type { NativeCallableValueDescriptor } from '../src/execution/coordinator/coordinator-native-value-read-contract.js';

const id = (n: number) =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const owner = {
  workspaceId: id(1),
  runId: id(2),
  workflowVersionId: id(3),
  expectedRevision: 4,
  delivery: { outboxEventId: id(4), payloadChecksum: 'a'.repeat(64) },
};
const original = '{"name":"original","number":1e-7}';
const sha256 = createHash('sha256').update(original).digest('hex');
const descriptor: NativeCallableValueDescriptor = {
  slot: 'upstream_output',
  source: {
    kind: 'workflow_call_result',
    workspaceId: id(1),
    provenanceId: id(5),
    parentRunId: id(2),
    parentWorkflowVersionId: id(3),
    childRunId: id(6),
    childWorkflowVersionId: id(7),
    nodeId: 'call',
    invocationKey: 'call-key',
  },
  valueIdentity: {
    reference: { schemaVersion: 1, kind: 'inline' },
    sha256,
    byteLength: Buffer.byteLength(original),
    mediaType: 'application/vnd.pertexo.execution-value+json;version=1',
  },
};

/** External pg only; the real tenant owner checks scope, timeout, commit and hygiene. */
class ReadClient extends EventEmitter {
  public readonly statements: { text: string; values: unknown[] }[] = [];
  public releases = 0;
  private workspace: string | null = null;
  private timeout = 0;
  public constructor(
    private readonly response: unknown,
    private readonly failure?: Error,
  ) {
    super();
  }
  public async query(text: string, values: unknown[] = []) {
    await Promise.resolve();
    this.statements.push({ text, values });
    if (text.includes("set_config('app.workspace_id'"))
      this.workspace = values[0] as string;
    if (text.includes("set_config('statement_timeout'"))
      this.timeout = Number.parseInt(String(values[0]), 10);
    if (text === 'commit' || text === 'rollback') {
      this.workspace = null;
      this.timeout = 0;
    }
    if (text.includes('current_setting'))
      return {
        rows: [
          {
            workspace_id: this.workspace,
            actor_id: null,
            discovery_scope: null,
            statement_timeout_millis: this.timeout,
          },
        ],
      };
    if (
      text.includes('app.inspect_native_') ||
      text.includes('app.load_native_') ||
      text.includes('app.read_native_')
    ) {
      if (this.failure !== undefined) throw this.failure;
      return { rows: [{ result: this.response }] };
    }
    return { rows: [] };
  }
  public release(): void {
    this.releases += 1;
  }
}

function reads(client: ReadClient, acquisitionMillis = 100) {
  let checkouts = 0;
  const pool = {
    options: { connectionTimeoutMillis: acquisitionMillis },
    connect: (callback: (error: undefined, client: PoolClient) => void) => {
      checkouts += 1;
      callback(undefined, client as unknown as PoolClient);
    },
  } as unknown as Pool;
  return {
    store: createNativeCoordinatorValueReads(pool, 250),
    checkouts: () => checkouts,
  };
}
function request() {
  return {
    owner,
    signal: new AbortController().signal,
    readTimeoutMillis: 250,
  };
}

describe('actual native coordinator read composition (not SQL authority qualification)', () => {
  it('owns the readonly tenant lifecycle and exact current delivery for inspection', async () => {
    const response = {
      kind: 'active',
      databaseNow: '2026-10-04T00:00:00Z',
      deadlineAt: '2026-10-04T01:00:00Z',
    };
    const client = new ReadClient(response);
    await expect(
      reads(client).store.inspectCoordinatorValueReadOwner(request()),
    ).resolves.toEqual(response);
    expect(
      client.statements.find(({ text }) => text.includes('app.inspect_native_'))
        ?.values,
    ).toEqual([
      JSON.stringify({
        delivery: owner.delivery,
        expectedRevision: 4,
        runId: id(2),
        workflowVersionId: id(3),
        workspaceId: id(1),
      }),
    ]);
    expect(
      client.statements.some(
        ({ text }) =>
          text === 'begin isolation level repeatable read read only',
      ),
    ).toBe(true);
    expect(
      client.statements.some(({ text }) =>
        text.includes("set_config('statement_timeout'"),
      ),
    ).toBe(true);
    expect(client.statements.some(({ text }) => text === 'commit')).toBe(true);
    expect(client.releases).toBe(1);
  });

  it('loads only bounded metadata and compares the exact selected inventory', async () => {
    const projection = {
      runInput: null,
      outputs: [
        {
          invocationKey: 'call-key',
          output: {
            kind: 'workflow_call' as const,
            invocationKey: 'call-key',
            childRunId: id(6),
          },
          valueSource: descriptor,
        },
      ],
    };
    const demand = {
      expectedRevision: 4,
      resultSelector: {
        kind: 'node_output' as const,
        nodeId: 'call',
        path: '$',
      },
      requiresRunInput: false,
      sources: [
        {
          nodeId: 'call',
          invocationKey: 'call-key',
          output: projection.outputs[0]!.output,
        },
      ],
    };
    const client = new ReadClient({ kind: 'ready', projection });
    await expect(
      reads(client).store.loadCallableCompletionSources({
        ...request(),
        demand,
      }),
    ).resolves.toEqual({ kind: 'ready', projection });
    expect(JSON.stringify(projection)).not.toContain('original');
    expect(client.releases).toBe(1);
  });

  it('fetches and verifies original bytes only for the exact selected accepted identity', async () => {
    const valueSource = {
      slot: descriptor.slot,
      source: descriptor.source,
      snapshot: {
        reference: {
          schemaVersion: 1,
          kind: 'inline',
          value: JSON.parse(original) as unknown,
        },
        sha256,
        byteLength: Buffer.byteLength(original),
        serializedValue: original,
      },
    };
    const client = new ReadClient({ kind: 'ready', valueSource });
    await expect(
      reads(client).store.readCallableCompletionSource({
        ...request(),
        source: descriptor,
      }),
    ).resolves.toEqual({ kind: 'ready', valueSource });
    expect(client.releases).toBe(1);
    await expect(
      reads(
        new ReadClient({ kind: 'ready', valueSource }),
      ).store.readCallableCompletionSource({
        ...request(),
        source: {
          ...descriptor,
          valueIdentity: {
            ...descriptor.valueIdentity,
            sha256: 'b'.repeat(64),
          },
        },
      }),
    ).rejects.toThrow('accepted source identity differs');
  });

  it('returns actual typed control stops without reclassifying an unavailable source as a deadline', async () => {
    const stopped = {
      kind: 'stopped',
      stop: { kind: 'unavailable', reason: 'source_read_failed' },
    };
    await expect(
      reads(new ReadClient(stopped)).store.readCallableCompletionSource({
        ...request(),
        source: descriptor,
      }),
    ).resolves.toEqual(stopped);
  });

  it('classifies known transport outages after real rollback but preserves integrity and joined-cleanup failures', async () => {
    const outage = Object.assign(new Error('Disconnected'), {
      code: 'ECONNRESET',
    });
    const client = new ReadClient(null, outage);
    await expect(
      reads(client).store.inspectCoordinatorValueReadOwner(request()),
    ).resolves.toEqual({
      kind: 'stopped',
      stop: { kind: 'unavailable', reason: 'control_read_failed' },
    });
    expect(client.statements.some(({ text }) => text === 'rollback')).toBe(
      true,
    );
    expect(client.releases).toBe(1);
    const integrity = Object.assign(new Error('Scope differs'), {
      code: '23514',
    });
    await expect(
      reads(
        new ReadClient(null, integrity),
      ).store.inspectCoordinatorValueReadOwner(request()),
    ).rejects.toBe(integrity);
    const cleanup = new AggregateError([outage], 'Joined cleanup failed');
    await expect(
      reads(
        new ReadClient(null, cleanup),
      ).store.inspectCoordinatorValueReadOwner(request()),
    ).rejects.toBe(cleanup);
  });

  it('does not check out on context abort or weaken an incompatible actual acquisition bound', async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = reads(new ReadClient(null));
    await expect(
      aborted.store.inspectCoordinatorValueReadOwner({
        ...request(),
        signal: controller.signal,
      }),
    ).resolves.toEqual({ kind: 'stopped', stop: { kind: 'context_aborted' } });
    expect(aborted.checkouts()).toBe(0);
    const incompatible = reads(new ReadClient(null), 500);
    await expect(
      incompatible.store.inspectCoordinatorValueReadOwner(request()),
    ).rejects.toThrow('Pool acquisition bound');
    expect(incompatible.checkouts()).toBe(0);
  });
});
