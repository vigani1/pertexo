import type { PublicationReviewOverview } from '@pertexo/contracts';

function unchangedLabel(versionNumber: number) {
  return `No publishable changes since v${String(versionNumber)}`;
}

export function unchangedPublicationMessage(versionNumber: number) {
  return `${unchangedLabel(versionNumber)}. Step names and positions alone don’t create a new version.`;
}

/** The action describes the saved draft; an uncertain command keeps its original mode. */
export function publicationAction({
  policy,
  savedDraftCurrent,
  unchangedVersionNumber,
  versionLabel,
  emptyReason,
  retry,
}: Readonly<{
  policy: PublicationReviewOverview | undefined;
  savedDraftCurrent: boolean;
  unchangedVersionNumber: number | undefined;
  versionLabel: string | undefined;
  emptyReason: string | undefined;
  retry: 'publish' | 'review' | undefined;
}>) {
  const reviewRequired = policy?.required ?? false;
  const pendingReviewId =
    policy?.request?.status === 'pending' && savedDraftCurrent
      ? policy.request.id
      : undefined;
  const unchanged =
    unchangedVersionNumber === undefined
      ? undefined
      : unchangedLabel(unchangedVersionNumber);
  let label =
    versionLabel === undefined ? 'Publish' : `Publish ${versionLabel}`;
  if (reviewRequired) label = 'Request review';
  if (unchanged !== undefined) label = unchanged;
  if (pendingReviewId !== undefined) label = 'Review requested';
  return {
    label,
    pendingReviewId,
    compactLabel:
      unchanged !== undefined && pendingReviewId === undefined
        ? 'Already live'
        : undefined,
    blockedReason:
      pendingReviewId === undefined ? (unchanged ?? emptyReason) : undefined,
    mode: retry ?? (reviewRequired ? 'review' : 'publish'),
    unavailable: policy === undefined && retry === undefined,
  };
}
