import type { WorkspaceInvitation } from '@pertexo/contracts';
import type { StatusTone } from '@/components/ui/status';
import { formatCount } from '@/lib/format/count';

const DAY_MS = 86_400_000;

export function describeInvitationStatus(
  status: WorkspaceInvitation['status'],
): Readonly<{ tone: StatusTone; label: string }> {
  switch (status) {
    case 'pending':
      return { tone: 'queued', label: 'Pending' };
    case 'accepted':
      return { tone: 'success', label: 'Accepted' };
    case 'revoked':
      return { tone: 'canceled', label: 'Revoked' };
    case 'expired':
      return { tone: 'timeout', label: 'Expired' };
  }
}

/** Report uncertainty as a finished delivery with an explicit recovery action. */
export function describeInvitationDelivery(
  delivery: WorkspaceInvitation['deliveryStatus'],
): Readonly<{ label: string; problem: boolean; guidance?: string }> {
  switch (delivery) {
    case 'queued':
      return { label: 'Sending', problem: false };
    case 'unknown':
      return {
        label: 'Delivery unconfirmed',
        problem: true,
        guidance:
          'Email delivery could not be confirmed. Revoke this invitation and create a new one to send another link.',
      };
    case 'submitted':
      return { label: 'Sent', problem: false };
    case 'failed':
      return { label: 'Couldn’t send', problem: true };
    case 'canceled':
      return { label: 'Not sent', problem: false };
  }
}

/** "expires in 6 days", "expires today", "expired". */
export function describeInvitationExpiry(
  invitation: Pick<WorkspaceInvitation, 'status' | 'expiresAt'>,
  now = Date.now(),
): string | undefined {
  if (invitation.status !== 'pending') return undefined;
  const remainingMs = Date.parse(invitation.expiresAt) - now;
  if (Number.isNaN(remainingMs)) return undefined;
  if (remainingMs <= 0) return 'expired';
  const days = Math.floor(remainingMs / DAY_MS);
  if (days === 0) return 'expires today';
  return `expires in ${formatCount(days, 'day')}`;
}
