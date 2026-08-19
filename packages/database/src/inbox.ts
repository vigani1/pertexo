import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { WorkspaceDatabase } from './database.js';
import { inboxReceipts } from './schema.js';
import type { WorkspaceTransaction } from './workspace.js';

const inboxMessageSchema = z
  .object({
    consumerName: z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u),
    messageId: z.uuid(),
    payloadChecksum: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

export type InboxMessage = Readonly<z.input<typeof inboxMessageSchema>>;
export type InboxConsumeResult<T> =
  | Readonly<{ status: 'processed'; value: T }>
  | Readonly<{ status: 'duplicate' }>;

export class InboxChecksumMismatchError extends Error {
  public constructor() {
    super('Inbox message checksum does not match the existing receipt');
    this.name = 'InboxChecksumMismatchError';
  }
}

export class InboxReceiptUnavailableError extends Error {
  public constructor() {
    super('Inbox receipt exists outside the active workspace or is incomplete');
    this.name = 'InboxReceiptUnavailableError';
  }
}

export async function consumeInboxMessage<T>(
  database: WorkspaceDatabase,
  workspaceId: string,
  message: InboxMessage,
  operation: (transaction: WorkspaceTransaction) => Promise<T>,
): Promise<InboxConsumeResult<T>> {
  const parsed = inboxMessageSchema.parse(message);
  return database.withWorkspace(workspaceId, async (transaction) => {
    const inserted = await transaction.db
      .insert(inboxReceipts)
      .values({
        consumerName: parsed.consumerName,
        messageId: parsed.messageId,
        workspaceId: transaction.workspaceId,
        payloadChecksum: parsed.payloadChecksum,
      })
      .onConflictDoNothing({
        target: [inboxReceipts.consumerName, inboxReceipts.messageId],
      })
      .returning({ messageId: inboxReceipts.messageId });

    if (inserted.length === 0) {
      const receipts = await transaction.db
        .select({
          completedAt: inboxReceipts.completedAt,
          payloadChecksum: inboxReceipts.payloadChecksum,
        })
        .from(inboxReceipts)
        .where(
          and(
            eq(inboxReceipts.consumerName, parsed.consumerName),
            eq(inboxReceipts.messageId, parsed.messageId),
          ),
        );
      const receipt = receipts[0];
      if (receipt?.completedAt == null) {
        throw new InboxReceiptUnavailableError();
      }
      if (receipt.payloadChecksum !== parsed.payloadChecksum) {
        throw new InboxChecksumMismatchError();
      }
      return Object.freeze({ status: 'duplicate' as const });
    }

    const value = await operation(transaction);
    const completed = await transaction.db
      .update(inboxReceipts)
      .set({ completedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(inboxReceipts.consumerName, parsed.consumerName),
          eq(inboxReceipts.messageId, parsed.messageId),
          eq(inboxReceipts.workspaceId, transaction.workspaceId),
        ),
      )
      .returning({ messageId: inboxReceipts.messageId });
    if (completed.length !== 1) {
      throw new InboxReceiptUnavailableError();
    }
    return Object.freeze({ status: 'processed' as const, value });
  });
}
