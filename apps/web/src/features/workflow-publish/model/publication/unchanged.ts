import type { WorkflowPublication } from '../../data/mutations/use-workflow-publication';
import type { SavedDraft } from '../../data/mutations/use-workflow-draft-validation';

/** A comparison only describes the saved draft and publication it names. */
export function unchangedLiveVersion(
  publication: Pick<
    WorkflowPublication,
    'validation' | 'publicationReceipt' | 'publishRecoveryPending'
  >,
  publishedVersionId: string | null | undefined,
  isSavedDraftCurrent: (saved: SavedDraft) => boolean,
): number | undefined {
  if (publication.publishRecoveryPending) return undefined;
  const receipt = publication.publicationReceipt;
  if (
    receipt !== undefined &&
    receipt.versionId === publishedVersionId &&
    isSavedDraftCurrent(receipt)
  )
    return receipt.versionNumber;
  const checked = publication.validation;
  if (
    checked === undefined ||
    checked.etag !== checked.requestedEtag ||
    !isSavedDraftCurrent(checked)
  )
    return undefined;
  const current = checked.report.currentPublication;
  return current?.matchesDraft && current.versionId === publishedVersionId
    ? current.versionNumber
    : undefined;
}
