import {
  DRAFT_PROPOSAL_MAX_REQUEST_CHARACTERS,
  type DraftProposalResult,
  type WorkflowGraphContract,
} from '@pertexo/contracts';
import { useState, type ComponentProps } from 'react';
import { AssistantDisclosure } from '@/components/patterns/actions/assistant-disclosure';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
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
    'The draft or assistant settings changed. Review the disclosure again.',
  timeout: 'The model request timed out.',
  response_too_large: 'The proposal exceeded the size limit.',
  invalid_response: 'The model returned an unreadable proposal.',
  provider_failure: 'The AI provider could not complete the request.',
} as const;

export function DraftProposal({
  handle,
  open,
  onOpenChange,
  finalFocus,
  graph,
  onFix,
}: Readonly<{
  handle: NonNullable<ComponentProps<typeof Dialog>['handle']>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus: ComponentProps<typeof DialogContent>['finalFocus'];
  graph: WorkflowGraphContract;
  onFix: (target: WorkflowValidationTarget) => void;
}>) {
  const [request, setRequest] = useState('');
  const { disclosure, proposal, apply } = useDraftProposal();
  const destination = disclosure.data;
  const result = proposal.data;
  const activity = proposalActivity({ disclosure, proposal, apply });
  const pending = activity !== undefined;
  const error = apply.error ?? proposal.error ?? disclosure.error;
  const stale =
    isApiError(error) && error.problem?.code === 'workflow.revision_conflict';
  const review = proposalReview(result);
  const feedback = result ?? destination;
  const action = proposalAction(destination, review, result?.kind, stale);

  async function loadDisclosure() {
    proposal.reset();
    apply.reset();
    await disclosure.mutateAsync().catch(() => undefined);
  }

  return (
    <Dialog
      handle={handle}
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
        if (next) void loadDisclosure();
      }}
    >
      <DialogContent finalFocus={finalFocus}>
        <DialogTitle>
          {review === undefined
            ? 'Describe your workflow change'
            : 'Review proposed draft'}
        </DialogTitle>
        <div className="mt-4 grid gap-4">
          {review === undefined ? (
            <ProposalRequest
              destination={destination}
              request={request}
              onRequestChange={setRequest}
              pending={pending}
            />
          ) : (
            <DraftProposalReview
              result={review}
              graph={graph}
              onFix={(target) => {
                onOpenChange(false);
                onFix(target);
              }}
            />
          )}
        </div>
        <ProposalFeedback
          activity={activity}
          error={error}
          stale={stale}
          outcome={feedback?.kind}
        />
        <DialogFooter className="mt-5">
          <DialogClose render={<Button variant="outline" disabled={pending} />}>
            Cancel
          </DialogClose>
          {action.kind === 'regenerate' || action.kind === 'apply' ? (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                void loadDisclosure();
              }}
            >
              Regenerate
            </Button>
          ) : null}
          {action.kind === 'send' ? (
            <Button
              disabled={pending || request.trim() === ''}
              onClick={() => {
                void proposal
                  .mutateAsync({
                    request,
                    confirmation: action.confirmation,
                  })
                  .catch(() => undefined);
              }}
            >
              Send to model
            </Button>
          ) : null}
          {action.kind === 'apply' ? (
            <Button
              disabled={pending}
              onClick={() => {
                void apply
                  .mutateAsync(action.review)
                  .then(() => {
                    onOpenChange(false);
                    setRequest('');
                  })
                  .catch(() => undefined);
              }}
            >
              Apply to draft
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ProposalMutations = ReturnType<typeof useDraftProposal>;
type Disclosure = ProposalMutations['disclosure']['data'];

function proposalReview(result: DraftProposalResult | undefined) {
  return result?.kind === 'inspected' || result?.kind === 'rejected'
    ? result
    : undefined;
}

function proposalAction(
  destination: Disclosure,
  review: ReturnType<typeof proposalReview>,
  outcome: DraftProposalResult['kind'] | undefined,
  stale: boolean,
) {
  if (
    stale ||
    outcome === 'confirmation_changed' ||
    review?.kind === 'rejected'
  )
    return { kind: 'regenerate' as const };
  if (review?.kind === 'inspected') return { kind: 'apply' as const, review };
  if (destination?.kind === 'ready')
    return { kind: 'send' as const, confirmation: destination.confirmation };
  return { kind: 'wait' as const };
}

function ProposalRequest({
  destination,
  request,
  onRequestChange,
  pending,
}: Readonly<{
  destination: Disclosure;
  request: string;
  onRequestChange: (value: string) => void;
  pending: boolean;
}>) {
  if (destination?.kind !== 'ready') return null;
  return (
    <>
      <AssistantDisclosure destination={destination}>
        The request includes your description, filtered draft structure and
        relevant catalog definitions.
      </AssistantDisclosure>
      <label className="grid gap-2 text-sm font-medium">
        What should the workflow do?
        <Textarea
          value={request}
          onChange={(event) => {
            onRequestChange(event.target.value);
          }}
          maxLength={DRAFT_PROPOSAL_MAX_REQUEST_CHARACTERS}
          disabled={pending}
        />
      </label>
    </>
  );
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
            ? 'The draft changed. Regenerate the proposal against the latest revision.'
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
