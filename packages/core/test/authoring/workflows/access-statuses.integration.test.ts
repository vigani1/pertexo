import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkflowNotFoundError } from '../../../src/authoring/workflows/workflow-authoring.errors.js';
import {
  actorId,
  authoring,
  queryAsOwner,
  workspaceId,
} from '../../support/workflow-authoring.js';
import { as, READS, WRITES } from './access/doors.js';
import { closeWorld, open, openWorld, viewer } from './access/world.js';

beforeAll(openWorld, 60_000);
afterAll(closeWorld);

/** Moves the workspace as a lifecycle command would. */
const enter = (status: 'active' | 'suspended' | 'pending_deletion') =>
  queryAsOwner(
    `update app.workspaces set status=$2::text,
       deletion_requested_at=case when $3 then clock_timestamp() end,
       deletion_requested_by=case when $3 then created_by end,
       deletion_reason=case when $3 then 'status proof' end,
       purge_after=case when $3 then clock_timestamp()+interval '7 days' end
     where id=$1 returning 1`,
    [workspaceId, status, status === 'pending_deletion'],
    workspaceId,
  );

/**
 * The store decides, whatever an API guard in front of it does: a read answers
 * until deletion is scheduled, and a change only while the workspace is active.
 */
describe('while the workspace is suspended', () => {
  beforeAll(() => enter('suspended'));

  describe.each(Object.entries(READS))('%s', (_name, { read, shows }) => {
    it('still shows what is there', async () => {
      await expect(read(as(viewer), open)).resolves.toMatchObject(
        shows(open) as object,
      );
    });
  });

  describe.each(Object.entries(WRITES))('%s', (_name, write) => {
    it('is refused, even to the owner', async () => {
      await expect(write(as(actorId), open)).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
    });
  });
});

describe('while the workspace is scheduled for deletion', () => {
  beforeAll(() => enter('pending_deletion'));

  describe.each(Object.entries(READS))('%s', (_name, { read }) => {
    it('shows nothing', async () => {
      await expect(read(as(viewer), open)).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
    });
  });

  describe.each(Object.entries(WRITES))('%s', (_name, write) => {
    it('is refused, even to the owner', async () => {
      await expect(write(as(actorId), open)).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
    });
  });
});

describe('back to active', () => {
  beforeAll(() => enter('active'));

  it('answers again', async () => {
    await expect(
      authoring.getWorkflow(workspaceId, open.id, viewer),
    ).resolves.toMatchObject({ id: open.id });
  });
});
