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
  return {
    title: review
      ? pending
        ? 'Requesting publication review…'
        : 'Request publication review'
      : pending
        ? `Publishing ${versionLabel}…`
        : action,
    description: recoveryPending
      ? 'Retrying sends the same command again, for the same saved draft. It can’t create two versions or requests, and newer edits aren’t included.'
      : review
        ? 'A different owner or admin will review this exact saved draft. Saving another edit makes the request stale.'
        : 'Publishing makes the saved draft the version that runs. The draft stays editable.',
    pendingLabel: review ? 'Requesting review…' : 'Publishing…',
    confirmLabel: recoveryPending
      ? review
        ? 'Retry original request'
        : 'Retry original publish'
      : failed
        ? 'Try again'
        : action,
  };
}
