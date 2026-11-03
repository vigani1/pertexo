import { afterAll, beforeAll, expect, it, vi, describe } from 'vitest';
import {
  beforeAllFixture1,
  afterAllFixture2,
  store,
  submitForm,
  fixture,
  insertFormRevision,
} from './admission/fixture.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { FormValuesInvalidError } from '@pertexo/workflow-model';
import {
  FormUnavailableError,
  FormChangedError,
  FormAccessConflictError,
} from '../../../src/triggers/forms/errors.js';
import { admin } from '../../lifecycle/calls/fixtures.js';
import { createWorkflowRunDatabase } from '../../../src/runs/workflow-run.store.js';
import { RunRequiresFormError } from '../../../src/runs/commands/acceptance/forms.repository.js';
import { Client, Pool } from 'pg';
import { createCheckpoint } from '@pertexo/workflow-engine';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  adminUrl,
  apiUrl,
  userId,
  withDatabase,
} from '../../lifecycle/retention.support.js';
import {
  openTransaction,
  sqlStates,
  waitForWaiter,
} from '../webhooks/ingress/lock-holder.js';
import {
  newCapability,
  openPublicly,
  PAUSE_STATEMENT,
  response,
  runs,
  closeWorkspace,
  addMember,
  type Form,
} from './admission/door-support.js';
import { createWorkflowFolderStore } from '../../../src/authoring/organization/folders/workflow-folder.store.js';

const ADMISSION_LOCK = /lock_workspace_run_admission/iu;

const LINK_LOCK = /for share of "form"/iu;

const WORKFLOW_LOCK = /for share of "workflow"/iu;

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
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
  const grant = await store.discover({
    publicId: access.publicId,
    capability,
  });
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
  ).rejects.toBeInstanceOf(FormUnavailableError);
  expect(
    (
      await admin.query(
        'select id from app.workflow_runs where workflow_id=$1',
        [f.workflowId],
      )
    ).rowCount,
  ).toBe(0);
});

