import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { acceptWorkflowRun } from '../src/execution/runs/execution-acceptance.js';
import { withWorkspaceTransaction } from '../src/tenant-access/workspace.js';

const id = (n: number) =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const original = '{"message":"line\\n","number":1e-7}';

/** Only external pg is simulated: actual tenant, Drizzle and acceptance owners. */
class AcceptanceClient extends EventEmitter {
  public releases = 0;
  public readonly statements: { text: string; values: unknown[] }[] = [];
  private workspace: string | null = null;
  public constructor(private readonly denial?: Error) {
    super();
  }
  public async query(
    command: string | { text: string; rowMode?: string },
    values: unknown[] = [],
  ) {
    await Promise.resolve();
    const text = typeof command === 'string' ? command : command.text;
    this.statements.push({ text, values });
    if (text.includes("set_config('app.workspace_id'"))
      this.workspace = values[0] as string;
    if (text.includes('current_setting'))
      return {
        rows: [
          {
            workspace_id: this.workspace,
            actor_id: null,
            discovery_scope: null,
          },
        ],
        rowCount: 1,
      };
    if (text.includes('lock_workspace_run_admission'))
      return { rows: [{ status: 'active' }], rowCount: 1 };
    if (
      text.includes('record_native_root_execution_input') &&
      this.denial !== undefined
    )
      throw this.denial;
    if (text === 'commit' || text === 'rollback') this.workspace = null;
    if (text.startsWith('insert into "app"."outbox_events"'))
      return { rows: [[id(8)]], rowCount: 1 };
    if (text.startsWith('insert into "app"."workflow_runs"'))
      return { rows: [[new Date('2026-10-04T00:00:00Z')]], rowCount: 1 };
    if (
      (text.startsWith('insert into "app"."idempotency_records"') ||
        text.startsWith('update "app"."idempotency_records"')) &&
      text.includes('returning')
    )
      return { rows: [[id(9)]], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
  public release(): void {
    this.releases += 1;
  }
}

function accept(
  client: AcceptanceClient,
  schemaVersion: 2 | 3,
  supplied = true,
) {
  const pool = {
    connect: () => Promise.resolve(client as unknown as PoolClient),
  } as unknown as Pool;
  return withWorkspaceTransaction(pool, id(1), (transaction) =>
    acceptWorkflowRun(transaction, {
      workflowId: id(2),
      workflowVersionId: id(3),
      engineVersion: 'engine-v3',
      initialCheckpoint: {
        schemaVersion,
        engineVersion: 'engine-v3',
        workflowVersionId: id(3),
        revision: 0,
        runStatus: 'queued',
        nextEventSequence: 2,
        readySet: [],
        admittedInvocationKeys: [],
        invocations: [],
        joins: [],
        loops: [],
        branchSelections: [],
        remainingIterationBudget: 1000,
        cancelRequested: false,
        deadlineExpired: false,
        ...(schemaVersion === 3 ? { calls: [] } : {}),
      },
      operation: 'workflow.run.accept',
      scope: 'workflow:manual',
      triggerType: 'manual',
      keyHash: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      ...(supplied ? { runInput: { message: 'line\n', number: 1e-7 } } : {}),
    }),
  );
}

describe('native root input in canonical acceptance (external pg, not SQL authority proof)', () => {
  it('captures original input before projection and accepts it in the same canonical transaction', async () => {
    const client = new AcceptanceClient();
    await expect(accept(client, 3)).resolves.toMatchObject({
      duplicate: false,
      status: 'queued',
    });
    const input = client.statements.findIndex(({ text }) =>
      text.includes('record_native_root_execution_input'),
    );
    const receipt = client.statements.findIndex(({ text }) =>
      text.startsWith('update "app"."idempotency_records"'),
    );
    const commit = client.statements.findIndex(({ text }) => text === 'commit');
    expect(input).toBeGreaterThan(receipt);
    expect(commit).toBeGreaterThan(input);
    expect(client.statements[input]?.values.at(-1)).toBe(original);
    expect(client.releases).toBe(1);
    const runInsert = client.statements.find(({ text }) =>
      text.startsWith('insert into "app"."workflow_runs"'),
    );
    expect(runInsert?.text).toContain('{familyPolicy,defaultMaxRunDurationMs}');
  });
  it('keeps omitted native input absent', async () => {
    const client = new AcceptanceClient();
    await accept(client, 3, false);
    expect(
      client.statements
        .find(({ text }) => text.includes('record_native_root_execution_input'))
        ?.values.at(-1),
    ).toBeNull();
  });
  it('rolls back canonical acceptance when protected native input acceptance fails', async () => {
    const denial = new Error('native root input denied');
    const client = new AcceptanceClient(denial);
    // The real Drizzle adapter preserves the original PostgreSQL rejection as
    // its cause. Do not replace it with a refusal or unwrap only for this test.
    await expect(accept(client, 3)).rejects.toMatchObject({ cause: denial });
    expect(client.statements.some(({ text }) => text === 'commit')).toBe(false);
    expect(client.statements.some(({ text }) => text === 'rollback')).toBe(
      true,
    );
  });
  it('does not invoke native input SQL for retained roots', async () => {
    const client = new AcceptanceClient();
    await expect(accept(client, 2)).resolves.toMatchObject({
      status: 'queued',
    });
    expect(
      client.statements.some(({ text }) =>
        text.includes('record_native_root_execution_input'),
      ),
    ).toBe(false);
  });
});
