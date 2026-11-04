export const IDEMPOTENCY_STATUS = {
  inProgress: 'in_progress',
  completed: 'completed',
  failed: 'failed',
} as const;

export type IdempotencyStatus =
  (typeof IDEMPOTENCY_STATUS)[keyof typeof IDEMPOTENCY_STATUS];

export const IDEMPOTENCY_STATUS_VALUES = Object.values(IDEMPOTENCY_STATUS);

/** One command under one idempotency key. */
export type CommandIdentity = Readonly<{
  workspaceId: string;
  /** What the command does, e.g. `folder.create`. */
  operation: string;
  /** Who and what the key belongs to, e.g. the actor and the target. */
  scope: string;
  idempotencyKey: string;
}>;
