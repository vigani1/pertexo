import type { z } from 'zod';
import { createWorkflowRunDatabase } from '../../../src/runs/runs.repository.js';
import { RunRequiresFormError } from '../../../src/runs/commands/forms.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
} from '@pertexo/workflow-engine';
import {
  formConfigSchema,
  FormValuesInvalidError,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import { createFormStore } from '../../../src/triggers/forms/store.js';
import {
  FormUnavailableError,
  FormChangedError,
  FormAccessConflictError,
} from '../../../src/triggers/forms/contract.js';
import { parseDatabaseConfig } from '../../../src/config.js';
import { admin, createFamily } from '../../lifecycle/calls/fixtures.js';
import {
  adminUrl,
  apiUrl,
  userId,
  withDatabase,
} from '../../lifecycle/retention.support.js';
let store: ReturnType<typeof createFormStore>;
async function submitForm(...args: Parameters<typeof store.submit>) {
  const result = await store.submit(...args);
  if (!result.accepted)
    throw new Error('Expected an accepted form in this journey');
  return result;
}
beforeAll(() => {
  store = createFormStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
    (version) => ({
      checkpoint: createCheckpoint({
        workflowVersionId: version.id,
        iterationBudget: 200,
        nextEventSequence: 2,
      }),
    }),
  );
});
afterAll(() => store.close());
async function fixture(config: z.input<typeof formConfigSchema> = {}) {
  const family = await createFamily({ childDays: 0, consumed: true });
  const workflowId = randomUUID(),
    versionId = randomUUID(),
    viewerId = randomUUID();
  await admin.query(
    `insert into app.users(id,email,display_name) values($1,$2,'Form responder')`,
    [viewerId, `${viewerId}@example.test`],
  );
  for (const [actor, role] of [
    [userId, 'owner'],
    [viewerId, 'viewer'],
  ])
    await admin.query(
      `insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')`,
      [family.workspaceId, actor, role],
    );
  const node = (id: string, key: string) => ({
    id,
    definition: { key, version: 1 },
    configVersion: 1,
    config: {},
    position: { x: 0, y: 0 },
    inputMappings: {},
    connectionRefs: {},
  });
  const graph: WorkflowGraph = {
    settings: {},
    nodes: [
      {
        ...node('form', 'core.form'),
        config: formConfigSchema.parse({
          fields: [
            {
              id: 'amount-field',
              name: 'amount',
              label: 'Amount',
              type: 'number',
            },
            {
              id: 'message-field',
              name: 'message',
              label: 'Message',
              type: 'text',
              required: false,
            },
          ],
          ...config,
        }),
      },
      node('finish', 'core.terminate'),
    ],
    edges: [
      {
        id: 'end',
        source: { nodeId: 'form', port: 'out' },
        target: { nodeId: 'finish', port: 'in' },
      },
    ],
  };
  const compiled = buildWorkflowExecutable({
    graph,
    catalog: composeExecutableCatalog(CORE_NODE_CATALOG),
  });
  await admin.query(
    `insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Form proof',$3)`,
    [workflowId, family.workspaceId, userId],
  );
  await admin.query(
    `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by) values($1,$2,$3,1,$4::jsonb,$5::jsonb,$6,$7)`,
    [
      versionId,
      family.workspaceId,
      workflowId,
      JSON.stringify(graph),
      JSON.stringify(compiled.envelope),
      compiled.checksum,
      userId,
    ],
  );
  await admin.query(
    `update app.workflows set published_version_id=$2 where id=$1`,
    [workflowId, versionId],
  );
  return {
    workspaceId: family.workspaceId,
    workflowId,
    versionId,
    viewerId,
    actorId: userId,
  };
}
/** Stores, without publishing, a second version with a changed Form config. */
async function insertFormRevision(
  f: Readonly<{ workspaceId: string; workflowId: string; versionId: string }>,
  config: Readonly<Record<string, string>>,
): Promise<string> {
  const row = await admin.query<{ graph_json: WorkflowGraph }>(
    'select graph_json from app.workflow_versions where id=$1',
    [f.versionId],
  );
  const previous = row.rows[0]?.graph_json;
  if (previous === undefined) throw new Error('Missing graph');
  const graph: WorkflowGraph = {
    ...previous,
    nodes: previous.nodes.map((node) =>
      node.id === 'form'
        ? { ...node, config: { ...node.config, ...config } }
        : node,
    ),
  };
  const compiled = buildWorkflowExecutable({
    graph,
    catalog: composeExecutableCatalog(CORE_NODE_CATALOG),
  });
  const versionId = randomUUID();
  await admin.query(
    `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by) values($1,$2,$3,2,$4::jsonb,$5::jsonb,$6,$7)`,
    [
      versionId,
      f.workspaceId,
      f.workflowId,
      JSON.stringify(graph),
      JSON.stringify(compiled.envelope),
      compiled.checksum,
      userId,
    ],
  );
  return versionId;
}
it('admits a member form once with trusted starter and output metadata, without granting arbitrary start access', async () => {
  const f = await fixture();
  const scope = { ...f, actorId: f.viewerId };
  const shown = await store.read(scope);
  expect(shown.versionId).toBe(f.versionId);
  const command = {
    ...scope,
    versionId: f.versionId,
    values: { amount: 0, message: ' ' },
    idempotencyKey: 'member',
  };
  const first = await submitForm(command);
  const again = await submitForm(command);
  expect(again).toEqual({ ...first, replayed: true });
  const row = await admin.query(
    `select trigger_type,started_by,input_ref from app.workflow_runs where id=$1`,
    [first.runId],
  );
  expect(row.rows[0]).toMatchObject({
    trigger_type: 'form',
    started_by: f.viewerId,
    input_ref: {
      kind: 'inline',
      value: {
        values: { amount: 0 },
        submittedBy: f.viewerId,
        submittedAt: expect.any(String) as unknown,
      },
    },
  });
  expect(
    (
      await admin.query(
        `select id from app.outbox_events where aggregate_id=$1 and job_name='advance-workflow-run'`,
        [first.runId],
      )
    ).rowCount,
  ).toBe(1);
});
it('keeps public keys out of receipts and audit; rotates and disables them immediately', async () => {
  const f = await fixture();
  const capability = randomBytes(32).toString('base64url');
  const access = await store.setAccess({
    ...f,
    access: 'public',
    expectedRevision: 0,
    capability,
    idempotencyKey: 'enable',
  });
  expect(access.access).toBe('public');
  if (access.publicId === null) throw new Error('Public identity missing');
  const grant = await store.discover({ publicId: access.publicId, capability });
  const { versionId } = await store.read(
    { workspaceId: f.workspaceId, workflowId: f.workflowId },
    grant,
  );
  const submitted = await submitForm(
    {
      workspaceId: f.workspaceId,
      workflowId: f.workflowId,
      versionId,
      values: { amount: 12 },
      idempotencyKey: 'public',
    },
    grant,
  );
  expect(submitted).toEqual({
    accepted: true,
    replayed: false,
    thankYouMessage: 'Thanks for your response.',
  });
  const run = await admin.query(
    `select started_by,input_ref from app.workflow_runs where workspace_id=$1 and workflow_id=$2`,
    [f.workspaceId, f.workflowId],
  );
  expect(run.rows).toHaveLength(1);
  expect(run.rows[0]).toMatchObject({
    started_by: null,
    input_ref: { value: { submittedBy: null } },
  });
  const receipt = await admin.query(
    `select result_ref from app.idempotency_records where workspace_id=$1`,
    [f.workspaceId],
  );
  const audit = await admin.query(
    `select metadata from app.audit_events where workspace_id=$1`,
    [f.workspaceId],
  );
  expect(
    JSON.stringify({ receipt: receipt.rows, audit: audit.rows }),
  ).not.toContain(capability);
  const nextCapability = randomBytes(32).toString('base64url');
  const rotated = await store.setAccess({
    ...f,
    access: 'public',
    expectedRevision: access.revision,
    capability: nextCapability,
    idempotencyKey: 'rotate',
  });
  await expect(
    store.discover({ publicId: access.publicId, capability }),
  ).rejects.toBeInstanceOf(FormUnavailableError);
  await expect(
    submitForm(
      {
        workspaceId: f.workspaceId,
        workflowId: f.workflowId,
        versionId,
        values: { amount: 1 },
        idempotencyKey: 'stale-grant',
      },
      grant,
    ),
  ).rejects.toBeInstanceOf(FormUnavailableError);
  await store.setAccess({
    ...f,
    access: 'members',
    expectedRevision: rotated.revision,
    idempotencyKey: 'off',
  });
  await expect(
    store.discover({ publicId: access.publicId, capability: nextCapability }),
  ).rejects.toBeInstanceOf(FormUnavailableError);
});
it('rejects invalid values, stale versions and competing access writes without admitting a run', async () => {
  const f = await fixture();
  await expect(
    submitForm({
      ...f,
      versionId: f.versionId,
      values: { amount: '12' },
      idempotencyKey: 'bad',
    }),
  ).rejects.toBeInstanceOf(FormValuesInvalidError);
  await expect(
    submitForm({
      ...f,
      versionId: randomUUID(),
      values: { amount: 12 },
      idempotencyKey: 'stale',
    }),
  ).rejects.toBeInstanceOf(FormChangedError);
  const capability = randomBytes(32).toString('base64url');
  const results = await Promise.allSettled(
    [0, 1].map((n) =>
      store.setAccess({
        ...f,
        access: 'public',
        capability,
        expectedRevision: 0,
        idempotencyKey: `race-${String(n)}`,
      }),
    ),
  );
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((x) => x.status === 'rejected')).toMatchObject([
    { reason: expect.any(FormAccessConflictError) as unknown },
  ]);
  expect(
    (
      await admin.query(
        `select id from app.workflow_runs where workspace_id=$1 and workflow_id=$2`,
        [f.workspaceId, f.workflowId],
      )
    ).rowCount,
  ).toBe(0);
});

