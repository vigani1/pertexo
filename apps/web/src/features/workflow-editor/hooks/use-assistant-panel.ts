import type { DraftProposalResult } from '@pertexo/contracts';
import { useEffect, useState, type RefObject } from 'react';
import { isApiError } from '@/lib/api/error';
import { useDraftProposal } from '../data/draft-proposal.mutations';

type Reviewed = Extract<DraftProposalResult, { kind: 'inspected' }>;

/**
 * The assistant panel's one request and one proposal. Opening the panel
 * checks where requests go; sending replaces whatever proposal is on
 * screen; applying saves it to the draft and closes the panel.
 */
export function useAssistantPanel({
  requestRef,
  onApplied,
}: Readonly<{
  requestRef: RefObject<HTMLTextAreaElement | null>;
  onApplied: () => void;
}>) {
  const [request, setRequest] = useState('');
  // The words the proposal on screen answers; a new request replaces both.
  const [asked, setAsked] = useState<string>();
  const mutations = useDraftProposal();
  const { disclosure, proposal, apply } = mutations;
  const destination = disclosure.data;
  const activity = proposalActivity(mutations);
  const error = apply.error ?? proposal.error ?? disclosure.error;
  const stale =
    isApiError(error) && error.problem?.code === 'workflow.revision_conflict';
  const outcome: string | undefined = (proposal.data ?? destination)?.kind;

  function checkAssistant() {
    if (stale && asked !== undefined)
      setRequest((current) => (current.trim() === '' ? asked : current));
    proposal.reset();
    apply.reset();
    setAsked(undefined);
    void disclosure.mutateAsync().catch(() => undefined);
  }
  // Where requests go is read once, when the panel opens.
  // oxlint-disable-next-line react/exhaustive-deps
  useEffect(checkAssistant, []);

  return {
    destination,
    review: proposalReview(proposal.data),
    activity,
    pending: activity !== undefined,
    error,
    stale,
    outcome,
    recheck: stale || outcome === 'confirmation_changed' || disclosure.isError,
    request,
    setRequest,
    asked,
    checkAssistant,
    edit: () => {
      if (asked !== undefined) setRequest(asked);
    },
    send: () => {
      if (destination?.kind !== 'ready' || request.trim() === '') return;
      apply.reset();
      setAsked(request);
      void proposal
        .mutateAsync({ request, confirmation: destination.confirmation })
        .then((result) => {
          setRequest('');
          if (proposalReview(result) === undefined)
            requestAnimationFrame(() => requestRef.current?.focus());
        })
        .catch(() => undefined);
    },
    discard: () => {
      proposal.reset();
      apply.reset();
      setAsked(undefined);
    },
    apply: (reviewed: Reviewed) => {
      void apply
        .mutateAsync(reviewed)
        .then(onApplied)
        .catch(() => undefined);
    },
  } as const;
}

/**
 * Escape puts a panel away from inside it, or when nothing else has focus
 * (a field the model was busy with gives focus back to the page).
 */
export function useEscapeFromPanel(
  panelRef: RefObject<HTMLElement | null>,
  close: () => void,
) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const active = document.activeElement;
      if (
        active !== null &&
        active !== document.body &&
        panelRef.current?.contains(active) !== true
      )
        return;
      event.preventDefault();
      close();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  });
}

function proposalReview(result: DraftProposalResult | undefined) {
  return result?.kind === 'inspected' || result?.kind === 'rejected'
    ? result
    : undefined;
}

function proposalActivity({
  apply,
  proposal,
  disclosure,
}: ReturnType<typeof useDraftProposal>) {
  if (apply.isPending) return 'Saving draft…';
  if (proposal.isPending) return 'Waiting for the model…';
  if (disclosure.isPending) return 'Checking the assistant settings…';
  return undefined;
}
