import type { SystemMailPurpose } from './system-mail.types.js';

export const BACKGROUND_MAIL_PURPOSES: readonly SystemMailPurpose[] = [
  'workspace_notice',
  'workflow_failure_alert',
];

/**
 * UPDATE .. RETURNING doesn't keep the candidates' order, so a batch of claims is
 * put back in it here: security mail before background mail, then oldest due.
 */
export function compareClaims(
  left: ClaimOrderFields,
  right: ClaimOrderFields,
): number {
  return (
    Number(BACKGROUND_MAIL_PURPOSES.includes(left.purpose)) -
      Number(BACKGROUND_MAIL_PURPOSES.includes(right.purpose)) ||
    left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime() ||
    left.id.localeCompare(right.id)
  );
}

type ClaimOrderFields = Readonly<{
  id: string;
  purpose: SystemMailPurpose;
  nextAttemptAt: Date;
}>;