it('rechecks current membership and workspace scope for every member response', async () => {
  const f = await fixture(),
    foreign = await fixture();
  await expect(
    store.read({ ...f, workflowId: foreign.workflowId, actorId: f.viewerId }),
  ).rejects.toBeInstanceOf(FormUnavailableError);
  await admin.query(
    "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
    [f.workspaceId, f.viewerId],
  );
  await expect(
    submitForm({
      ...f,
      actorId: f.viewerId,
      versionId: f.versionId,
      values: { amount: 1 },
      idempotencyKey: 'removed',
    }),
  ).rejects.toThrow();
  expect(
    (
      await admin.query(
        'select id from app.workflow_runs where workflow_id=$1',
        [f.workflowId],
      )
    ).rowCount,
  ).toBe(0);
});
it('linearizes duplicate form submissions and rejects forged or changed command input', async () => {
  const f = await fixture();
  const command = {
    ...f,
    versionId: f.versionId,
    values: { amount: 1 },
    idempotencyKey: 'race',
  };
  const responses = await Promise.all([
    submitForm(command),
    submitForm(command),
  ]);
  expect(new Set(responses.map((x) => x.runId)).size).toBe(1);
  expect(responses.filter((x) => x.replayed)).toHaveLength(1);
  await expect(
    submitForm({ ...command, values: { amount: 2 } }),
  ).rejects.toThrow(/idempotency/iu);
  await expect(
    submitForm({
      ...command,
      idempotencyKey: 'forge',
      values: { amount: 1, submittedBy: f.viewerId },
    }),
  ).rejects.toBeInstanceOf(FormValuesInvalidError);
});
it('revokes a public grant when publication replaces the form entry, and never revives its key', async () => {
  const f = await fixture();
  const capability = randomBytes(32).toString('base64url');
  const access = await store.setAccess({
    ...f,
    access: 'public',
    expectedRevision: 0,
    capability,
    idempotencyKey: 'enable',
  });
  if (access.publicId === null) throw new Error('Missing public identity');
  const { revokeRemovedFormAccess } =
    await import('../../../src/triggers/forms/publication.js');
  const client = admin;
  try {
    await client.query('begin');
    await client.query('select id from app.workflows where id=$1 for update', [
      f.workflowId,
    ]);
    await revokeRemovedFormAccess(client, f.workspaceId, f.workflowId, {
      settings: {},
      nodes: [],
      edges: [],
    });
    await client.query('commit');
  } finally {
    await client.query('rollback');
  }
  await expect(
    store.discover({ publicId: access.publicId, capability }),
  ).rejects.toBeInstanceOf(FormUnavailableError);
  expect(await store.access(f)).toMatchObject({
    access: 'members',
    revision: 2,
  });
});

