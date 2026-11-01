import { describe, expect, it } from 'vitest';
import {
  folderScope,
  removesFolderRestriction,
} from '../../../src/tenant-access/resources/policy.js';
import type { FolderFact } from '../../../src/tenant-access/resources/contract.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';

const folders: readonly FolderFact[] = [
  { id: 'public', parentId: null, accessMode: 'workspace' },
  { id: 'restricted', parentId: null, accessMode: 'restricted' },
  { id: 'child', parentId: 'restricted', accessMode: 'workspace' },
  { id: 'nested', parentId: 'child', accessMode: 'restricted' },
];
const viewer = { folderId: 'restricted', access: 'viewer' } as const;
const editor = { folderId: 'restricted', access: 'editor' } as const;
const nested = { folderId: 'nested', access: 'editor' } as const;

describe('folder access within the workspace role ceiling', () => {
  it('keeps unfiled and unrestricted workflows available and denies missing ancestor grants', () => {
    const access = folderScope(workspaceId, 'builder', folders, [nested]);
    expect(access.permits(null, 'workflow:create')).toBe(true);
    expect(access.readFolderIds).toEqual(['public']);
    expect(access.permits('nested', 'workflow:read')).toBe(false);
    expect(access.permits('missing', 'workflow:read')).toBe(false);
  });
  it('uses the highest member/group grant locally and the lowest across ancestors', () => {
    const readOnly = folderScope(workspaceId, 'builder', folders, [
      viewer,
      nested,
    ]);
    expect(readOnly.permits('nested', 'workflow:read')).toBe(true);
    expect(readOnly.permits('nested', 'run:start')).toBe(true);
    expect(readOnly.permits('nested', 'workflow:update')).toBe(false);
    const editing = folderScope(workspaceId, 'builder', folders, [
      editor,
      viewer,
      nested,
    ]);
    expect(editing.editFolderIds).toEqual(folders.map(({ id }) => id));
    expect(editing.permits('nested', 'workflow:publish')).toBe(true);
  });
  it.each(['owner', 'admin'] as const)(
    'retains %s recovery access without grants',
    (role) => {
      expect(folderScope(workspaceId, role, folders, []).editFolderIds).toEqual(
        folders.map(({ id }) => id),
      );
    },
  );
  it('never raises a workspace viewer or operator above their existing capabilities', () => {
    const access = folderScope(workspaceId, 'viewer', folders, [
      editor,
      nested,
    ]);
    expect(access.readFolderIds).toHaveLength(4);
    expect(access.editFolderIds).toEqual([]);
    expect(access.permits('nested', 'run:start')).toBe(false);
    expect(access.permits('nested', 'workflow:update')).toBe(false);
    expect(
      folderScope(workspaceId, 'operator', folders, [editor, nested]).permits(
        'nested',
        'workflow:publish',
      ),
    ).toBe(false);
    expect(
      folderScope(workspaceId, null, folders, [editor, nested]).permits(
        null,
        'workflow:read',
      ),
    ).toBe(false);
  });
  it('requires audience review for replacing or removing a restriction, including equivalent current audiences', () => {
    expect(removesFolderRestriction(['a'], ['a', 'b'])).toBe(false);
    expect(removesFolderRestriction(['a'], ['b'])).toBe(true);
    expect(removesFolderRestriction(['a'], [])).toBe(true);
    expect(removesFolderRestriction([], ['b'])).toBe(false);
  });
});
