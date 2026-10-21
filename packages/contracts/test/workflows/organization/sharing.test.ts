import { describe, expect, it } from 'vitest';
import {
  folderSharingRequestSchema,
  workflowMoveReviewRequestSchema,
  audienceReviewSchema,
  sharingPrincipalsQuerySchema,
} from '../../../src/schemas/workflows/sharing.js';
const id = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const member = (index: number) => ({
  kind: 'member' as const,
  userId: id(index),
  access: 'viewer' as const,
});
describe('resource sharing wire boundaries', () => {
  it('bounds principals, requires distinct current identities and accepts an administrators-only folder', () => {
    const base = { mode: 'restricted', expectedFolderRevision: 1, grants: [] };
    expect(folderSharingRequestSchema.parse(base).grants).toEqual([]);
    expect(
      folderSharingRequestSchema.safeParse({
        ...base,
        grants: Array.from({ length: 100 }, (_, i) => member(i)),
      }).success,
    ).toBe(true);
    for (const grants of [
      Array.from({ length: 101 }, (_, i) => member(i)),
      [member(1), member(1)],
      [{ ...member(1), access: 'owner' }],
      [{ kind: 'group', groupId: id(1), access: 'editor' }],
    ])
      expect(
        folderSharingRequestSchema.safeParse({ ...base, grants }).success,
      ).toBe(false);
    expect(
      folderSharingRequestSchema.safeParse({
        ...base,
        mode: 'workspace',
        grants: [member(1)],
      }).success,
    ).toBe(false);
  });
  it('bounds reviews to explicit unique selections and requires an explicit acknowledgement', () => {
    const request = {
      kind: 'workflows',
      workflowIds: Array.from({ length: 50 }, (_, i) => id(i)),
      destinationFolderId: null,
    };
    expect(workflowMoveReviewRequestSchema.safeParse(request).success).toBe(
      true,
    );
    expect(
      workflowMoveReviewRequestSchema.safeParse({
        ...request,
        workflowIds: [...request.workflowIds, id(51)],
      }).success,
    ).toBe(false);
    expect(
      workflowMoveReviewRequestSchema.safeParse({
        ...request,
        workflowIds: [id(1), id(1)],
      }).success,
    ).toBe(false);
    expect(
      audienceReviewSchema.safeParse({
        token: 'a'.repeat(64),
        acknowledge: false,
      }).success,
    ).toBe(false);
    expect(
      audienceReviewSchema.safeParse({
        token: 'a'.repeat(64),
        acknowledge: true,
      }).success,
    ).toBe(true);
  });
  it('caps principal discovery and refuses arbitrary actor selectors', () => {
    expect(sharingPrincipalsQuerySchema.parse({ kind: 'member' }).limit).toBe(
      50,
    );
    expect(
      sharingPrincipalsQuerySchema.safeParse({ kind: 'group', limit: 101 })
        .success,
    ).toBe(false);
    expect(
      sharingPrincipalsQuerySchema.safeParse({ kind: 'member', actorId: id(1) })
        .success,
    ).toBe(false);
  });
});
