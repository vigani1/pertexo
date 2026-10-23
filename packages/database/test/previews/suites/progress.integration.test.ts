import { createWorkspaceVariablesStore } from '../../../src/variables/store.js';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  buildWorkflowTestExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { createWorkflowAuthoringDatabase } from '../../../src/authoring/workflows/database.js';
import { createWorkflowInputCaseDatabase } from '../../../src/authoring/input-cases/store.js';
import { createWorkflowTestSuiteScanner } from '../../../src/previews/suites/scanner.js';
import { createWorkflowExecutionReader } from '../../../src/runs/queries/execution/source.js';
import { parseDatabaseConfig } from '../../../src/config.js';
import { serializeStoredExecutionValue } from '../../../src/platform/stored-execution-value.js';
import {
  apiUrl,
  dispatcherUrl,
  queryAsOwner,
  workspaceId,
  actorId,
  otherWorkspaceId,
  enforceTestRetention,
  purgeTestWorkspace,
} from '../../support/workflow-authoring.js';
const catalog = composeExecutableCatalog(CORE_NODE_CATALOG);
const config = () => parseDatabaseConfig({ connectionString: apiUrl, max: 4 });
const maintenance = () =>
  parseDatabaseConfig({ connectionString: dispatcherUrl, max: 2 });
