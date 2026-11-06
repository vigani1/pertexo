import { isStoredDataError } from '../../../src/shared/stored-values.js';
import { expect, it } from 'vitest';
import {
  actorId,
  authoring,
  queryAsOwner,
  randomUUID,
  saveCurrentDraft,
  workspaceId,
} from '../../support/workflow-authoring.js';
import {
  createRestoreFixture,
  graphWithDuration,
  restoreInput,
} from './version-restore/fixture.js';

it('replays the accepted restore and recovery id with the original key even after a later draft edit', async () => {
  const fixture = await createRestoreFixture(randomUUID());
  const command = {
    ...(await restoreInput(fixture)),
    idempotencyKey: randomUUID(),
  };
  const accepted = await authoring.restoreWorkflowVersion(command);
  expect(accepted.recoveryCopyId).not.toBeNull();
  const replay = await authoring.restoreWorkflowVersion(command);
  expect(replay).toEqual(accepted);
  expect(
    await queryAsOwner<{ result_ref: { recoveryCopyId: string | null } }>(
      "select result_ref from app.idempotency_records where workspace_id=$1 and resource_id=$2 and operation='workflow.version.restore'",
      [workspaceId, fixture.workflowId],
      workspaceId,
    ),
  ).toMatchObject([
    {
      result_ref: {
        recoveryCopyId: accepted.recoveryCopyId,
        revision: accepted.revision,
      },
    },
  ]);
  const newer = graphWithDuration(9000);
  await saveCurrentDraft(authoring, {
    workspaceId,
    actorId,
    workflowId: fixture.workflowId,
    expectedRevision: accepted.revision,
    graphJson: newer,
  });
  expect(await authoring.restoreWorkflowVersion(command)).toEqual(accepted);
  expect(
    (await authoring.getDraft(workspaceId, fixture.workflowId, actorId))
      ?.graphJson,
  ).toEqual(newer);
  expect(
    await queryAsOwner(
      "select count(*)::int count from app.audit_events where action='workflow.duplicated' and metadata->>'sourceWorkflowId'=$1",
      [fixture.workflowId],
      workspaceId,
    ),
  ).toEqual([{ count: 1 }]);
});

it('reports a damaged stored restore receipt as stored data instead of replaying success', async () => {
  const fixture = await createRestoreFixture(randomUUID());
  const command = {
    ...(await restoreInput(fixture)),
    idempotencyKey: randomUUID(),
  };
  await authoring.restoreWorkflowVersion(command);
  await queryAsOwner(
    "update app.idempotency_records set result_ref='{\"damaged\":true}' where resource_id=$1 and operation='workflow.version.restore'",
    [fixture.workflowId],
    workspaceId,
  );
  await expect(authoring.restoreWorkflowVersion(command)).rejects.toSatisfy(
    isStoredDataError,
  );
});
