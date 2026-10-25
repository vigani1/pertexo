export const AUDIT_RETENTION_MIN_DAYS = 30;

/** A stale settings write must conflict before asking for another reviewer. */
export function requiresPublicationReviewer(
  previous: Readonly<{ revision: number; requirePublishApproval: boolean }>,
  input: Readonly<{
    expectedRevision: number;
    requirePublishApproval?: boolean | undefined;
  }>,
): boolean {
  return (
    previous.revision === input.expectedRevision &&
    !previous.requirePublishApproval &&
    (input.requirePublishApproval ?? false)
  );
}
