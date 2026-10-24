export const workflowProjectionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export function workflowProjection(name: string) {
  return {
    id: workflowProjectionId,
    workspaceId: workflowProjectionId,
    name,
    nameRevision: 1,
    lifecycleStatus: 'active',
    lifecycleRevision: 1,
    activationStatus: 'inactive',
    webhookSetupRequired: false,
    publishedVersionId: null,
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  };
}
export function organizationProjection() {
  return {
    tags: [],
    organizationRevision: 1,
    folderId: null,
    isFavorite: false,
  };
}