it('keeps the accepted receipt and message through republication but refuses a new response from the old schema', async () => {
  const f = await fixture({
    thankYouMessage: 'Original acceptance.',
    redirectUrl: 'https://example.test/original',
  });
  const command = {
    ...f,
    versionId: f.versionId,
    values: { amount: 1 },
    idempotencyKey: 'before-publication',
  };
  const accepted = await submitForm(command);
  expect(accepted.thankYouMessage).toBe('Original acceptance.');
  expect(accepted.redirectUrl).toBe('https://example.test/original');
  const versionId = await insertFormRevision(f, {
    title: 'A newer form',
    thankYouMessage: 'A newer message.',
    redirectUrl: 'https://example.test/newer',
  });
  await admin.query(
    'update app.workflows set published_version_id=$2 where id=$1',
    [f.workflowId, versionId],
  );
  expect(await submitForm(command)).toEqual({ ...accepted, replayed: true });
  await expect(
    submitForm({ ...command, idempotencyKey: 'new-stale-response' }),
  ).rejects.toBeInstanceOf(FormChangedError);
  const shown = await store.read(f);
  expect(shown).toMatchObject({ versionId, form: { title: 'A newer form' } });
  expect(shown.form).not.toHaveProperty('thankYouMessage');
  expect(shown.form).not.toHaveProperty('redirectUrl');
});

