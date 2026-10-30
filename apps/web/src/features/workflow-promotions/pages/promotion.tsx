import {
  isWorkspaceBrowsable,
  holdsCapability,
} from '@/features/workspaces/availability.public';
import { usePromotionApply } from '../data/promotions.mutations';
import { QueryView } from '@/components/patterns/states/query-view';
import { PromotionActionFields } from '../components/action-fields';
import { PromotionCommandFeedback } from '../components/command-feedback';
import {
  promotionReviewIsCurrent,
  promotionActionLabel,
  promotionCanApply,
} from '../model/review';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  AccessibleWorkspace,
  WorkflowPromotionMode,
  WorkflowPromotionSettings,
  WorkflowPromotionPreviewRequest,
} from '@pertexo/contracts';
import { PageHeader, PageHeaderTitle } from '@/components/patterns/page-header';
import { SettingsSection } from '@/components/patterns/settings/section';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';

import { describeCommandError } from '@/lib/api/error-copy';
import { previewPromotion, type PromotionScope } from '../data/promotions.api';
import { promotionSettingsQuery } from '../data/promotions.queries';
import { promotionSelections } from '../model/search';
import { PromotionTarget } from '../components/target';
import { PromotionLink } from '../components/link';
import { PromotionSelection } from '../components/selection';
import { PromotionConfirmation } from '../components/confirmation';
import { PromotionResult } from '../components/result';
import { PromotionHistory } from '../components/history';

interface PromotionPageProps {
  scope: PromotionScope;
  workspace: AccessibleWorkspace;
  selected?: string;
  onSelect: (selections: WorkflowPromotionPreviewRequest['selections']) => void;
}

export function WorkflowPromotionPage({
  scope,
  workspace,
  selected,
  onSelect,
}: PromotionPageProps) {
  const allowed = canReadPromotion(workspace);
  const paused = workspace.status !== 'active';
  const settings = useQuery({
    ...promotionSettingsQuery(scope),
    enabled: allowed,
  });
  const selections = promotionSelections(selected);
  const [mode, setMode] = useState<WorkflowPromotionMode>('draft');
  const [note, setNote] = useState('');
  const [acknowledged, setAcknowledged] = useState<readonly string[]>([]);
  const review = useMutation({
    mutationFn: ({ body }: ReviewInput) => previewPromotion(scope, body),
    retry: false,
  });
  const command = usePromotionApply(scope, () => {
    review.reset();
    setAcknowledged([]);
  });
  const locked = command.pending || command.uncertain;
  const busy = locked || review.isPending;
  const compatibleReview = promotionReviewIsCurrent({
    review: review.data,
    context: review.variables,
    settings: settings.data,
    selections,
    mode,
  });
  const ready = promotionCanApply({
    review: review.data,
    current: compatibleReview,
    acknowledged,
    mode,
    note,
    completed: command.data !== undefined,
  });
  function clearReview() {
    if (locked) return;
    review.reset();
    command.reset();
    setAcknowledged([]);
  }
  if (!allowed) return <PromotionUnavailable />;
  return (
    <QueryView query={settings} resource="Promotion settings">
      {(snapshot) => (
        <div className="flex min-w-0 max-w-5xl flex-col gap-7">
          <PageHeader>
            <PageHeaderTitle>Promotion</PageHeaderTitle>
          </PageHeader>
          <LinkedPromotionTarget
            scope={scope}
            workspaceName={workspace.name}
            snapshot={snapshot}
            disabled={busy || paused}
            onChange={clearReview}
          />
          {snapshot.target?.status === 'available' && !paused ? (
            <SettingsSection
              title={`Promote to ${snapshot.target.name}`}
              description="Select exact published versions, check target setup and review the differences before applying."
            >
              <PromotionSelection
                scope={scope}
                selections={selections}
                locked={busy}
                onChange={(next) => {
                  clearReview();
                  onSelect(next);
                }}
              />
              <PromotionActionFields
                mode={mode}
                note={note}
                disabled={busy}
                requireApproval={snapshot.target.requireApproval}
                onMode={(value) => {
                  clearReview();
                  setMode(value);
                }}
                onNote={setNote}
              />
              <Button
                className="self-start"
                variant="outline"
                disabled={busy || selections.length === 0}
                onClick={() => {
                  setAcknowledged([]);
                  command.reset();
                  review.mutate({
                    body: { selections, mode },
                    linkRevision: snapshot.revision,
                  });
                }}
              >
                {review.isPending ? 'Reviewing…' : 'Review promotion'}
              </Button>
              {review.isError ? (
                <Notice tone="warning">
                  {describeCommandError(
                    review.error,
                    'reviewing this promotion',
                  )}
                </Notice>
              ) : null}
              <PromotionConfirmation
                review={review.data}
                current={compatibleReview}
                acknowledged={acknowledged}
                locked={busy}
                onAcknowledge={(id, checked) => {
                  setAcknowledged((current) =>
                    checked
                      ? [...current, id]
                      : current.filter((value) => value !== id),
                  );
                }}
                renderAction={(reviewed) => (
                  <PromotionApplyAction
                    command={command}
                    fingerprint={reviewed.fingerprint}
                    mode={mode}
                    note={note}
                    selections={selections}
                    acknowledged={acknowledged}
                    disabled={busy || !ready}
                  />
                )}
              />
              <PromotionCommandFeedback
                command={command}
                retryLabel="Retry same promotion"
              />
              {command.data === undefined ? null : (
                <PromotionResult result={command.data} />
              )}
            </SettingsSection>
          ) : null}
          <PromotionHistory scope={scope} />
        </div>
      )}
    </QueryView>
  );
}

