import { lockWorkspaceRunAdmission } from '../shared/workspace-fence.repository.js';
import type { WorkspaceDatabase } from '@pertexo/database/platform';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

import {
  InboxChecksumMismatchError,
  InboxReceiptUnavailableError,
} from './outbox.errors.js';
import {
  claimInboxReceipt,
  completeInboxReceipt,
  readInboxReceipt,
  recordChecksumMismatch,
} from './inbox-receipts.repository.js';

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
        await lockWorkspaceRunAdmission(
          transaction.db,
          transaction.workspaceId,
        );
      const claimed = await claimInboxReceipt(transaction, message);
      if (!claimed) {
        const receipt = await readInboxReceipt(transaction, message);
        if (receipt?.completedAt == null) {
          throw new InboxReceiptUnavailableError();
        }
        if (receipt.payloadChecksum !== message.payloadChecksum) {
          return CHECKSUM_MISMATCH;
        }
        return Object.freeze({ status: 'duplicate' as const });
      }

      const value = await operation(transaction);
      const completed = await completeInboxReceipt(transaction, message);
      if (!completed) {
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
      await recordChecksumMismatch(transaction, message);
    },
    options,
  );
  throw new InboxChecksumMismatchError();
}