it('reports a changed form, not an unavailable one, when publication commits while a response waits for its lock', async () => {
  const f = await fixture();
  const versionId = await insertFormRevision(f, {
    title: 'A republished form',
  });
  const publisher = new Client({ connectionString: withDatabase(adminUrl) });
  await publisher.connect();
  let response: Promise<unknown> | undefined;
  try {
    await publisher.query('begin');
    await publisher.query(
      'update app.workflows set published_version_id=$2 where id=$1',
      [f.workflowId, versionId],
    );
    response = submitForm({
      ...f,
      versionId: f.versionId,
      values: { amount: 1 },
      idempotencyKey: 'waits-for-publication',
    });
    const refused = expect(response).rejects.toBeInstanceOf(FormChangedError);
    await vi.waitFor(
      async () => {
        const waiting = await admin.query<{ count: number }>(
          "select count(*)::int count from pg_stat_activity where datname=current_database() and usename='pertexo_app' and wait_event_type='Lock'",
        );
        expect(waiting.rows[0]?.count).toBeGreaterThanOrEqual(1);
      },
      { timeout: 3000 },
    );
    await publisher.query('commit');
    await refused;
  } finally {
    await publisher.query('rollback').catch(() => undefined);
    await response?.catch(() => undefined);
    await publisher.end();
  }
});

