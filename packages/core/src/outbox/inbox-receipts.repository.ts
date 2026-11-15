import { generatePersistedId } from '@pertexo/database/platform';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import {
  inboxReceipts,
  transportSecurityAuditFacts,
} from '@pertexo/database/schema';
import { and, eq, sql } from 'drizzle-orm';

import type { InboxMessage } from './consume-message.js';

/** False when a receipt for this message already exists. */
export async function claimInboxReceipt(
  transaction: WorkspaceTransaction,
  message: InboxMessage,
): Promise<boolean> {
  const inserted = await transaction.db
    .insert(inboxReceipts)
    .values({
      consumerName: message.consumerName,
      messageId: message.messageId,
      workspaceId: transaction.workspaceId,
      payloadChecksum: message.payloadChecksum,
    })
    .onConflictDoNothing({
      target: [inboxReceipts.consumerName, inboxReceipts.messageId],
    })
    .returning({ messageId: inboxReceipts.messageId });
  return inserted.length > 0;
}

export async function readInboxReceipt(
  transaction: WorkspaceTransaction,
  message: InboxMessage,
) {
  const receipts = await transaction.db
    .select({
      completedAt: inboxReceipts.completedAt,
      payloadChecksum: inboxReceipts.payloadChecksum,
    })
    .from(inboxReceipts)
    .where(
      and(
        eq(inboxReceipts.consumerName, message.consumerName),
        eq(inboxReceipts.messageId, message.messageId),
      ),
    );
  return receipts[0];
}

/** False when the receipt is no longer this workspace's to complete. */
export async function completeInboxReceipt(
  transaction: WorkspaceTransaction,
  message: InboxMessage,
): Promise<boolean> {
  const completed = await transaction.db
    .update(inboxReceipts)
    .set({ completedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(inboxReceipts.consumerName, message.consumerName),
        eq(inboxReceipts.messageId, message.messageId),
        eq(inboxReceipts.workspaceId, transaction.workspaceId),
      ),
    )
    .returning({ messageId: inboxReceipts.messageId });
  return completed.length === 1;
}

export async function recordChecksumMismatch(
  transaction: WorkspaceTransaction,
  message: InboxMessage,
): Promise<void> {
  await transaction.db.insert(transportSecurityAuditFacts).values({
    id: generatePersistedId(),
    workspaceId: transaction.workspaceId,
    factType: 'inbox_checksum_mismatch',
    consumerName: message.consumerName,
    messageId: message.messageId,
  });
}
