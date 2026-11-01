import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  actorId,
  otherWorkspaceId,
  queryAsOwner,
  workspaceId,
} from '../../../support/workflow-authoring.js';
import { WorkflowNotFoundError } from '../../../../src/authoring/workflows/errors.js';
import { folderId, folders } from './fixture.js';

export function registerRefusesUnlinkedOrganizationGroups(): void {
  it('refuses a group grant from an organization not linked to the workspace', async () => {
    const organizationId = randomUUID(),
      groupId = randomUUID();
    await queryAsOwner(
      "insert into app.auth_organizations(id,control_workspace_id,name) values($1,$2,'Unlinked groups')",
      [organizationId, otherWorkspaceId],
      otherWorkspaceId,
    );
    await queryAsOwner(
      "insert into app.auth_directory_groups(id,organization_id,display_name) values($1,$2,'Outsiders')",
      [groupId, organizationId],
      otherWorkspaceId,
    );
    const before = await folders.readSharing({
      workspaceId,
      actorId,
      folderId,
    });

    await expect(
      folders.replaceSharing({
        workspaceId,
        actorId,
        folderId,
        idempotencyKey: randomUUID(),
        request: {
          mode: 'restricted',
          expectedFolderRevision: before.revision,
          grants: [
            { kind: 'group', organizationId, groupId, access: 'editor' },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(
      folders.readSharing({ workspaceId, actorId, folderId }),
    ).resolves.toEqual(before);
  });
}
