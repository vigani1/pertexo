import {
  DRAFT_PROPOSAL_MAX_REQUEST_CHARACTERS,
  type DraftProposalResult,
  type WorkflowGraphContract,
} from '@pertexo/contracts';
import { SparklesIcon, XIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { AssistantDisclosure } from '@/components/patterns/actions/assistant-disclosure';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';
import type { WorkflowValidationTarget } from '@/features/workflow-publish/public';
import { useDraftProposal } from '../data/draft-proposal.mutations';
import { DraftProposalReview } from './draft-proposal-review';

const outcomeCopy = {
  not_configured:
    'Ask a workspace administrator to select an AI connection and model in Workspace settings.',
  connection_unavailable: 'The workspace AI connection is unavailable.',
  confirmation_changed:
    'The draft or assistant settings changed. Check the assistant again.',
  timeout: 'The model request timed out.',
  request_too_large: 'This draft is too large to send to the AI assistant.',
  response_too_large: 'The proposal exceeded the size limit.',
  output_truncated:
    'The model ran out of output space before it finished. Try a shorter request or a model with more output.',
  invalid_response: 'The model returned an unreadable proposal.',
  provider_failure: 'The AI provider could not complete the request.',
} as const;

/**
 * The assistant, as a panel beside the canvas: one request, one proposal.
 * The proposal lists the draft changes and their publication check; Discard
 * drops it and Apply to draft saves it. A new request replaces the proposal,
 * since the assistant keeps no conversation. Escape or ✕ puts it away.
 */
export function DraftProposal({
  open,
  onClose,
  graph,
  onFix,
}: Readonly<{
  open: boolean;
  onClose: () => void;
  graph: WorkflowGraphContract;
  onFix: (target: WorkflowValidationTarget) => void;
}>) {
  return open ? (
    <AssistantPanel onClose={onClose} graph={graph} onFix={onFix} />
  ) : null;
}

function AssistantPanel({
  onClose,
  graph,
  onFix,
}: Readonly<{
  onClose: () => void;
  graph: WorkflowGraphContract;
  onFix: (target: WorkflowValidationTarget) => void;
}>) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const requestRef = useRef<HTMLTextAreaElement>(null);
  const [request, setRequest] = useState('');
  // The words the proposal on screen answers; a new request replaces both.
  const [asked, setAsked] = useState<string>();
  const { disclosure, proposal, apply } = useDraftProposal();
  const destination = disclosure.data;
  const review = proposalReview(proposal.data);
  const activity = proposalActivity({ disclosure, proposal, apply });
  const pending = activity !== undefined;
  const error = apply.error ?? proposal.error ?? disclosure.error;
  const stale =
    isApiError(error) && error.problem?.code === 'workflow.revision_conflict';
  const outcome = (proposal.data ?? destination)?.kind;
  const recheck =
    stale || outcome === 'confirmation_changed' || disclosure.isError;

  async function checkAssistant() {
    proposal.reset();
    apply.reset();
    setAsked(undefined);
    await disclosure.mutateAsync().catch(() => undefined);
  }
  // The assistant's destination is read once, when the panel opens.
  // oxlint-disable-next-line react/exhaustive-deps
  useEffect(() => void checkAssistant(), []);

  function close() {
    if (!pending) onClose();
  }
  // Escape puts the panel away from inside it, or when nothing else has
  // focus (a field the model was busy with gives focus back to the page).
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
  function send() {
    if (destination?.kind !== 'ready' || request.trim() === '') return;
    apply.reset();
    setAsked(request);
    void proposal
      .mutateAsync({ request, confirmation: destination.confirmation })
      .then(() => {
        setRequest('');
        requestAnimationFrame(() => requestRef.current?.focus());
      })
      .catch(() => undefined);
  }
  function discard() {
    proposal.reset();
    apply.reset();
    setAsked(undefined);
  }

  return (
    <aside
      ref={panelRef}
      aria-labelledby={titleId}
      data-slot="assistant-panel"
      className="lens pointer-events-auto absolute inset-x-0 top-0 bottom-16 z-50 flex flex-col overflow-hidden rounded-xl md:left-auto md:w-[min(26rem,100%)] lg:bottom-0"
    >
      <header className="flex items-start gap-3 px-4.5 pt-4.5 pb-3">
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-md bg-action-soft text-glint [&_svg]:size-4"
        >
          <SparklesIcon />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="font-heading text-section font-semibold">
            Assistant
          </h2>
          <p className="mt-0.5 text-meta text-muted-foreground">
            It proposes changes to your draft. Nothing changes until you apply
            them.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close the assistant"
          disabled={pending}
          onClick={close}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 content-start gap-6 overflow-y-auto overscroll-contain px-4.5 pt-2 pb-4.5">
        {destination?.kind === 'ready' ? (
          <AssistantDisclosure destination={destination} inDialog={false}>
            The request includes your description, draft structure, step
            settings and input mappings, and relevant catalog definitions.
            Protected settings and connections are masked.
          </AssistantDisclosure>
        ) : null}
        {asked === undefined ? null : (
          <section aria-label="Your request" className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-meta font-medium text-muted-foreground">
                Your request
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setRequest(asked);
                  requestRef.current?.focus();
                }}
              >
                Edit
              </Button>
            </div>
            <p className="wrap-anywhere text-foreground">{asked}</p>
          </section>
        )}
        {review === undefined ? null : (
          <section aria-label="Proposal" className="grid gap-4">
            <DraftProposalReview
              result={review}
              graph={graph}
              onFix={(target) => {
                onClose();
                onFix(target);
              }}
            />
            {review.kind === 'inspected' ? (
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={discard}
                >
                  Discard
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  disabled={pending}
                  onClick={() => {
                    void apply
                      .mutateAsync(review)
                      .then(onClose)
                      .catch(() => undefined);
                  }}
                >
                  Apply to draft
                </Button>
              </div>
            ) : null}
          </section>
        )}
        <ProposalFeedback
          activity={activity}
          error={error}
          stale={stale}
          outcome={outcome}
        />
        {recheck ? (
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            disabled={pending}
            onClick={() => void checkAssistant()}
          >
            Check again
          </Button>
        ) : null}
      </div>

      {destination?.kind === 'ready' ? (
        <form
          className="grid gap-2 border-t border-border px-3.5 pt-3 pb-3.5"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <label className="grid gap-2 text-meta font-medium">
            What should the workflow do?
            <Textarea
              ref={requestRef}
              value={request}
              placeholder={
                review === undefined
                  ? 'Describe a change to this workflow'
                  : 'New request · replaces this proposal'
              }
              onChange={(event) => {
                setRequest(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey) return;
                event.preventDefault();
                send();
              }}
              maxLength={DRAFT_PROPOSAL_MAX_REQUEST_CHARACTERS}
              disabled={pending}
            />
          </label>
          <div className="flex items-center justify-between gap-3">
            <p className="text-meta text-muted-foreground">
              Each request starts fresh from the current draft; the assistant
              doesn&apos;t keep a conversation.
            </p>
            <Button
              type="submit"
              size="sm"
              disabled={pending || request.trim() === ''}
            >
              Send to model
            </Button>
          </div>
        </form>
      ) : null}
    </aside>
  );
}

