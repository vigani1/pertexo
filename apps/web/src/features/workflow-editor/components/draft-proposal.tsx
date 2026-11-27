import {
  DRAFT_PROPOSAL_MAX_REQUEST_CHARACTERS,
  type WorkflowGraphContract,
} from '@pertexo/contracts';
import { SparklesIcon, XIcon } from 'lucide-react';
import { useId, useRef, type RefObject } from 'react';
import { AssistantDisclosure } from '@/components/patterns/actions/assistant-disclosure';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { describeCommandError } from '@/lib/api/error-copy';
import type { WorkflowValidationTarget } from '@/features/workflow-publish/public';
import {
  useAssistantPanel,
  useEscapeFromPanel,
} from '../hooks/use-assistant-panel';
import { DraftProposalReview } from './draft-proposal-review';
import { useEditorSession, useEditorStore } from '../model/state/context';

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
 * since the assistant keeps no conversation. Escape or ✕ puts it away. Only
 * people who can change the draft, while it isn't paused, have it.
 */
export function DraftProposal({
  open,
  onClose,
}: Readonly<{ open: boolean; onClose: () => void }>) {
  const { editing } = useEditorSession();
  const graph = useEditorStore((state) => state.graph);
  if (!open || !editing.canUpdate || editing.paused) return null;
  return (
    <AssistantPanel
      onClose={onClose}
      graph={graph}
      onFix={editing.actions.navigation.fix}
    />
  );
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
  const panel = useAssistantPanel({ requestRef, onApplied: onClose });
  const { destination, review, pending } = panel;
  const close = () => {
    if (!pending) onClose();
  };
  useEscapeFromPanel(panelRef, close);
  return (
    <aside
      ref={panelRef}
      aria-labelledby={titleId}
      data-slot="assistant-panel"
      className="lens pointer-events-auto absolute inset-x-0 top-0 bottom-16 z-50 flex flex-col overflow-hidden rounded-xl md:left-auto md:w-[min(26rem,100%)] lg:bottom-0"
    >
      <AssistantHeader titleId={titleId} pending={pending} onClose={close} />
      <div className="grid min-h-0 flex-1 content-start gap-6 overflow-y-auto overscroll-contain px-4.5 pt-2 pb-4.5">
        {destination?.kind === 'ready' ? (
          <AssistantDisclosure destination={destination} inDialog={false}>
            The request includes your description, draft structure, step
            settings and input mappings, and relevant catalog definitions.
            Protected settings and connections are masked.
          </AssistantDisclosure>
        ) : null}
        {panel.asked === undefined ? null : (
          <AskedRequest
            asked={panel.asked}
            pending={pending}
            onEdit={() => {
              panel.edit();
              requestRef.current?.focus();
            }}
          />
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
              <ProposalActions
                pending={pending}
                onDiscard={panel.discard}
                onApply={() => {
                  panel.apply(review);
                }}
              />
            ) : null}
          </section>
        )}
        <ProposalFeedback
          activity={panel.activity}
          error={panel.error}
          stale={panel.stale}
          outcome={panel.outcome}
        />
        {panel.recheck ? (
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            disabled={pending}
            onClick={panel.checkAssistant}
          >
            Check again
          </Button>
        ) : null}
      </div>
      {destination?.kind === 'ready' ? (
        <RequestForm
          requestRef={requestRef}
          request={panel.request}
          replacing={review !== undefined}
          pending={pending}
          onChange={panel.setRequest}
          onSend={panel.send}
        />
      ) : null}
    </aside>
  );
}

function AssistantHeader({
  titleId,
  pending,
  onClose,
}: Readonly<{ titleId: string; pending: boolean; onClose: () => void }>) {
  return (
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
        onClick={onClose}
      >
        <XIcon aria-hidden="true" />
      </Button>
    </header>
  );
}

function AskedRequest({
  asked,
  pending,
  onEdit,
}: Readonly<{ asked: string; pending: boolean; onEdit: () => void }>) {
  return (
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
          onClick={onEdit}
        >
          Edit
        </Button>
      </div>
      <p className="wrap-anywhere text-foreground">{asked}</p>
    </section>
  );
}

function ProposalActions({
  pending,
  onDiscard,
  onApply,
}: Readonly<{ pending: boolean; onDiscard: () => void; onApply: () => void }>) {
  return (
    <div className="flex justify-end gap-2">
      <Button
        type="button"
        variant="ghost"
        disabled={pending}
        onClick={onDiscard}
      >
        Discard
      </Button>
      <Button
        type="button"
        variant="primary"
        disabled={pending}
        onClick={onApply}
      >
        Apply to draft
      </Button>
    </div>
  );
}

function RequestForm({
  requestRef,
  request,
  replacing,
  pending,
  onChange,
  onSend,
}: Readonly<{
  requestRef: RefObject<HTMLTextAreaElement | null>;
  request: string;
  /** A proposal is on screen, which the next request replaces. */
  replacing: boolean;
  pending: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
}>) {
  return (
    <form
      className="grid gap-2 border-t border-border px-3.5 pt-3 pb-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <label className="grid gap-2 text-meta font-medium">
        What should the workflow do?
        <Textarea
          ref={requestRef}
          value={request}
          placeholder={
            replacing
              ? 'New request · replaces this proposal'
              : 'Describe a change to this workflow'
          }
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return;
            event.preventDefault();
            onSend();
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
  );
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
