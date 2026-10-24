export function publicationDialogCopy({
  mode,
  pending,
  recoveryPending,
  failed,
  versionLabel,
}: Readonly<{
  mode: 'publish' | 'review';
  pending: boolean;
  recoveryPending: boolean;
  failed: boolean;
  versionLabel: string;
}>) {
  const review = mode === 'review';
  const action = review ? 'Request review' : `Publish ${versionLabel}`;
  const idleTitle = review ? 'Request publication review' : action;
  const busyTitle = review
    ? 'Requesting publication review…'
    : `Publishing ${versionLabel}…`;
  const description = review
    ? 'A different owner or admin will review this exact saved draft. Saving another edit makes the request stale.'
    : 'Publishing makes the saved draft the version that runs. The draft stays editable.';
  const retryLabel = review
    ? 'Retry original request'
    : 'Retry original publish';
  const freshConfirmLabel = failed ? 'Try again' : action;
  return {
    title: pending ? busyTitle : idleTitle,
    description: recoveryPending
      ? 'Retrying sends the same command again, for the same saved draft. It can’t create two versions or requests, and newer edits aren’t included.'
      : description,
    pendingLabel: review ? 'Requesting review…' : 'Publishing…',
    confirmLabel: recoveryPending ? retryLabel : freshConfirmLabel,
  };
}