type ProposalMutations = ReturnType<typeof useDraftProposal>;

function proposalReview(result: DraftProposalResult | undefined) {
  return result?.kind === 'inspected' || result?.kind === 'rejected'
    ? result
    : undefined;
}

function proposalActivity({ apply, proposal, disclosure }: ProposalMutations) {
  if (apply.isPending) return 'Saving draft…';
  if (proposal.isPending) return 'Waiting for the model…';
  if (disclosure.isPending) return 'Checking the assistant settings…';
  return undefined;
}

function ProposalFeedback({
  activity,
  error,
  stale,
  outcome,
}: Readonly<{
  activity: string | undefined;
  error: Error | null;
  stale: boolean;
  outcome: string | undefined;
}>) {
  return (
    <>
      {activity === undefined ? null : (
        <p role="status" className="text-sm text-muted-foreground">
          {activity}
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {stale
            ? 'The draft changed. Check the assistant again, then send your request.'
            : describeCommandError(error, 'the draft proposal')}
        </p>
      )}
      {outcome !== undefined && Object.hasOwn(outcomeCopy, outcome) ? (
        <p role="status" className="text-sm text-muted-foreground">
          {outcomeCopy[outcome as keyof typeof outcomeCopy]}
        </p>
      ) : null}
    </>
  );
}
