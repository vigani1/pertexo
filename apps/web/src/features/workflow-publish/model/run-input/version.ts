/** A retry keeps the submitted precondition, even when it had no version. */
export function expectedRunVersion(
  input: Readonly<{
    retryAvailable: boolean;
    recoveryVersion: string | undefined;
    loadedCaseVersion: string | undefined;
    reviewedVersion: string | undefined;
    submittedVersion: string | undefined;
    publishedVersion: string | null | undefined;
  }>,
) {
  if (input.retryAvailable) return input.recoveryVersion;
  return (
    input.loadedCaseVersion ??
    input.reviewedVersion ??
    input.submittedVersion ??
    input.publishedVersion ??
    undefined
  );
}
