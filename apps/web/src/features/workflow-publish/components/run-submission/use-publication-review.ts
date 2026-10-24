import { useState } from 'react';

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