it('replays only the exact captured Form submission and refuses invented metadata', async () => {
  const f = await fixture();
  const submitted = await submitForm({
    ...f,
    versionId: f.versionId,
    values: { amount: 1 },
    idempotencyKey: 'original',
  });
  if (submitted.runId === undefined) throw new Error('Missing member run');
  await admin.query(
    "update app.workflow_runs set status='failed',completed_at=clock_timestamp() where id=$1",
    [submitted.runId],
  );
  const source = await admin.query<{
    input_ref: { kind: 'inline'; value: Record<string, unknown> };
  }>('select input_ref from app.workflow_runs where id=$1', [submitted.runId]);
  const input = source.rows[0]?.input_ref.value;
  if (input === undefined) throw new Error('Missing input');
  const runs = createWorkflowRunDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  );
  try {
    const command = {
      workspaceId: f.workspaceId,
      sourceRunId: submitted.runId,
      workflowVersionId: f.versionId,
      actorId: userId,
      input,
      scope: `workflow:${f.workflowId}:replay`,
      idempotencyKeyHash: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      checkpointFactory: (version: { id: string }) => ({
        checkpoint: createCheckpoint({
          workflowVersionId: version.id,
          iterationBudget: 200,
          nextEventSequence: 2,
        }),
      }),
    };
    const replay = await runs.replay(command);
    expect(replay.run.triggerType).toBe('replay');
    await expect(
      runs.replay({
        ...command,
        idempotencyKeyHash: 'c'.repeat(64),
        requestHash: 'd'.repeat(64),
        input: { ...input, submittedBy: f.viewerId },
      }),
    ).rejects.toBeInstanceOf(RunRequiresFormError);
    await admin.query(
      "update app.workflow_runs set created_at=clock_timestamp()-interval '31 days',input_ref_expires_at=clock_timestamp()-interval '2 days' where id=$1",
      [submitted.runId],
    );
    await expect(
      runs.replay({
        ...command,
        idempotencyKeyHash: 'e'.repeat(64),
        requestHash: 'f'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(RunRequiresFormError);
  } finally {
    await runs.close();
  }
});

it('admits typed multiple choices once and refuses malformed choices before admission', async () => {
  const f = await fixture({
    fields: [
      {
        id: 'channels',
        name: 'channels',
        label: 'Channels',
        type: 'multi_select',
        options: ['Email', 'SMS'],
      },
    ],
  });
  const command = {
    ...f,
    versionId: f.versionId,
    idempotencyKey: 'choices',
    values: { channels: ['SMS', 'Email'] },
  };
  const accepted = await submitForm(command);
  expect(accepted.thankYouMessage).toBe('Thanks for your response.');
  expect(
    (
      await admin.query('select input_ref from app.workflow_runs where id=$1', [
        accepted.runId,
      ])
    ).rows[0],
  ).toMatchObject({ input_ref: { value: { values: command.values } } });
  for (const channels of [[], ['Email', 'Email'], ['Other'], 'Email'])
    await expect(
      submitForm({
        ...command,
        idempotencyKey: randomUUID(),
        values: { channels },
      }),
    ).rejects.toBeInstanceOf(FormValuesInvalidError);
  expect(
    (
      await admin.query(
        'select count(*)::int n from app.workflow_runs where workflow_id=$1',
        [f.workflowId],
      )
    ).rows,
  ).toEqual([{ n: 1 }]);
});

it.each(['member', 'public'] as const)(
  'records an idempotent %s busy receipt, without a run, and accepts a fresh response after release',
  async (accessKind) => {
    const f = await fixture();
    let grant;
    if (accessKind === 'public') {
      const capability = randomBytes(32).toString('base64url');
      const access = await store.setAccess({
        ...f,
        access: 'public',
        expectedRevision: 0,
        capability,
        idempotencyKey: 'skip-public-access',
      });
      if (access.publicId === null) throw new Error('Public form missing');
      grant = await store.discover({ publicId: access.publicId, capability });
    }
    await admin.query(
      `insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit,overflow) values($1,$2,1,'skip')`,
      [f.workspaceId, f.workflowId],
    );
    const command = {
      workspaceId: f.workspaceId,
      workflowId: f.workflowId,
      versionId: f.versionId,
      ...(grant === undefined ? { actorId: f.viewerId } : {}),
      values: { amount: 20 },
      idempotencyKey: 'skip-first',
    };
    const first = await store.submit(command, grant);
    expect(first.accepted).toBe(true);
    const busy = { ...command, idempotencyKey: 'skip-busy' };
    expect(await store.submit(busy, grant)).toEqual({
      accepted: false,
      skipped: true,
      reason: 'concurrency_limit',
      replayed: false,
    });
    expect(await store.submit(busy, grant)).toEqual({
      accepted: false,
      skipped: true,
      reason: 'concurrency_limit',
      replayed: true,
    });
    const count = () =>
      admin.query(
        `select (select count(*)::int from app.workflow_runs where workflow_id=$1) runs,(select count(*)::int from app.usage_events where resource_id=$1 and category='trigger.skipped') skips,(select count(*)::int from app.idempotency_records where workspace_id=$2 and status='in_progress') incomplete`,
        [f.workflowId, f.workspaceId],
      );
    expect((await count()).rows).toEqual([
      { runs: 1, skips: 1, incomplete: 0 },
    ]);
    await admin.query(
      `update app.workflow_runs set status='canceled',completed_at=clock_timestamp() where workflow_id=$1 and status='queued'`,
      [f.workflowId],
    );
    expect((await store.submit(busy, grant)).accepted).toBe(false);
    expect(
      (await store.submit({ ...command, idempotencyKey: 'skip-next' }, grant))
        .accepted,
    ).toBe(true);
    expect((await count()).rows).toEqual([
      { runs: 2, skips: 1, incomplete: 0 },
    ]);
  },
);
