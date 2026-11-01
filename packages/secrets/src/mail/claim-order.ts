/**
 * UPDATE .. RETURNING doesn't keep the candidates' order, so a batch of claims is
 * put back in it here: anything but a workspace notice first, then oldest due.
 */
export function compareClaims(
  left: ClaimOrderFields,
  right: ClaimOrderFields,
): number {
  return (
    Number(left.purpose === 'workspace_notice') -
      Number(right.purpose === 'workspace_notice') ||
    left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime() ||
    left.id.localeCompare(right.id)
  );
}

type ClaimOrderFields = Readonly<{
  id: string;
  purpose: string;
  nextAttemptAt: Date;
}>;
