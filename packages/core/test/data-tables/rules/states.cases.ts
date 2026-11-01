import { it } from 'vitest';

import { queryAsOwner } from '../../support/workflow-authoring.js';
import { addMember } from './world.js';
import {
  expectChangesRefused,
  expectReadsRefused,
  expectReadsShowTheRow,
  worldWithRow,
} from './access.cases.js';

function setStatus(
  workspaceId: string,
  status: 'suspended' | 'pending_deletion' | 'purging',
  actorId: string,
) {
  return queryAsOwner(
    `update app.workspaces set status=$2::text,
       deletion_requested_at=case when $2::text<>'suspended' then clock_timestamp() end,
       deletion_requested_by=case when $2::text<>'suspended' then $3::uuid end,
       deletion_reason=case when $2::text<>'suspended' then 'data table state proof' end,
       purge_after=case when $2::text<>'suspended' then clock_timestamp()+interval '1 day' end
     where id=$1`,
    [workspaceId, status, actorId],
    workspaceId,
  );
}

export function registerStates(): void {
  it.each(['suspended', 'pending_deletion'] as const)(
    'keeps table reads open while %s, for an owner and a viewer, and refuses every change',
    async (status) => {
      const { owner, table } = await worldWithRow();
      const viewer = await addMember(owner.workspaceId, 'viewer');
      const builder = await addMember(owner.workspaceId, 'builder');
      await setStatus(owner.workspaceId, status, owner.actorId);

      await expectReadsShowTheRow(owner, table);
      await expectReadsShowTheRow(viewer, table);
      await expectChangesRefused(owner, owner, table);
      await expectChangesRefused(builder, owner, table);
    },
  );

  it('closes table reads once the purge has started', async () => {
    const { owner, table } = await worldWithRow();
    await setStatus(owner.workspaceId, 'purging', owner.actorId);
    await expectReadsRefused(owner, table);
  });
}
