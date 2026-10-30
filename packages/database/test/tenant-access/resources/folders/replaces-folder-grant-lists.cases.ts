import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import { actorId, workspaceId } from '../../../support/workflow-authoring.js';
import { builder, folders, viewer } from './fixture.js';

export function registerReplacesFolderGrantLists(): void {
  it('replaces a folder grant list as a whole, keeping each grant once', async () => {
    const { folder } = await folders.createFolder({
      workspaceId,
      actorId,
      name: `Shared ${randomUUID().slice(0, 8)}`,
      parentId: null,
      idempotencyKey: randomUUID(),
    });
    const replace = async (
      grants: readonly Readonly<{
        kind: 'member';
        userId: string;
        access: 'editor' | 'viewer';
      }>[],
    ) => {
      const current = await folders.readSharing({
        workspaceId,
        actorId,
        folderId: folder.id,
      });
      await folders.replaceSharing({
        workspaceId,
        actorId,
        folderId: folder.id,
        idempotencyKey: randomUUID(),
        request: {
          mode: 'restricted',
          expectedFolderRevision: current.revision,
          grants: [...grants],
        },
      });
      return (
        await folders.readSharing({ workspaceId, actorId, folderId: folder.id })
      ).grants;
    };

    const both = await replace([
      { kind: 'member', userId: builder, access: 'editor' },
      { kind: 'member', userId: viewer, access: 'viewer' },
    ]);
    expect(both).toHaveLength(2);
    expect(both).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: builder, access: 'editor' }),
        expect.objectContaining({ userId: viewer, access: 'viewer' }),
      ]),
    );

    const one = await replace([
      { kind: 'member', userId: viewer, access: 'editor' },
    ]);
    expect(one).toEqual([
      expect.objectContaining({ userId: viewer, access: 'editor' }),
    ]);
  });
}