let database: ReturnType<typeof createWorkflowAuthoringDatabase>;
let cases: ReturnType<typeof createWorkflowInputCaseDatabase>;
let scanner: Awaited<ReturnType<typeof createWorkflowTestSuiteScanner>>;
let reader: ReturnType<typeof createWorkflowExecutionReader>;
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
const query = <T extends Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
) => queryAsOwner<T>(sql, values, workspaceId);
async function fixture(count = 2) {
  const workflowId = randomUUID(),
    versionId = randomUUID();
  const graph = parseWorkflowGraphDraft({
    settings: {},
    nodes: ['core.manual', 'core.set'].map((key, index) => ({
      id: index === 0 ? 'start' : 'set',
      definition: { key, version: 1 },
      position: { x: index * 200, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
    })),
    edges: [
      {
        id: 'link',
        source: { nodeId: 'start', port: 'out' },
        target: { nodeId: 'set', port: 'in' },
      },
    ],
  });
  const executable = buildWorkflowExecutable({ graph, catalog });
  await query(
    "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Suite proof',$3)",
    [workflowId, workspaceId, actorId],
  );
  await query(
    'insert into app.workflow_drafts(workflow_id,workspace_id,graph_json,updated_by) values($1,$2,$3::jsonb,$4)',
    [workflowId, workspaceId, JSON.stringify(graph), actorId],
  );
  await query(
    'insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by) values($1,$2,$3,1,$4::jsonb,$5::jsonb,$6,$7)',
    [
      versionId,
      workspaceId,
      workflowId,
      JSON.stringify(graph),
      JSON.stringify(executable.envelope),
      executable.checksum,
      actorId,
    ],
  );
  const scope = { workspaceId, workflowId, actorId };
  const records = [];
  for (let index = 0; index < count; index++)
    records.push(
      await cases.createCase({
        ...scope,
        workflowVersionId: versionId,
        name: `Case ${String(index + 1)}`,
        input: { amount: index + 1 },
        expectations: {
          outcome: 'succeeds',
          assertions: [
            {
              source: { kind: 'final' },
              path: '$.amount',
              operator: 'equals',
              expected: index + 1,
            },
          ],
        },
        idempotencyKey: randomUUID(),
      }),
    );
  return { scope, records };
}
async function command(f: Awaited<ReturnType<typeof fixture>>) {
  const p = await database.workflowTestSuites.prepare(f.scope);
  return {
    ...f.scope,
    idempotencyKey: randomUUID(),
    request: {
      expectedRevision: p.draftRevision,
      expectedSamples: p.samples,
      expectedEffectfulSteps: p.effectfulSteps.map((step) => step.nodeId),
      expectedCases: p.cases.map(({ id, revision }) => ({ id, revision })),
      expectedVariableSetRevision: p.variableSetRevision,
      signature: p.signature,
      acknowledgeSideEffects: false,
    },
  };
}
async function due(suiteId: string) {
  await query(
    "update app.workflow_test_suites set next_check_at=clock_timestamp()-interval '1 second' where id=$1",
    [suiteId],
  );
}
async function complete(runId: string, value: unknown, status = 'succeeded') {
  await query(
    'update app.workflow_runs set status=$2,completed_at=clock_timestamp(),output_ref=$3::jsonb where id=$1',
    [runId, status, serializeStoredExecutionValue({ kind: 'inline', value })],
  );
}
function runId(
  detail: Awaited<ReturnType<typeof database.workflowTestSuites.get>>,
  ordinal: number,
) {
  const value = detail.cases[ordinal]?.runId;
  if (value === undefined || value === null)
    throw new Error('Case is not admitted');
  return value;
}

describe('durable serial draft suites', () => {
  registerFreezesCasesSharesOneSource();

  registerRequiresExactEffectAcknowledgementAccepts();

  registerFreezesPinsSharesExactOutput();

  registerKeepsSharedSourceFirstRun();
});

function registerFreezesCasesSharesOneSource(): void {
  it('freezes cases, shares one source and advances once across competing scanners and restarts', async () => {
    const f = await fixture(),
      intent = await command(f),
      accepted = await database.workflowTestSuites.start(intent);
    expect(await database.workflowTestSuites.start(intent)).toEqual(accepted);
    const first = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    expect(first.cases.map((entry) => entry.status)).toEqual([
      'running',
      'pending',
    ]);
    const source = (
      await query<{ workflow_version_id: string }>(
        'select workflow_version_id from app.workflow_runs where id=$1',
        [runId(first, 0)],
      )
    )[0]?.workflow_version_id;
    expect(source).toBeTruthy();
    expect(source).not.toBe(runId(first, 0));
    expect(
      await reader.readForExecution({
        workspaceId,
        workflowVersionId: source ?? '',
      }),
    ).toMatchObject({
      workflowId: f.scope.workflowId,
      test: { pinnedNodeIds: [] },
    });
    const second = f.records[1];
    if (second === undefined) throw new Error('Missing case');
    await cases.updateCase({
      ...f.scope,
      caseId: second.caseId,
      expectedRevision: 1,
      name: 'Changed',
      input: { amount: 99 },
      idempotencyKey: randomUUID(),
    });
    expect(await database.workflowTestSuites.start(intent)).toEqual(accepted);
    await complete(runId(first, 0), { amount: 1 });
    await due(accepted.suiteId);
    const other = await createWorkflowTestSuiteScanner(config(), maintenance());
    try {
      await Promise.all([scanner.scan(25), other.scan(25)]);
    } finally {
      await other.close();
    }
    const next = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    expect(next.cases.map((entry) => entry.status)).toEqual([
      'passed',
      'running',
    ]);
    expect(
      (
        await query<{ input_ref: unknown; workflow_version_id: string }>(
          'select input_ref,workflow_version_id from app.workflow_runs where id=$1',
          [runId(next, 1)],
        )
      )[0]?.workflow_version_id,
    ).toBe(source);
    expect(
      (
        await query<{ input: string }>(
          'select input from app.workflow_test_suite_cases where suite_id=$1 and ordinal=1',
          [accepted.suiteId],
        )
      )[0]?.input,
    ).toBe('{"amount":2}');
    await complete(runId(next, 1), { amount: 2 });
    await due(accepted.suiteId);
    await restartSuiteScanner();
    await scanner.scan(25);
    expect(
      await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).toMatchObject({ status: 'passed', passed: 2, total: 2 });
    expect(
      (
        await database.workflowTestSuites.report({
          ...f.scope,
          ...accepted,
          ordinal: 1,
        })
      ).report,
    ).toMatchObject({
      outcomeMatched: true,
      assertions: [{ actual: { state: 'value', value: 2, matched: true } }],
    });
    expect(
      await query(
        'select id from app.workflow_test_snapshots where workflow_id=$1',
        [f.scope.workflowId],
      ),
    ).toHaveLength(1);
    expect(
      (await database.workflowTestSuites.list(f.scope)).current.signature,
    ).not.toBe(first.signature);
  });

  it('refuses stale cases and mutual standalone/suite overlap before any new run', async () => {
    const f = await fixture(1),
      intent = await command(f),
      entry = f.records[0];
    if (entry === undefined) throw new Error('Missing case');
    await cases.updateCase({
      ...f.scope,
      caseId: entry.caseId,
      expectedRevision: 1,
      name: 'Edited',
      input: { amount: 1 },
      idempotencyKey: randomUUID(),
    });
    await expect(
      database.workflowTestSuites.start(intent),
    ).rejects.toMatchObject({ reason: 'cases_changed' });
    const accepted = await database.workflowTestSuites.start(await command(f));
    const p = await database.workflowTests.prepare(f.scope);
    await expect(
      database.workflowTests.start({
        ...f.scope,
        idempotencyKey: randomUUID(),
        request: {
          expectedRevision: p.draftRevision,
          expectedSamples: p.samples,
          expectedEffectfulSteps: [],
          acknowledgeSideEffects: false,
          input: {},
        },
      }),
    ).rejects.toMatchObject({ reason: 'already_running' });
    const detail = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    await complete(runId(detail, 0), { amount: 1 });
    await due(accepted.suiteId);
    await scanner.scan(25);
  });

  it('admits fifty serial tests with one immutable snapshot and bounded history', async () => {
    const f = await fixture(50),
      accepted = await database.workflowTestSuites.start(await command(f));
    for (let ordinal = 0; ordinal < 50; ordinal++) {
      const detail = await database.workflowTestSuites.get({
        ...f.scope,
        ...accepted,
      });
      expect(
        detail.cases.filter((entry) => entry.status === 'running'),
      ).toHaveLength(1);
      await complete(runId(detail, ordinal), { amount: ordinal + 1 });
      await due(accepted.suiteId);
      await scanner.scan(25);
    }
    expect(
      await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).toMatchObject({ status: 'passed', passed: 50, total: 50 });
    expect(
      await query(
        'select id from app.workflow_test_snapshots where workflow_id=$1',
        [f.scope.workflowId],
      ),
    ).toHaveLength(1);
  }, 30000);
}

function registerRequiresExactEffectAcknowledgementAccepts(): void {
  it('requires exact effect acknowledgement and accepts only one concurrent start', async () => {
    const f = await fixture(1);
    const effectCatalog = composeExecutableCatalog({
      ...CORE_NODE_CATALOG,
      definitions: CORE_NODE_CATALOG.definitions.map((definition) =>
        definition.definition.key === 'core.set'
          ? { ...definition, retryClass: 'unsafe' as const }
          : definition,
      ),
    });
    const effects = createWorkflowAuthoringDatabase(config(), {
      executableCompiler: (graph) => {
        const executable = buildWorkflowExecutable({
          graph,
          catalog: effectCatalog,
        });
        return {
          checksum: executable.checksum,
          executableJson: executable.envelope,
        };
      },
      workflowTestCompiler: (graph, pins) =>
        buildWorkflowTestExecutable({ graph, pins, catalog: effectCatalog }),
    });
    try {
      const intent = await command(f);
      const request = { ...intent.request, expectedEffectfulSteps: ['set'] };
      await expect(
        effects.workflowTestSuites.start({ ...intent, request }),
      ).rejects.toMatchObject({ reason: 'effects_acknowledgement_required' });
      await expect(
        effects.workflowTestSuites.start({
          ...intent,
          request: {
            ...request,
            acknowledgeSideEffects: true,
            expectedEffectfulSteps: [],
          },
        }),
      ).rejects.toMatchObject({ reason: 'effects_changed' });
      const results = await Promise.allSettled([
        effects.workflowTestSuites.start({
          ...intent,
          request: { ...request, acknowledgeSideEffects: true },
        }),
        effects.workflowTestSuites.start({
          ...intent,
          idempotencyKey: randomUUID(),
          request: { ...request, acknowledgeSideEffects: true },
        }),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toMatchObject([{ reason: { reason: 'already_running' } }]);
    } finally {
      await effects.close();
    }
  });

  it('keeps case reports private and stops future admissions after cancellation', async () => {
    const f = await fixture();
    const accepted = await database.workflowTestSuites.start(await command(f));
    const first = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    await expect(
      database.workflowTestSuites.get({
        ...f.scope,
        workspaceId: otherWorkspaceId,
        ...accepted,
      }),
    ).rejects.toThrow();
    await expect(
      database.workflowTestSuites.report({
        ...f.scope,
        workspaceId: otherWorkspaceId,
        ...accepted,
        ordinal: 0,
      }),
    ).rejects.toThrow();
    await database.workflowTestSuites.cancel({ ...f.scope, ...accepted });
    await database.workflowTestSuites.cancel({ ...f.scope, ...accepted });
    await complete(runId(first, 0), {}, 'canceled');
    await due(accepted.suiteId);
    await scanner.scan(25);
    expect(
      await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).toMatchObject({
      status: 'canceled',
      stopReason: 'user_canceled',
      skipped: 1,
      cases: [{ status: 'error' }, { status: 'skipped', runId: null }],
    });
    expect(
      (
        await database.workflowTestSuites.report({
          ...f.scope,
          ...accepted,
          ordinal: 0,
        })
      ).report,
    ).toMatchObject({ error: 'run_canceled' });
  });

  it('stops at the suite deadline after settling the accepted case', async () => {
    const f = await fixture();
    const accepted = await database.workflowTestSuites.start(await command(f));
    const first = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    await query(
      "update app.workflow_test_suites set created_at=clock_timestamp()-interval '6 hours',deadline_at=clock_timestamp()-interval '1 second' where id=$1",
      [accepted.suiteId],
    );
    await complete(runId(first, 0), { amount: 1 });
    await due(accepted.suiteId);
    await scanner.scan(25);
    expect(
      await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).toMatchObject({
      status: 'error',
      stopReason: 'deadline_exceeded',
      passed: 1,
      skipped: 1,
    });
  });

  it('retries a full queue without accepting a duplicate or losing the completed report', async () => {
    const f = await fixture();
    const accepted = await database.workflowTestSuites.start(await command(f));
    const first = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    const previous = (
      await query<{ current_version: number }>(
        'select current_version from app.workspace_execution_entitlements where workspace_id=$1',
        [workspaceId],
      )
    )[0];
    if (previous === undefined) throw new Error('Missing entitlement');
    await query(
      'insert into app.workspace_execution_entitlement_versions(workspace_id,version,status,active_run_limit,queued_run_limit) select workspace_id,version+1,status,active_run_limit,1 from app.workspace_execution_entitlement_versions where workspace_id=$1 and version=$2',
      [workspaceId, previous.current_version],
    );
    await query(
      'update app.workspace_execution_entitlements set current_version=current_version+1 where workspace_id=$1',
      [workspaceId],
    );
    try {
      await complete(runId(first, 0), { amount: 1 });
      await due(accepted.suiteId);
      await scanner.scan(25);
      expect(
        await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
      ).toMatchObject({
        status: 'running',
        passed: 1,
        cases: [{ status: 'passed' }, { status: 'pending', runId: null }],
      });
    } finally {
      await query(
        'update app.workspace_execution_entitlements set current_version=$2 where workspace_id=$1',
        [workspaceId, previous.current_version],
      );
    }
    await due(accepted.suiteId);
    await scanner.scan(25);
    const next = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    expect(next.cases.map((entry) => entry.status)).toEqual([
      'passed',
      'running',
    ]);
    await complete(runId(next, 1), { amount: 2 });
    await due(accepted.suiteId);
    await scanner.scan(25);
    expect(
      await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).toMatchObject({ status: 'passed' });
  });
}

function registerFreezesPinsSharesExactOutput(): void {
  it('freezes pins and shares their exact output with every case after the pin is removed', async () => {
    const f = await fixture();
    const pin = await database.stepSamples.put({
      ...f.scope,
      nodeId: 'set',
      expectedDraftRevision: 1,
      expectedSampleId: null,
      idempotencyKey: randomUUID(),
      source: { kind: 'json', value: { amount: 42 } },
    });
    const accepted = await database.workflowTestSuites.start(await command(f));
    const first = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    await database.stepSamples.remove({
      ...f.scope,
      nodeId: 'set',
      expectedDraftRevision: 1,
      expectedSampleId: pin.sampleId,
      idempotencyKey: randomUUID(),
    });
    await complete(runId(first, 0), { amount: 42 });
    await due(accepted.suiteId);
    await scanner.scan(25);
    const next = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    const source = (
      await query<{ workflow_version_id: string }>(
        'select workflow_version_id from app.workflow_runs where id=$1',
        [runId(next, 1)],
      )
    )[0]?.workflow_version_id;
    expect(
      (
        await reader.readForExecution({
          workspaceId,
          workflowVersionId: source ?? '',
          nodeId: 'set',
        })
      )?.testSample?.output,
    ).toEqual({ amount: 42 });
    await complete(runId(next, 1), { amount: 42 });
    await due(accepted.suiteId);
    await scanner.scan(25);
    expect(
      await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).toMatchObject({ status: 'failed', failed: 2 });
  });

  it('requires ordinary failed outcomes and records unknown and timeout clearly', async () => {
    const f = await fixture(4);
    for (const record of f.records)
      await cases.updateCase({
        ...f.scope,
        caseId: record.caseId,
        expectedRevision: 1,
        name: 'Expected failure',
        input: {},
        expectations: { outcome: 'fails', assertions: [] },
        idempotencyKey: randomUUID(),
      });
    const accepted = await database.workflowTestSuites.start(await command(f));
    for (const [ordinal, status] of [
      'failed',
      'outcome_unknown',
      'timed_out',
      'succeeded',
    ].entries()) {
      const detail = await database.workflowTestSuites.get({
        ...f.scope,
        ...accepted,
      });
      await complete(runId(detail, ordinal), {}, status);
      await due(accepted.suiteId);
      await scanner.scan(25);
    }
    expect(
      await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).toMatchObject({ status: 'failed', passed: 1, errors: 2, failed: 1 });
    expect(
      (
        await database.workflowTestSuites.report({
          ...f.scope,
          ...accepted,
          ordinal: 1,
        })
      ).report,
    ).toMatchObject({ error: 'run_outcome_unknown', outcomeMatched: false });
    expect(
      (
        await database.workflowTestSuites.report({
          ...f.scope,
          ...accepted,
          ordinal: 2,
        })
      ).report,
    ).toMatchObject({ error: 'run_timed_out' });
  });

  it('freezes empty and nonempty variable revisions across later cases', async () => {
    const variables = createWorkspaceVariablesStore(config());
    try {
      for (const populated of [false, true]) {
        const f = await fixture();
        const current = await variables.read({ workspaceId, actorId });
        if (populated)
          await variables.replace({
            workspaceId,
            actorId,
            expectedRevision: current.revision,
            values: { RATE: 1 },
            idempotencyKey: randomUUID(),
          });
        const accepted = await database.workflowTestSuites.start(
          await command(f),
        );
        const first = await database.workflowTestSuites.get({
          ...f.scope,
          ...accepted,
        });
        const before = (
          await query<{ variable_set_revision: number | null }>(
            'select variable_set_revision from app.workflow_runs where id=$1',
            [runId(first, 0)],
          )
        )[0]?.variable_set_revision;
        const head = await variables.read({ workspaceId, actorId });
        await variables.replace({
          workspaceId,
          actorId,
          expectedRevision: head.revision,
          values: { RATE: 2 },
          idempotencyKey: randomUUID(),
        });
        await complete(runId(first, 0), { amount: 1 });
        await due(accepted.suiteId);
        await scanner.scan(25);
        const second = await database.workflowTestSuites.get({
          ...f.scope,
          ...accepted,
        });
        expect(
          (
            await query<{ variable_set_revision: number | null }>(
              'select variable_set_revision from app.workflow_runs where id=$1',
              [runId(second, 1)],
            )
          )[0]?.variable_set_revision,
        ).toBe(before);
        expect(populated ? before !== null : before === null).toBe(true);
        await complete(runId(second, 1), { amount: 2 });
        await due(accepted.suiteId);
        await scanner.scan(25);
      }
    } finally {
      await variables.close();
    }
  });

  it('stops future admissions when the starter loses authority', async () => {
    const f = await fixture(),
      accepted = await database.workflowTestSuites.start(await command(f)),
      first = await database.workflowTestSuites.get({
        ...f.scope,
        ...accepted,
      });
    try {
      await query(
        "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
        [workspaceId, actorId],
      );
      await expect(
        database.workflowTestSuites.get({ ...f.scope, ...accepted }),
      ).rejects.toThrow();
      await complete(runId(first, 0), { amount: 1 });
      await due(accepted.suiteId);
      await scanner.scan(25);
    } finally {
      await query(
        "update app.workspace_memberships set status='active' where workspace_id=$1 and user_id=$2",
        [workspaceId, actorId],
      );
    }
    expect(
      await database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).toMatchObject({
      status: 'error',
      stopReason: 'authority_lost',
      passed: 1,
      skipped: 1,
      cases: [{ status: 'passed' }, { status: 'skipped', runId: null }],
    });
  });
}

function registerKeepsSharedSourceFirstRun(): void {
  it('keeps a shared source when its first run expires and purges it after the last reference', async () => {
    const f = await fixture();
    const accepted = await database.workflowTestSuites.start(await command(f));
    const first = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    const initial = runId(first, 0);
    await complete(initial, { amount: 1 });
    await due(accepted.suiteId);
    await scanner.scan(25);
    const second = await database.workflowTestSuites.get({
      ...f.scope,
      ...accepted,
    });
    const last = runId(second, 1);
    await complete(last, { amount: 2 });
    await due(accepted.suiteId);
    await scanner.scan(25);
    const source = (
      await query<{ workflow_version_id: string }>(
        'select workflow_version_id from app.workflow_runs where id=$1',
        [last],
      )
    )[0]?.workflow_version_id;
    await query(
      "update app.workflow_runs set created_at=clock_timestamp()-interval '8 days',completed_at=clock_timestamp()-interval '8 days',input_ref_expires_at=clock_timestamp()-interval '1 day' where id=$1",
      [initial],
    );
    await enforceTestRetention(2);
    expect(
      await reader.readForExecution({
        workspaceId,
        workflowVersionId: source ?? '',
      }),
    ).not.toBeNull();
    expect(
      (await database.workflowTests.list(f.scope)).items.map(
        (entry) => entry.runId,
      ),
    ).toEqual([last]);
    await query(
      "update app.workflow_runs set created_at=clock_timestamp()-interval '8 days',completed_at=clock_timestamp()-interval '8 days',input_ref_expires_at=clock_timestamp()-interval '1 day' where id=$1",
      [last],
    );
    await query(
      "update app.workflow_test_suites set created_at=clock_timestamp()-interval '9 days',deadline_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 day' where id=$1",
      [accepted.suiteId],
    );
    await query(
      "update app.workflow_test_snapshots set expires_at=clock_timestamp()-interval '1 day' where id=$1",
      [source],
    );
    await expect(
      database.workflowTestSuites.get({ ...f.scope, ...accepted }),
    ).rejects.toMatchObject({ reason: 'not_found' });
    await enforceTestRetention(2);
    expect(
      await reader.readForExecution({
        workspaceId,
        workflowVersionId: source ?? '',
      }),
    ).toBeNull();
  });

  it('checks one successful step invocation, missing paths, truncated actuals and repeated-step ambiguity', async () => {
    const f = await fixture(1);
    const record = f.records[0];
    if (record === undefined) throw new Error('Missing case');
    await cases.updateCase({
      ...f.scope,
      caseId: record.caseId,
      expectedRevision: 1,
      name: 'Step checks',
      input: {},
      expectations: {
        outcome: 'succeeds',
        assertions: [
          {
            source: { kind: 'step', nodeId: 'set' },
            path: '$.amount',
            operator: 'equals',
            expected: 1,
          },
          {
            source: { kind: 'final' },
            path: '$.missing',
            operator: 'equals',
            expected: null,
          },
          {
            source: { kind: 'final' },
            path: '$.long',
            operator: 'contains',
            expected: 'thread',
          },
        ],
      },
      idempotencyKey: randomUUID(),
    });
    const accepted = await database.workflowTestSuites.start(await command(f)),
      detail = await database.workflowTestSuites.get({
        ...f.scope,
        ...accepted,
      }),
      id = runId(detail, 0);
    for (const invocation of ['first', 'second'])
      await query(
        "insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,status,side_effect_class,output_ref) values($1,$2,$3,'set',$4,'succeeded','safe',$5::jsonb)",
        [
          randomUUID(),
          workspaceId,
          id,
          invocation,
          serializeStoredExecutionValue({
            kind: 'inline',
            value: { amount: 1 },
          }),
        ],
      );
    await complete(id, { long: 'thread'.repeat(1500) });
    await due(accepted.suiteId);
    await scanner.scan(25);
    expect(
      (
        await database.workflowTestSuites.report({
          ...f.scope,
          ...accepted,
          ordinal: 0,
        })
      ).report,
    ).toMatchObject({
      assertions: [
        { actual: { state: 'ambiguous', matched: false } },
        { actual: { state: 'missing', matched: false } },
        {
          actual: {
            state: 'value',
            matched: true,
            truncated: true,
            bytes: 9002,
          },
        },
      ],
    });
  });

  it('purges suites and their copied case values with the workspace', async () => {
    const steps = await purgeTestWorkspace(workspaceId, { pageSize: 2 });
    expect(steps).toContain('workflow_test_suites');
    expect(
      await query(
        'select suite_id from app.workflow_test_suite_cases where workspace_id=$1',
        [workspaceId],
      ),
    ).toEqual([]);
    expect(
      await query(
        'select id from app.workflow_test_snapshots where workspace_id=$1',
        [workspaceId],
      ),
    ).toEqual([]);
  }, 30000);
}

async function beforeAllFixture1() {
  database = createWorkflowAuthoringDatabase(config(), {
    executableCompiler: (graph) => {
      const executable = buildWorkflowExecutable({ graph, catalog });
      return {
        checksum: executable.checksum,
        executableJson: executable.envelope,
      };
    },
    workflowTestCompiler: (graph, pins) =>
      buildWorkflowTestExecutable({ graph, pins, catalog }),
  });
  cases = createWorkflowInputCaseDatabase(config());
  scanner = await createWorkflowTestSuiteScanner(config(), maintenance());
  reader = createWorkflowExecutionReader(config());
}

function afterAllFixture2() {
  return Promise.all([
    database.close(),
    cases.close(),
    scanner.close(),
    reader.close(),
  ]);
}

async function restartSuiteScanner(): Promise<void> {
  await scanner.close();
  scanner = await createWorkflowTestSuiteScanner(config(), maintenance());
}
