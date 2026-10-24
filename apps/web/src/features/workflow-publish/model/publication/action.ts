import type { PublicationReviewOverview } from '@pertexo/contracts';

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
  const pendingReviewId =
    policy?.request?.status === 'pending' && savedDraftCurrent
      ? policy.request.id
      : undefined;
  const unchanged =
    unchangedVersionNumber === undefined
      ? undefined
      : `No changes since v${String(unchangedVersionNumber)}`;
  let label =
    versionLabel === undefined ? 'Publish' : `Publish ${versionLabel}`;
  if (policy?.required ?? false) label = 'Request review';
  if (unchanged !== undefined) label = unchanged;
  if (pendingReviewId !== undefined) label = 'Review requested';
  return {
    label,
    pendingReviewId,
    compactLabel:
      unchanged !== undefined && pendingReviewId === undefined
        ? 'No changes'
        : undefined,
    blockedReason:
      pendingReviewId === undefined ? (unchanged ?? emptyReason) : undefined,
    mode: retry ?? ((policy?.required ?? false) ? 'review' : 'publish'),
    unavailable: policy === undefined && retry === undefined,
  };
}
