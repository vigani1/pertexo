import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { workflowCallableContractIdentityV1 } from '@pertexo/workflow-model/workflow-call-closure';
import { persistedWorkflowCallStateSchemaV1 } from '../src/compatibility/persisted-workflow-checkpoint-v3.js';
import { validateCoordinatorArtifactCallInputs } from '../src/execution/coordinator/coordinator-call-input-validation.js';

const id = (n: number) =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const owner = {
  workspaceId: id(1),
  runId: id(2),
  workflowVersionId: id(3),
  expectedRevision: 4,
  delivery: { outboxEventId: id(4), payloadChecksum: 'a'.repeat(64) },
};
const declaration = {
  schemaVersion: 1 as const,
  input: {
    type: 'object' as const,
    properties: { name: { type: 'string' as const } },
    required: ['name'],
  },
  result: { type: 'object' as const, properties: {}, required: [] },
  resultSelector: { kind: 'literal' as const, value: {} },
};
const value = { name: 'x'.repeat(300_000) };
const bytes = JSON.stringify(value);
const snapshot = {
  reference: { schemaVersion: 1, kind: 'artifact', artifactId: id(8) },
  sha256: createHash('sha256').update(bytes).digest('hex'),
  byteLength: Buffer.byteLength(bytes),
};
const call = persistedWorkflowCallStateSchemaV1.parse({
  invocationKey: 'call-key',
  nodeId: 'call',
  declarationAttemptId: id(5),
  status: 'awaiting_admission',
  input: { kind: 'artifact', artifactId: id(8) },
  inputChecksum: snapshot.sha256,
  pin: {
    workflowId: id(6),
    versionId: id(7),
    checksum: `wf:v3:sha256:${'b'.repeat(64)}`,
    callableContractIdentity: workflowCallableContractIdentityV1(declaration),
  },
});
const row = {
  invocation_key: 'call-key',
  node_id: 'call',
  attempt_id: id(5),
  callee_version_id: id(7),
  snapshot,
};

/** Only pg and the external framework hydration port are simulated. */
class ReadClient extends EventEmitter {
  public readonly statements: { text: string; values: unknown[] }[] = [];
  public open = false;
  public releases = 0;
  public material: unknown = row;
  public callable: unknown = declaration;
  private workspace: string | null = null;
  private timeout = 0;
  public async query(text: string, values: unknown[] = []) {
    await Promise.resolve();
    this.statements.push({ text, values });
    if (text.startsWith('begin')) this.open = true;
    if (text.includes("set_config('app.workspace_id'"))
      this.workspace = values[0] as string;
    if (text.includes("set_config('statement_timeout'"))
      this.timeout = Number.parseInt(String(values[0]), 10);
    if (text === 'commit' || text === 'rollback') {
      this.open = false;
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
    if (text.includes('read_workflow_call_declaration_materials'))
      return { rows: [this.material] };
    if (text.includes('from app.workflow_versions'))
      return { rows: [{ declaration: this.callable }] };
    return { rows: [] };
  }
  public release() {
    this.releases += 1;
  }
}
function fixture() {
  const client = new ReadClient();
  const pool = {
    options: { connectionTimeoutMillis: 100 },
    connect: (callback: (error: undefined, client: PoolClient) => void) => {
      callback(undefined, client as unknown as PoolClient);
    },
  } as unknown as Pool;
  const controller = new AbortController();
  const hydrate = vi.fn(() => {
    expect(client.open).toBe(false);
    expect(client.releases).toBe(1);
    return Promise.resolve(value);
  });
  const request = {
    owner,
    declarations: [call],
    signal: controller.signal,
    readTimeoutMillis: 250,
    hydrate,
  };
  return { client, pool, controller, hydrate, request };
}

describe('independent artifact Call input precommit validation (not SQL admission authority)', () => {
  it('rereads actual declaration and exact pinned contract, releases SQL, then validates one detached value', async () => {
    const selected = fixture();
    await validateCoordinatorArtifactCallInputs(
      selected.pool,
      selected.request,
    );
    expect(selected.hydrate).toHaveBeenCalledExactlyOnceWith({
      owner,
      source: {
        invocationKey: 'call-key',
        nodeId: 'call',
        declarationAttemptId: id(5),
        calleeVersionId: id(7),
        snapshot,
      },
      signal: selected.controller.signal,
    });
    expect(
      selected.client.statements.find(({ text }) =>
        text.includes('read_workflow_call_declaration_materials'),
      )?.values,
    ).toEqual([id(2), ['call-key'], JSON.stringify(owner)]);
    expect(
      selected.client.statements.find(({ text }) =>
        text.includes('from app.workflow_versions'),
      )?.values,
    ).toEqual([id(1), id(6), id(7), call.pin.checksum]);
    expect(
      selected.client.statements.some(
        ({ text }) =>
          text === 'begin isolation level repeatable read read only',
      ),
    ).toBe(true);
    expect(
      selected.client.statements.some(({ text }) =>
        /insert|update|delete/iu.test(text),
      ),
    ).toBe(false);
  });
  it.each(['attempt', 'artifact', 'checksum', 'callee'] as const)(
    'refuses substituted %s identity before hydration',
    async (kind) => {
      const selected = fixture();
      selected.client.material = {
        ...row,
        ...(kind === 'attempt' ? { attempt_id: id(9) } : {}),
        ...(kind === 'callee' ? { callee_version_id: id(9) } : {}),
        snapshot: {
          ...snapshot,
          ...(kind === 'checksum' ? { sha256: 'c'.repeat(64) } : {}),
          ...(kind === 'artifact'
            ? { reference: { ...snapshot.reference, artifactId: id(9) } }
            : {}),
        },
      };
      await expect(
        validateCoordinatorArtifactCallInputs(selected.pool, selected.request),
      ).rejects.toThrow('invalid');
      expect(selected.hydrate).not.toHaveBeenCalled();
      expect(selected.client.open).toBe(false);
    },
  );
  it('refuses a different pinned callable contract before reading artifact bytes', async () => {
    const selected = fixture();
    selected.client.callable = {
      ...declaration,
      input: { type: 'object', properties: {}, required: [] },
    };
    await expect(
      validateCoordinatorArtifactCallInputs(selected.pool, selected.request),
    ).rejects.toThrow('invalid');
    expect(selected.hydrate).not.toHaveBeenCalled();
  });
  it('refuses a contract-invalid decoded value without deriving refusal or admission truth', async () => {
    const selected = fixture();
    selected.hydrate.mockResolvedValue({ name: 1 } as unknown as typeof value);
    await expect(
      validateCoordinatorArtifactCallInputs(selected.pool, selected.request),
    ).rejects.toThrow('invalid');
    expect(selected.client.open).toBe(false);
  });
  it('starts no read after cancellation and stops after cancellation during joined hydration', async () => {
    const stopped = fixture();
    stopped.controller.abort();
    await expect(
      validateCoordinatorArtifactCallInputs(stopped.pool, stopped.request),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(stopped.client.statements).toEqual([]);
    const selected = fixture();
    selected.hydrate.mockImplementation(() => {
      selected.controller.abort();
      return Promise.resolve(value);
    });
    await expect(
      validateCoordinatorArtifactCallInputs(selected.pool, selected.request),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(selected.hydrate).toHaveBeenCalledOnce();
  });
});
