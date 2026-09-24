import { useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  autoValidationDelay,
  needsAutoValidation,
} from './model/validation-throttle';
import type { WorkflowPublication } from './mutations/use-workflow-publication';

/**
 * Checks the saved draft for issues once editing pauses: once per saved
 * revision and never within five seconds of the previous check. A timer is
 * the external system here; the check itself is the publication's validate.
 */
export function useAutoValidation({
  publication,
  enabled,
  saveStatus,
  inspectorScratch,
  revision,
  generation,
}: Readonly<{
  publication: WorkflowPublication;
  enabled: boolean;
  saveStatus: string;
  inspectorScratch: boolean;
  revision: number;
  generation: number;
}>) {
  const lastStartedAt = useRef<number | undefined>(undefined);
  const [attemptedRevision, setAttemptedRevision] = useState<number>();
  const due = needsAutoValidation({
    enabled,
    saveStatus,
    inspectorScratch,
    pending: publication.validationPending,
    revision,
    generation,
    checked: publication.validation,
    attemptedRevision,
  });
  const blockedUntil = publication.validationBlockedUntil;

  const start = useEffectEvent(() => {
    lastStartedAt.current = Date.now();
    setAttemptedRevision(revision);
    void publication.validate();
  });

  useEffect(() => {
    if (!due) return;
    const timer = window.setTimeout(
      () => {
        start();
      },
      autoValidationDelay({
        now: Date.now(),
        lastStartedAt: lastStartedAt.current,
        blockedUntil,
      }),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [due, revision, generation, blockedUntil]);

  /** "Check again" from the issues lens: explicit, so not throttled. */
  function checkNow() {
    lastStartedAt.current = Date.now();
    setAttemptedRevision(revision);
    void publication.validate();
  }

  return { checkNow } as const;
}
