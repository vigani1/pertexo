export const USER_STATUS = {
  active: 'active',
  suspended: 'suspended',
  deleted: 'deleted',
} as const;

export const WORKSPACE_STATUS = {
  active: 'active',
  suspended: 'suspended',
  pendingDeletion: 'pending_deletion',
  purging: 'purging',
  deleted: 'deleted',
} as const;