it('keeps the public identity and exact access receipt across disable and re-enable', async () => {
  const f = await fixture();
  const firstCapability = randomBytes(32).toString('base64url');
  const firstCommand = {
    ...f,
    access: 'public' as const,
    expectedRevision: 0,
    capability: firstCapability,
    idempotencyKey: 'initial-access',
  };
  const initial = await store.setAccess(firstCommand);
  expect(initial).toEqual({
    access: 'public',
    publicId: expect.any(String) as unknown,
    revision: 1,
  });
  const disabled = await store.setAccess({
    ...f,
    access: 'members',
    expectedRevision: initial.revision,
    idempotencyKey: 'disable-access',
  });
  expect(disabled).toEqual({
    access: 'members',
    publicId: initial.publicId,
    revision: 2,
  });
  const secondCapability = randomBytes(32).toString('base64url');
  const enabled = await store.setAccess({
    ...f,
    access: 'public',
    expectedRevision: disabled.revision,
    capability: secondCapability,
    idempotencyKey: 'enable-access',
  });
  expect(enabled).toEqual({
    access: 'public',
    publicId: initial.publicId,
    revision: 3,
  });
  await expect(store.setAccess(firstCommand)).resolves.toEqual(initial);
  await expect(store.access(f)).resolves.toEqual(enabled);
  if (initial.publicId === null)
    throw new Error('Public identity is unavailable');
  await expect(
    store.discover({
      publicId: initial.publicId,
      capability: firstCapability,
    }),
  ).rejects.toBeInstanceOf(FormUnavailableError);
  await expect(
    store.discover({
      publicId: initial.publicId,
      capability: secondCapability,
    }),
  ).resolves.toMatchObject({
    workspaceId: f.workspaceId,
    workflowId: f.workflowId,
    publicId: initial.publicId,
  });
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
    await import('../../../src/triggers/forms/publication.repository.js');
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
let holders: Pool;

const hold = (workspaceId: string) =>
  openTransaction(holders, holders, workspaceId, { role: undefined });

beforeAll(() => {
  holders = new Pool({
    connectionString: withDatabase(adminUrl),
    max: 4,
  });
});

afterAll(() => holders.end());

describe('a form submission’s lock order', () => {
  const holdEntitlement = async (f: Form) => {
    const holder = await hold(f.workspaceId);
    await holder.query(
      'select 1 from app.workspace_execution_entitlements where workspace_id=$1 for update',
      [f.workspaceId],
    );
    return holder;
  };

  it('checks a member’s authority after the admission lock, so a removal during the wait refuses', async () => {
    const f = await fixture();
    const holder = await holdEntitlement(f);
    try {
      const waiting = submitForm({
        ...response(f),
        actorId: f.viewerId,
      });
      const refusal =
        expect(waiting).rejects.toBeInstanceOf(FormUnavailableError);
      await waitForWaiter(holder, ADMISSION_LOCK);
      // It holds no lock on the membership yet, so this doesn't have to wait for it.
      await admin.query(
        "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
        [f.workspaceId, f.viewerId],
      );
      await holder.commit();
      await refusal;
      expect(await runs(f)).toBe(0);
    } finally {
      await holder.rollback();
    }
  }, 30_000);

  it('checks a public link after the admission lock, so a regeneration during the wait refuses', async () => {
    const f = await fixture();
    const { grant, access } = await openPublicly(f);
    const holder = await holdEntitlement(f);
    try {
      const waiting = submitForm(response(f), grant);
      const refusal =
        expect(waiting).rejects.toBeInstanceOf(FormUnavailableError);
      await waitForWaiter(holder, ADMISSION_LOCK);
      await store.setAccess({
        ...f,
        access: 'public',
        expectedRevision: access.revision,
        capability: newCapability(),
        idempotencyKey: randomUUID(),
      });
      await holder.commit();
      await refusal;
      expect(await runs(f)).toBe(0);
    } finally {
      await holder.rollback();
    }
  }, 30_000);

  it.each([
    ['commits', true],
    ['rolls back', false],
  ] as const)(
    'orders a response against a link regeneration that %s while it waits on the form row',
    async (_name, commits) => {
      const f = await fixture();
      const { grant } = await openPublicly(f);
      const holder = await hold(f.workspaceId);
      try {
        await holder.query(
          `update app.workflow_forms set capability_hash=$2,revision=revision+1
              where workflow_id=$1`,
          [f.workflowId, 'f'.repeat(64)],
        );
        const waiting = submitForm(response(f), grant);
        const settled = waiting.then(
          () => 'accepted',
          (error: unknown) => error,
        );
        await waitForWaiter(holder, LINK_LOCK);
        if (commits) {
          await holder.commit();
          expect(await settled).toBeInstanceOf(FormUnavailableError);
          expect(await runs(f)).toBe(0);
        } else {
          await holder.rollback();
          expect(await settled).toBe('accepted');
          expect(await runs(f)).toBe(1);
        }
      } finally {
        await holder.rollback();
      }
    },
    30_000,
  );

  it.each([
    [
      'an archive',
      "update app.workflows set lifecycle_status='archived' where id=$1",
    ],
    ['a pause', PAUSE_STATEMENT],
  ])(
    'refuses a response waiting on the workflow row while %s commits',
    async (_name, statement) => {
      const f = await fixture();
      const { grant } = await openPublicly(f);
      await submitForm(response(f), grant);
      const before = await runs(f);
      const holder = await hold(f.workspaceId);
      try {
        await holder.query(statement, [f.workflowId]);
        const refusal = expect(
          submitForm(response(f), grant),
        ).rejects.toBeInstanceOf(FormUnavailableError);
        await waitForWaiter(holder, WORKFLOW_LOCK);
        await holder.commit();
        await refusal;
        expect(await runs(f)).toBe(before);
      } finally {
        await holder.rollback();
      }
    },
    30_000,
  );

  it('never deadlocks with link changes, and a response is accepted or refused by name', async () => {
    const f = await fixture();
    const opened = await openPublicly(f);
    let revision = opened.access.revision;
    for (let round = 0; round < 8; round += 1) {
      const outcomes = await Promise.allSettled([
        submitForm(response(f), opened.grant),
        store.setAccess({
          ...f,
          access: 'public',
          expectedRevision: revision,
          capability: opened.capability,
          idempotencyKey: randomUUID(),
        }),
        submitForm(response(f), opened.grant),
      ]);
      const change = outcomes[1];
      if (change.status === 'fulfilled') ({ revision } = change.value);
      expect(
        outcomes.flatMap((outcome) =>
          outcome.status === 'rejected' ? sqlStates(outcome.reason) : [],
        ),
      ).not.toContain('40P01');
    }
  }, 60_000);
});
describe('a public link', () => {
  it('refuses every wrong capability in the same words', async () => {
    const f = await fixture();
    const other = await fixture();
    const { capability, publicId, access } = await openPublicly(f);
    const others = await openPublicly(other);
    await store.setAccess({
      ...f,
      access: 'public',
      expectedRevision: access.revision,
      capability: newCapability(),
      idempotencyKey: randomUUID(),
    });
    const attempts = [
      { publicId, capability: newCapability() },
      { publicId, capability },
      { publicId, capability: others.capability },
      { publicId: randomUUID(), capability: others.capability },
      { publicId: randomUUID(), capability: newCapability() },
    ];
    const refusals = await Promise.all(
      attempts.map((attempt) =>
        store.discover(attempt).then(
          () => {
            throw new Error('A wrong capability opened a form');
          },
          (error: unknown) => error,
        ),
      ),
    );
    for (const refusal of refusals)
      expect(refusal).toBeInstanceOf(FormUnavailableError);
    expect(
      new Set(refusals.map((refusal) => (refusal as Error).message)).size,
    ).toBe(1);
  });

  it('gives another form’s grant nothing here, for reading or submitting', async () => {
    const f = await fixture();
    const other = await fixture();
    await openPublicly(f);
    const { grant: otherGrant } = await openPublicly(other);
    await expect(
      store.read(
        { workspaceId: f.workspaceId, workflowId: f.workflowId },
        otherGrant,
      ),
    ).rejects.toBeInstanceOf(FormUnavailableError);
    await expect(submitForm(response(f), otherGrant)).rejects.toBeInstanceOf(
      FormUnavailableError,
    );
    // The other form's identity with this workflow named on it isn't this form's link.
    await expect(
      submitForm(response(f), {
        ...otherGrant,
        workspaceId: f.workspaceId,
        workflowId: f.workflowId,
      }),
    ).rejects.toBeInstanceOf(FormUnavailableError);
    expect(await runs(f)).toBe(0);
  });

  it('refuses a grant naming another step of the same form', async () => {
    const f = await fixture();
    const { grant } = await openPublicly(f);
    await expect(
      submitForm(response(f), { ...grant, nodeId: 'finish' }),
    ).rejects.toBeInstanceOf(FormUnavailableError);
    expect(await runs(f)).toBe(0);
  });

  it.each([
    ['a suspended workspace', closeWorkspace.suspended],
    ['a workspace pending deletion', closeWorkspace.pending_deletion],
    [
      'a paused workflow',
      ({ workflowId }: Form) => admin.query(PAUSE_STATEMENT, [workflowId]),
    ],
    [
      'an archived workflow',
      ({ workflowId }: Form) =>
        admin.query(
          "update app.workflows set lifecycle_status='archived' where id=$1",
          [workflowId],
        ),
    ],
  ])(
    'reads and takes nothing on %s, and reveals which by nothing',
    async (_name, close) => {
      const f = await fixture();
      const { grant } = await openPublicly(f);
      await submitForm(response(f), grant);
      const before = await runs(f);
      const scope = { workspaceId: f.workspaceId, workflowId: f.workflowId };
      const wrong = await store
        .read(scope, { ...grant, capabilityHash: 'e'.repeat(64) })
        .catch((error: unknown) => error);
      await close(f);
      const read = await store
        .read(scope, grant)
        .catch((error: unknown) => error);
      expect(read).toBeInstanceOf(FormUnavailableError);
      expect((read as Error).message).toBe((wrong as Error).message);
      await expect(submitForm(response(f), grant)).rejects.toBeInstanceOf(
        FormUnavailableError,
      );
      expect(await runs(f)).toBe(before);
    },
  );

  it('starts one run for an exact retry racing itself, and conflicts on different values', async () => {
    const f = await fixture();
    const { grant } = await openPublicly(f);
    const command = response(f, 'public-retry');
    const answers = await Promise.all(
      Array.from({ length: 4 }, () => submitForm(command, grant)),
    );
    expect(answers.filter(({ replayed }) => replayed)).toHaveLength(3);
    for (const answer of answers) expect(answer).not.toHaveProperty('runId');
    expect(await runs(f)).toBe(1);
    await expect(
      submitForm({ ...command, values: { amount: 2 } }, grant),
    ).rejects.toThrow(/idempotency/iu);
    expect(await runs(f)).toBe(1);
  });
});
describe('members and a form', () => {
  const EDITORS = ['admin', 'builder'] as const;
  const NOT_EDITORS = ['operator', 'viewer'] as const;
  const history = (f: Form, actorId: string) =>
    store.history({ ...f, actorId, limit: 10 });
  const access = (f: Form, actorId: string) => store.access({ ...f, actorId });
  const change = (f: Form, actorId: string, expectedRevision: number) =>
    store.setAccess({
      ...f,
      actorId,
      access: 'public',
      expectedRevision,
      capability: newCapability(),
      idempotencyKey: randomUUID(),
    });
  const accessRow = async ({ workflowId }: Form) =>
    (
      await admin.query<Record<string, unknown>>(
        'select access,revision,capability_hash from app.workflow_forms where workflow_id=$1',
        [workflowId],
      )
    ).rows;
  /** A form with one held event, so its history shows something to be refused. */
  const heldEvent = async () => {
    const f = await fixture({
      coordination: {
        mode: 'debounce',
        key: { kind: 'run_input', path: '$.values.message' },
        quietSeconds: 300,
      },
    });
    await expect(
      store.submit({
        ...response(f),
        actorId: f.actorId,
        values: { amount: 1, message: 'held' },
      }),
    ).resolves.toMatchObject({ accepted: false, status: 'pending' });
    return f;
  };

  it.each([...EDITORS, ...NOT_EDITORS])(
    'lets %s read and submit',
    async (role) => {
      const f = await fixture();
      const member = await addMember(f, role);
      await expect(
        store.read({ ...f, actorId: member }),
      ).resolves.toMatchObject({ versionId: f.versionId });
      await expect(
        submitForm({ ...response(f), actorId: member }),
      ).resolves.toMatchObject({ accepted: true });
      expect(await runs(f)).toBe(1);
    },
  );

  it.each(EDITORS)('lets %s manage access', async (role) => {
    const f = await heldEvent();
    const member = await addMember(f, role);
    await expect(access(f, member)).resolves.toMatchObject({
      access: 'members',
    });
    expect((await history(f, member)).items).toHaveLength(1);
    await expect(change(f, member, 0)).resolves.toMatchObject({
      access: 'public',
      revision: 1,
    });
  });

  it.each(NOT_EDITORS)(
    'keeps %s out of access and history, and writes nothing',
    async (role) => {
      const f = await heldEvent();
      const member = await addMember(f, role);
      const before = await accessRow(f);
      await expect(access(f, member)).rejects.toBeInstanceOf(
        FormUnavailableError,
      );
      await expect(history(f, member)).resolves.toEqual({
        items: [],
        next: null,
      });
      await expect(change(f, member, 0)).rejects.toBeInstanceOf(
        FormUnavailableError,
      );
      expect(await accessRow(f)).toEqual(before);
    },
  );

  it('still shows a suspended workspace’s form, access and history, and changes and takes nothing', async () => {
    const f = await heldEvent();
    await closeWorkspace.suspended(f);
    await expect(store.read(f)).resolves.toMatchObject({
      versionId: f.versionId,
    });
    await expect(access(f, f.actorId)).resolves.toMatchObject({
      access: 'members',
    });
    expect((await history(f, f.actorId)).items).toHaveLength(1);
    const before = await runs(f);
    await expect(
      submitForm({ ...response(f), actorId: f.actorId }),
    ).rejects.toBeInstanceOf(FormUnavailableError);
    await expect(change(f, f.actorId, 0)).rejects.toBeInstanceOf(
      FormUnavailableError,
    );
    expect(await runs(f)).toBe(before);
  });

  it('shows nothing once deletion is pending', async () => {
    const f = await heldEvent();
    await closeWorkspace.pending_deletion(f);
    await expect(store.read(f)).rejects.toBeInstanceOf(FormUnavailableError);
    await expect(access(f, f.actorId)).rejects.toBeInstanceOf(
      FormUnavailableError,
    );
    await expect(history(f, f.actorId)).resolves.toEqual({
      items: [],
      next: null,
    });
    await expect(change(f, f.actorId, 0)).rejects.toBeInstanceOf(
      FormUnavailableError,
    );
  });

  it('limits a builder in a restricted folder to what the grant allows', async () => {
    const folders = createWorkflowFolderStore(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    );
    try {
      const f = await fixture();
      const builder = await addMember(f, 'builder');
      const { folder } = await folders.createFolder({
        workspaceId: f.workspaceId,
        actorId: f.actorId,
        name: 'Private',
        parentId: null,
        idempotencyKey: randomUUID(),
      });
      await folders.placeWorkflow({
        workspaceId: f.workspaceId,
        actorId: f.actorId,
        workflowId: f.workflowId,
        folderId: folder.id,
        expectedOrganizationRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await admin.query(
        "update app.workflow_folders set access_mode='restricted' where id=$1",
        [folder.id],
      );
      await expect(
        store.read({ ...f, actorId: builder }),
      ).rejects.toBeInstanceOf(FormUnavailableError);
      await expect(access(f, builder)).rejects.toBeInstanceOf(
        FormUnavailableError,
      );
      await admin.query(
        "insert into app.workflow_folder_grants(id,workspace_id,folder_id,user_id,access) values($1,$2,$3,$4,'viewer')",
        [randomUUID(), f.workspaceId, folder.id, builder],
      );
      await expect(
        store.read({ ...f, actorId: builder }),
      ).resolves.toMatchObject({ versionId: f.versionId });
      await expect(access(f, builder)).resolves.toMatchObject({
        access: 'members',
      });
      await expect(change(f, builder, 0)).rejects.toBeInstanceOf(
        FormUnavailableError,
      );
    } finally {
      await folders.close();
    }
  });
});
