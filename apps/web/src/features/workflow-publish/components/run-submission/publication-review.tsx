import { useState } from 'react';
import { Button } from '@/components/ui/button';

/** A fetched confirmation target must also reach the displayed Query snapshot. */
export function usePublicationReview({
  read,
  displayedVersionId,
  recovering,
}: Readonly<{
  read: (() => Promise<string>) | undefined;
  displayedVersionId: string | null | undefined;
  recovering: boolean;
}>) {
  const [target, setTarget] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const ready = target !== undefined && target === displayedVersionId;
  async function review() {
    if (read === undefined || pending) return;
    setPending(true);
    try {
      setTarget(await read());
      setError(undefined);
    } catch {
      setError(
        'The current publication couldn’t be read. Try reviewing again; no run has started.',
      );
    } finally {
      setPending(false);
    }
  }
  return {
    target,
    pending,
    error,
    ready,
    waiting: target !== undefined && !ready && !recovering,
    review,
    clear: () => {
      setTarget(undefined);
    },
  };
}

function RunVersionNotice({
  expectedVersion,
  loadedName,
  stale,
  recovering,
}: Readonly<{
  expectedVersion: string | undefined;
  loadedName: string | undefined;
  stale: boolean;
  recovering: boolean;
}>) {
  if (expectedVersion === undefined) return null;
  return (
    <p className="text-sm text-muted-foreground">
      {runVersionDescription({ recovering, stale, loadedName })}
    </p>
  );
}

export function RunPublicationReview({
  expectedVersion,
  loadedName,
  staleCase,
  retryAvailable,
  review,
  publicationConflict,
  canReview,
  locked,
}: Readonly<{
  expectedVersion: string | undefined;
  loadedName: string | undefined;
  staleCase: boolean;
  retryAvailable: boolean;
  review: ReturnType<typeof usePublicationReview>;
  publicationConflict: boolean;
  canReview: boolean;
  locked: boolean;
}>) {
  return (
    <>
      <RunVersionNotice
        expectedVersion={expectedVersion}
        loadedName={loadedName}
        stale={staleCase}
        recovering={retryAvailable}
      />
      {staleCase && review.ready && !retryAvailable ? (
        <p role="status" className="text-sm text-muted-foreground">
          Reviewed current publication ·{' '}
          <span className="break-all font-mono">{review.target}</span>. Create
          and load a new case for this version before confirming a real run. The
          loaded case stays bound to its original version.
        </p>
      ) : null}
      {review.waiting ? (
        <p role="status" className="text-sm text-muted-foreground">
          Waiting for the reviewed publication to appear. Case changes and new
          starts stay blocked until the displayed version agrees.
        </p>
      ) : null}
      {(publicationConflict || review.waiting) && canReview ? (
        <Button
          type="button"
          variant="outline"
          disabled={locked}
          onClick={() => void review.review()}
        >
          Read current publication and review copied input
        </Button>
      ) : null}
    </>
  );
}

function runVersionDescription(
  input: Readonly<{
    recovering: boolean;
    stale: boolean;
    loadedName: string | undefined;
  }>,
) {
  const { recovering, stale, loadedName } = input;
  if (recovering)
    return 'Retrying uses the version the first attempt was sent to, never a newer one.';
  if (stale)
    return `${loadedName === undefined ? 'This case' : `“${loadedName}”`} was saved for an older version. Create or load a case for the version that’s live now.`;
  return `Runs the version that’s live now${loadedName === undefined ? '' : `, with “${loadedName}”`}. If a newer version is published first, nothing starts.`;
}
