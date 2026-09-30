import { useState } from 'react';
import type { ManagedRole } from '../../model/workspace-roles';
import type {
  InvitationCommand,
  InvitationOutcome,
} from '../../mutations/use-invitation-command';
import type { InviteRow } from './invite-results';

type Batch = Readonly<{ rows: readonly InviteRow[]; role: ManagedRole }>;

function withRow(
  rows: readonly InviteRow[],
  index: number,
  row: Omit<InviteRow, 'email'>,
): readonly InviteRow[] {
  return rows.map((current, position) =>
    position === index ? { email: current.email, ...row } : current,
  );
}

function settledRow(
  outcome: Exclude<InvitationOutcome, { kind: 'stopped' }>,
): Omit<InviteRow, 'email'> {
  switch (outcome.kind) {
    case 'done':
      return { delivery: 'sent' };
    case 'uncertain':
      return { delivery: 'unsure', message: outcome.message };
    case 'failed':
      return { delivery: 'failed', message: outcome.message };
  }
}

/**
 * Sends one invitation per address, in order. An unconfirmed invitation
 * pauses the batch: it is retried with its exact command or skipped before
 * the next address goes out.
 */
export function useInviteBatch(
  command: InvitationCommand,
  onAllSent: (emails: readonly string[]) => void,
) {
  const [batch, setBatch] = useState<Batch>();

  async function sendFrom(
    role: ManagedRole,
    list: readonly InviteRow[],
    start: number,
  ) {
    let rows = list;
    for (let index = start; index < rows.length; index += 1) {
      const row = rows[index];
      if (row?.delivery !== 'waiting') continue;
      rows = withRow(rows, index, { delivery: 'sending' });
      setBatch({ rows, role });
      const outcome = await command.create(row.email, role);
      if (outcome.kind === 'stopped') return;
      rows = withRow(rows, index, settledRow(outcome));
      setBatch({ rows, role });
      if (outcome.kind === 'uncertain') return;
    }
    if (rows.every((row) => row.delivery === 'sent'))
      onAllSent(rows.map((row) => row.email));
  }

  function paused(): Readonly<{ current: Batch; index: number }> | undefined {
    if (batch === undefined) return undefined;
    const index = batch.rows.findIndex((row) => row.delivery === 'unsure');
    return index < 0 ? undefined : { current: batch, index };
  }

  return {
    rows: batch?.rows,
    sending: batch?.rows.some((row) => row.delivery === 'sending') ?? false,
    start: (emails: readonly string[], role: ManagedRole) => {
      const rows = emails.map((email) => ({
        email,
        delivery: 'waiting' as const,
      }));
      setBatch({ rows, role });
      void sendFrom(role, rows, 0);
    },
    retryPaused: async () => {
      const found = paused();
      if (found === undefined) return;
      const { current, index } = found;
      setBatch({
        ...current,
        rows: withRow(current.rows, index, { delivery: 'sending' }),
      });
      const outcome = await command.retry();
      if (outcome.kind === 'stopped') return;
      const rows = withRow(current.rows, index, settledRow(outcome));
      setBatch({ ...current, rows });
      if (outcome.kind !== 'uncertain')
        await sendFrom(current.role, rows, index + 1);
    },
    skipPaused: () => {
      const found = paused();
      if (found === undefined) return;
      const { current, index } = found;
      command.dismiss();
      const rows = withRow(current.rows, index, {
        delivery: 'skipped',
        message: 'Check the Invitations tab before inviting this person again.',
      });
      setBatch({ ...current, rows });
      void sendFrom(current.role, rows, index + 1);
    },
    reset: () => {
      setBatch(undefined);
    },
  };
}
