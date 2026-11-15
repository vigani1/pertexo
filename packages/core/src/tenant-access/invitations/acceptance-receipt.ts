import { decodeStoredValue } from '../../shared/stored-values.js';
import { InvitationAcceptanceConflictError } from '../tenant-access.errors.js';
import { ROLES } from '@pertexo/policy';
import { z } from 'zod';
import type { InvitationAcceptanceResult } from '../tenant-access.types.js';

/** Durable acceptance receipt stored on the intent and as the command's result. */
const acceptanceReceiptSchema = z
  .object({
    intentId: z.uuid(),
    workspaceId: z.uuid(),
    role: z.enum(ROLES),
    membershipCreated: z.boolean(),
  })
  .strict();

export type AcceptanceReceipt = z.output<typeof acceptanceReceiptSchema>;

/** A committed acceptance must be reconciled from its receipt, never repeated. */
export function decodeAcceptanceReceipt(value: unknown): AcceptanceReceipt {
  try {
    return decodeStoredValue(() => acceptanceReceiptSchema.parse(value));
  } catch (cause) {
    throw new InvitationAcceptanceConflictError(
      'receipt_unreadable',
      'The saved invitation confirmation could not be read. Reload your workspaces and contact the operator if access is missing.',
      { cause },
    );
  }
}

export function replayedAcceptance(
  receipt: AcceptanceReceipt,
): InvitationAcceptanceResult {
  return Object.freeze({
    ...receipt,
    replayed: true,
    replacementSessionCreated: false,
  });
}
