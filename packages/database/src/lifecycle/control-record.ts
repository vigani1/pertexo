import { createHash } from 'node:crypto';

export type WorkspaceControlRecord = Readonly<{
  actorRef: string;
  commandId: string;
  commandType: string;
  occurredAt: Date | string;
  previousHash: string;
  reason: string;
  sequence: number;
  workspaceId: string;
}>;

/**
 * The database keeps each workspace's lifecycle commands as a hash-linked
 * record. The hash is derived only from the command, so a retried command
 * projects the identical record.
 */
export function workspaceControlRecordHash(
  record: WorkspaceControlRecord,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        record.workspaceId,
        record.sequence,
        record.previousHash,
        record.commandId,
        record.commandType,
        record.actorRef,
        record.reason,
        new Date(record.occurredAt).toISOString(),
      ]),
    )
    .digest('hex');
}
