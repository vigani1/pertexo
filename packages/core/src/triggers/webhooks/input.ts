export const SIGNATURE_CHECKS = [
  'verified',
  'mismatch',
  'not_checked',
] as const;

export const REPLAY_CHECKS = [
  'new',
  'duplicate',
  'conflict',
  'stale_timestamp',
  'not_checked',
] as const;
