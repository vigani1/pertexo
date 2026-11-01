import { generatePersistedId } from '@pertexo/database/platform';
import { and, eq, sql } from 'drizzle-orm';
import type { WorkspaceDatabase } from '@pertexo/database/platform';
import {
  inboxReceipts,
  transportSecurityAuditFacts,
} from '@pertexo/database/schema';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

export interface InboxMessage {
  consumerName: string;
  messageId: string;
  payloadChecksum: string;
}

export type InboxConsumeOptions = Readonly<{
  signal?: AbortSignal;
  lockWorkspace?: boolean;
}>;
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

const CHECKSUM_MISMATCH = Symbol('checksum-mismatch');

export async function consumeInboxMessage<T>(
  database: WorkspaceDatabase,
  workspaceId: string,
  {
    message,
    operation,
    options = {},
  }: Readonly<{
    message: InboxMessage;
    operation: (transaction: WorkspaceTransaction) => Promise<T>;
    options?: InboxConsumeOptions | undefined;
  }>,
): Promise<InboxConsumeResult<T>> {
  const result = await database.withWorkspace(
    workspaceId,
    async (transaction) => {
      if (options.lockWorkspace ?? false)
        await transaction.db.execute(
          sql`select app.lock_workspace_run_admission(${transaction.workspaceId})`,
        );
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

      if (inserted.length === 0) {
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
        const receipt = receipts[0];
        if (receipt?.completedAt == null) {
          throw new InboxReceiptUnavailableError();
        }
        if (receipt.payloadChecksum !== message.payloadChecksum) {
          return CHECKSUM_MISMATCH;
        }
        return Object.freeze({ status: 'duplicate' as const });
      }

      const value = await operation(transaction);
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
      if (completed.length !== 1) {
        throw new InboxReceiptUnavailableError();
      }
      return Object.freeze({ status: 'processed' as const, value });
    },
    options,
  );

  if (result !== CHECKSUM_MISMATCH) return result;

  // A mismatch rejection must leave a durable, tenant-scoped security fact.
  // This deliberately uses a second transaction: throwing from the inbox
  // transaction would roll an audit insert back with it. The business
  // operation is never entered, and rejection is surfaced only after the
  // audit fact commits successfully.
  await database.withWorkspace(
    workspaceId,
    async (transaction) => {
      await transaction.db.insert(transportSecurityAuditFacts).values({
        id: generatePersistedId(),
        workspaceId: transaction.workspaceId,
        factType: 'inbox_checksum_mismatch',
        consumerName: message.consumerName,
        messageId: message.messageId,
      });
    },
    options,
  );
  throw new InboxChecksumMismatchError();
}
