import { randomUUID } from 'node:crypto';
import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/policy';
import { Pool } from 'pg';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { lockWorkspace } from '../../../src/authoring/settings/auto-pause/state.repository.js';
import { withWorkspaceAccess } from '../../../src/shared/workspace-access.js';
import {
  actorId,
  apiUrl,
  authoring,
  emptyGraph,
  holdAtWrite,
  waitForPostgresLock,
  withApplicationName,
  workspaceId,
} from '../../support/workflow-authoring.js';
import {
  cleanups,
  holdRow,
  isDeadlock,
  namedStore,
} from '../../support/workflow-authoring/forced-order.js';

// Past Postgres's own deadlock timer, and a loaded machine's lock waits.
vi.setConfig({ testTimeout: 30_000 });

const scope = () => ({ workspaceId, actorId });
const opened = cleanups();
afterEach(() => opened.run());

let workflowId: string;

beforeAll(async () => {
  ({ workflowId } = await authoring.createWorkflow({
    ...scope(),
    name: 'Auto-pause locks',
    emptyGraph,
    idempotencyKey: randomUUID(),
  }));
});

function flow() {
  const named = namedStore();
  opened.add(() => named.store.close());
  return { pause: named.store.autoPause, waiting: named.waiting };
}

/** What every flow past the helper's door holds: the workspace row, for share. */
async function holdWorkspaceForShare() {
  const held = await holdRow(
    'select 1 from app.workspaces where id=$1 for share',
    workspaceId,
  );
  opened.add(() => held.release());
  return held;
}

async function thresholdEdit(threshold: number) {
  const editing = flow();
  const { revision } = await authoring.autoPause.readWorkspaceSettings(scope());
  return {
    ...editing,
    command: {
      ...scope(),
      threshold,
      expectedRevision: revision,
      idempotencyKey: randomUUID(),
    },
  };
}

type Pause = ReturnType<typeof flow>['pause'];

/**
 * Each thing that takes the workspace key shared before it takes the row, read
 * ready before anything is held, so that only the flow itself waits. Each answers
 * with the workspace default it saw.
 */
const SHARED_KEY_FLOWS: Readonly<
  Record<string, () => Promise<(pause: Pause) => Promise<number>>>
> = {
  'reading the workspace default': () =>
    Promise.resolve(
      async (pause) => (await pause.readWorkspaceSettings(scope())).threshold,
    ),
  "reading a workflow's settings": () =>
    Promise.resolve(
      async (pause) =>
        (await pause.readWorkflowSettings({ ...scope(), workflowId }))
          .workspaceThreshold,
    ),
  "changing a workflow's settings": async () => {
    const { enabled, thresholdOverride, settingsRevision } =
      await authoring.autoPause.readWorkflowSettings({
        ...scope(),
        workflowId,
      });
    return async (pause) =>
      (
        await pause.updateWorkflowSettings({
          ...scope(),
          workflowId,
          enabled: !enabled,
          thresholdOverride,
          expectedSettingsRevision: settingsRevision,
          idempotencyKey: randomUUID(),
        })
      ).settings.workspaceThreshold;
  },
  "resuming a workflow's triggers": async () => {
    const { pauseRevision } = await authoring.autoPause.readWorkflowSettings({
      ...scope(),
      workflowId,
    });
    return async (pause) =>
      (
        await pause.resumeWorkflow({
          ...scope(),
          workflowId,
          expectedPauseRevision: pauseRevision,
          idempotencyKey: randomUUID(),
        })
      ).settings.workspaceThreshold;
  },
};

/** A threshold the workspace doesn't have yet, within what a threshold allows. */
const nextThreshold = async () => {
  const { threshold } =
    await authoring.autoPause.readWorkspaceSettings(scope());
  return threshold >= 100 ? 3 : threshold + 1;
};

it.each(Object.entries(SHARED_KEY_FLOWS))(
  '%s waits on the key, holding no row, while a threshold edit waits on the row',
  async (_name, prepare) => {
    const threshold = await nextThreshold();
    const editing = await thresholdEdit(threshold);
    const run = await prepare();
    const other = flow();
    const fence = await holdWorkspaceForShare();

    const edit = editing.pause.updateWorkspaceSettings(editing.command);
    await editing.waiting();
    const answer = run(other.pause);
    await other.waiting();
    await fence.release();

    await expect(edit).resolves.toMatchObject({
      settings: { threshold },
      replayed: false,
    });
    // It waited for the edit, so it answers with the edit's value.
    await expect(answer).resolves.toBe(threshold);
  },
);

it('behind the helper the same reader deadlocks with the edit, which is why it stays off', async () => {
  const name = `behind-the-helper-${randomUUID()}`;
  const pool = new Pool({
    connectionString: withApplicationName(apiUrl, name),
    max: 1,
  });
  opened.add(() => pool.end());
  const editing = await thresholdEdit(await nextThreshold());
  const fence = await holdWorkspaceForShare();

  const edit = editing.pause.updateWorkspaceSettings(editing.command);
  await editing.waiting();
  const reader = withWorkspaceAccess(
    pool,
    scope(),
    {
      mode: 'change',
      capability: 'workflow:read',
      statuses: BROWSABLE_WORKSPACE_STATUSES,
    },
    (client) =>
      lockWorkspace(client, workspaceId, {
        exclusive: false,
        statuses: BROWSABLE_WORKSPACE_STATUSES,
      }),
  );
  await waitForPostgresLock(name);
  // The edit is waiting on this transaction alone, so nothing is stuck until it
  // ends. Then the edit waits on the reader, which is waiting on the edit's key.
  await fence.release();
  const settled = await Promise.allSettled([edit, reader]);

  expect(
    settled.filter(
      (one) => one.status === 'rejected' && isDeadlock(one.reason),
    ),
  ).toHaveLength(1);
});

it('a threshold edit waits for a reader that holds the key, and the reader sees the old value', async () => {
  const before = await authoring.autoPause.readWorkspaceSettings(scope());
  const reading = flow();
  const threshold = await nextThreshold();
  const editing = await thresholdEdit(threshold);
  // Stops the reader at the workflow row, past the key and the workspace row.
  const workflowRow = await holdRow(
    'select 1 from app.workflows where id=$1 for update',
    workflowId,
  );
  opened.add(() => workflowRow.release());

  const read = reading.pause.readWorkflowSettings({ ...scope(), workflowId });
  await reading.waiting();
  const edit = editing.pause.updateWorkspaceSettings(editing.command);
  await editing.waiting();
  await workflowRow.release();

  await expect(read).resolves.toMatchObject({
    workspaceThreshold: before.threshold,
  });
  await expect(edit).resolves.toMatchObject({
    settings: { threshold },
  });
});

it('a threshold edit in flight keeps a second edit waiting, then refuses its stale revision', async () => {
  const threshold = await nextThreshold();
  const first = await thresholdEdit(threshold);
  const second = await thresholdEdit(threshold === 3 ? 4 : 3);
  const held = await holdAtWrite({
    table: 'idempotency_records',
    operation: 'insert',
    when: `NEW.resource_id = '${workspaceId}' and NEW.operation = 'workspace.autopause.settings'`,
  });
  opened.add(() => held.remove());

  const edit = first.pause.updateWorkspaceSettings(first.command);
  await held.reached();
  const refused = expect(
    second.pause.updateWorkspaceSettings(second.command),
  ).rejects.toMatchObject({
    currentRevision: first.command.expectedRevision + 1,
  });
  await second.waiting();
  await held.release();

  await expect(edit).resolves.toMatchObject({ settings: { threshold } });
  await refused;
});