function PromotionUnavailable() {
  return (
    <div className="flex min-w-0 max-w-5xl flex-col gap-7">
      <PageHeader>
        <PageHeaderTitle>Promotion</PageHeaderTitle>
      </PageHeader>
      <Notice>Promotion needs edit access in an active workspace.</Notice>
    </div>
  );
}

function PromotionApplyAction({
  command,
  fingerprint,
  mode,
  note,
  selections,
  acknowledged,
  disabled,
}: Readonly<{
  command: ReturnType<typeof usePromotionApply>;
  fingerprint: string;
  mode: WorkflowPromotionMode;
  note: string;
  selections: WorkflowPromotionPreviewRequest['selections'];
  acknowledged: readonly string[];
  disabled: boolean;
}>) {
  return (
    <Button
      className="self-start"
      disabled={disabled}
      onClick={() => {
        void command.send({
          selections,
          mode,
          fingerprint: fingerprint,
          acknowledgeTargetChanges: [...acknowledged],
          ...(mode === 'request_approval' ? { note } : {}),
        });
      }}
    >
      {command.pending ? 'Applying…' : promotionActionLabel(mode)}
    </Button>
  );
}

function LinkedPromotionTarget({
  scope,
  workspaceName,
  snapshot,
  disabled,
  onChange,
}: Readonly<{
  scope: PromotionScope;
  workspaceName: string;
  snapshot: WorkflowPromotionSettings;
  disabled: boolean;
  onChange: () => void;
}>) {
  return (
    <>
      {' '}
      <PromotionLink workspaceName={workspaceName} target={snapshot.target} />
      <SettingsSection
        title="Linked workspaces"
        description="Send reviewed workflows from here to another workspace, such as production. Values and secrets stay where they are."
      >
        <PromotionTarget
          scope={scope}
          snapshot={snapshot}
          disabled={disabled}
          onChange={onChange}
        />
      </SettingsSection>
    </>
  );
}

type ReviewInput = Readonly<{
  body: WorkflowPromotionPreviewRequest;
  linkRevision: number;
}>;

function canReadPromotion(workspace: AccessibleWorkspace): boolean {
  return (
    holdsCapability(workspace, 'workflow:update') &&
    isWorkspaceBrowsable(workspace)
  );
}
