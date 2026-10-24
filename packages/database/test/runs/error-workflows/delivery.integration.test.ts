import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantScopedClient } from '../../../src/tenant-access/transactions.js';
import { admin } from '../../lifecycle/calls/fixtures.js';
import {
  createWorkflowErrorStore,
  WorkflowErrorSettingsConflictError,
  WorkflowErrorTargetUnavailableError,
} from '../../../src/authoring/settings/error-workflow.repository.js';
import { WorkflowNotFoundError } from '../../../src/authoring/workflows/errors.js';
import { userId } from '../../lifecycle/retention.support.js';

import {
  pool,
  store,
  fixture,
  delivery,
  intent,
  publishManualTarget,
  beforeAllFixture1,
  afterAllFixture2,
} from './delivery/fixture.js';
import { registerCreatesExactlyOneSIntent } from './delivery/creates-exactly-one-sintent.cases.js';
import { registerRetainsErrorWorkflowOriginOn } from './delivery/retains-error-workflow-origin-on.cases.js';
import { registerRecordsUnpublishedTargetOnSource } from './delivery/records-unpublished-target-on-source.cases.js';
import { registerFencesWakeupUpdatesSameWorkspace } from './delivery/fences-wakeup-updates-same-workspace.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
describe('durable error workflow admission', () => {
  registerCreatesExactlyOneSIntent();
});
describe('error workflow settings authority and publication', () => {
  const settings = createWorkflowErrorStore(
    (workspaceId, actorId, operation, signal) =>
      withTenantScopedClient(
        pool,
        { workspaceId, actorId },
        operation,
        signal === undefined ? {} : { signal },
      ),
  );
  async function editable() {
    const f = await fixture();
    await admin.query(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'builder','active')",
      [f.workspaceId, userId],
    );
    return {
      ...f,
      scope: {
        workspaceId: f.workspaceId,
        workflowId: f.sourceWorkflowId,
        actorId: userId,
      },
    };
  }
  it('uses one revision/idempotent receipt, supports clearing and refuses stale or self targets', async () => {
    const f = await editable();
    const request = {
      ...f.scope,
      targetWorkflowId: null,
      expectedRevision: 1,
      idempotencyKey: 'clear-once',
    };
    const cleared = await settings.updateSettings(request);
    expect(cleared).toEqual({
      settings: { targetWorkflowId: null, revision: 2 },
      replayed: false,
    });
    expect(await settings.updateSettings(request)).toEqual({
      ...cleared,
      replayed: true,
    });
    await expect(
      settings.updateSettings({ ...request, idempotencyKey: 'stale' }),
    ).rejects.toBeInstanceOf(WorkflowErrorSettingsConflictError);
    await expect(
      settings.updateSettings({
        ...request,
        targetWorkflowId: f.sourceWorkflowId,
        expectedRevision: 2,
        idempotencyKey: 'self',
      }),
    ).rejects.toBeInstanceOf(WorkflowErrorTargetUnavailableError);
    expect(
      await settings.updateSettings({
        ...request,
        targetWorkflowId: f.childWorkflowId,
        expectedRevision: 2,
        idempotencyKey: 'choose',
      }),
    ).toMatchObject({
      settings: { targetWorkflowId: f.childWorkflowId, revision: 3 },
    });
    expect(await settings.listTargets(f.scope)).toEqual({
      items: [{ id: f.childWorkflowId, name: 'Call retention' }],
      nextCursor: null,
    });
  });
  it('requires a publication before the target can be selected', async () => {
    const f = await editable();
    await admin.query(
      'update app.workflows set published_version_id=null where id=$1',
      [f.childWorkflowId],
    );
    await expect(
      settings.updateSettings({
        ...f.scope,
        targetWorkflowId: f.childWorkflowId,
        expectedRevision: 1,
        idempotencyKey: 'unpublished',
      }),
    ).rejects.toBeInstanceOf(WorkflowErrorTargetUnavailableError);
    expect(await settings.listTargets(f.scope)).toEqual({
      items: [],
      nextCursor: null,
    });
  });
  it('requires active edit membership at the command transaction and hides foreign targets', async () => {
    const f = await editable();
    const foreign = await fixture();
    await expect(
      settings.updateSettings({
        ...f.scope,
        targetWorkflowId: foreign.childWorkflowId,
        expectedRevision: 1,
        idempotencyKey: 'foreign',
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await admin.query(
      "update app.workspace_memberships set status='removed',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
      [f.workspaceId, userId],
    );
    await expect(
      settings.updateSettings({
        ...f.scope,
        targetWorkflowId: null,
        expectedRevision: 1,
        idempotencyKey: 'removed',
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });
  it('records invalid-target refusal if the live publication no longer has the trigger', async () => {
    const f = await fixture();
    await publishManualTarget(f);
    await f.produce();
    await store.dispatch(await delivery(f));
    expect(await intent(f)).toMatchObject({
      status: 'refused',
      refusal_code: 'invalid_target',
    });
  });
});
registerRetainsErrorWorkflowOriginOn();
registerRecordsUnpublishedTargetOnSource();
registerFencesWakeupUpdatesSameWorkspace();
