/** One command under one idempotency key. */
export type CommandIdentity = Readonly<{
  workspaceId: string;
  /** What the command does, e.g. `folder.create`. */
  operation: string;
  /** Who and what the key belongs to, e.g. the actor and the target. */
  scope: string;
  idempotencyKey: string;
}>;
