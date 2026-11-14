/** A change needs an active workspace. */
export const ACTIVE_WORKSPACE_STATUSES = Object.freeze(['active'] as const);
/** A suspended workspace reads but does not change (ADR 013/027). */
export const BROWSABLE_WORKSPACE_STATUSES = Object.freeze([
  'active',
  'suspended',
] as const);
/**
 * A workspace scheduled for deletion can still be restored, and its owner opens
 * it to decide. Reads using this list stay open until the purge starts.
 */
export const UNPURGED_WORKSPACE_STATUSES = Object.freeze([
  ...BROWSABLE_WORKSPACE_STATUSES,
  'pending_deletion',
] as const);
/** Current members can observe deletion until their membership is purged. */
export const DISCOVERABLE_WORKSPACE_STATUSES = Object.freeze([
  ...UNPURGED_WORKSPACE_STATUSES,
  'purging',
] as const);
/**
 * For a flow that decides for itself what each status allows, so a member of a
 * workspace being purged gets that flow's answer rather than a denial.
 */
export const ALL_WORKSPACE_STATUSES = Object.freeze([
  ...UNPURGED_WORKSPACE_STATUSES,
  'purging',
  'deleted',
] as const);
/** A rule names the list it means, so two with different values can't be mistaken. */
export type WorkspaceStatusList =
  | typeof ACTIVE_WORKSPACE_STATUSES
  | typeof BROWSABLE_WORKSPACE_STATUSES
  | typeof UNPURGED_WORKSPACE_STATUSES
  | typeof ALL_WORKSPACE_STATUSES;
