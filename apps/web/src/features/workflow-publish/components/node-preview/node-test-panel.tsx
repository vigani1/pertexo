import { CodeDiagnostics } from '@/components/patterns/code/diagnostics';
import type { PreviewRunSummary } from '@pertexo/contracts';
import { SampleAvailability } from '../samples/availability';
import { PreviewInputFields, RealTestPermission } from './inputs';
import { useStepSample } from './use-step-sample';
import { FlaskConicalIcon, ListChecksIcon } from 'lucide-react';
import { useImperativeHandle, useState, type Ref, type ReactNode } from 'react';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import { JsonTree } from '@/components/patterns/code/json-tree';
import { Button } from '@/components/ui/button';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Status, StatusGlyph } from '@/components/ui/status';
import { ArtifactDownload, FilePages } from '@/features/artifacts/public';
import { shortStepError } from '@/features/workflow-runs/failure.public';
import type { ApiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import {
  describePreviewStatus,
  canOfferStepTest,
} from '../../model/testing/preview-observation';
import { describeValidationIssue } from '../../model/validation/issues';
import { useNodeTest } from './use-node-test';

export type NodeTestHandle = Readonly<{ runTest: () => void }>;

/**
 * Keep one command owner across pin changes, so an uncertain test retries
 * its original intent while the sample controls follow the shared snapshot.
 */
type NodeTestPanelProps = Readonly<{
  apiClient: ApiClient;
  userId: string;
  editable: boolean;
  children?: ReactNode;
  stepBinding?: string | undefined;
  liveTestUnavailable?: string | undefined;
  workspaceId: string;
  workflowId: string;
  nodeId: string;
  stepSideEffect: string | undefined;
  /** A passed test of the step right before this one. */
  priorPreview: Readonly<{ id: string; stepName: string }> | undefined;
  /** This step's last finished test, shown again when the panel reopens. */
  rememberedPreview?: PreviewRunSummary | undefined;
  ensureSaved: () => Promise<Readonly<{ revision: number }>>;
  onFinished?: (preview: PreviewRunSummary) => void;
  onSucceeded?: (preview: PreviewRunSummary) => void;
  actionRef?: Ref<NodeTestHandle>;
}>;

export function NodeTestPanel(props: NodeTestPanelProps) {
  const model = useNodeTestPanel(props);
  return (
    <div
      className={cn(
        'flex flex-col gap-4 rounded-lg',
        model.test.pending === 'run' && 'live-edge',
      )}
    >
      {model.children}
      {!model.editable ? null : (
        <SampleAvailability
          query={model.sampleQuery}
          sample={model.sample}
          scope={model.scope}
          nodeId={model.nodeId}
          state={model.sampleState}
          preview={model.test.preview}
          ensureSaved={model.ensureSaved}
          disabled={
            model.test.pending !== undefined ||
            model.test.observing ||
            model.test.recoveryPending
          }
        />
      )}
      {model.realBlocked ? <Notice>{model.liveTestUnavailable}</Notice> : null}
      {model.pinned ? null : (
        <PreviewInputFields
          nodeId={model.nodeId}
          priorPreview={model.priorPreview}
          usePrior={model.usePrior}
          onUsePriorChange={model.setUsePrior}
          input={model.input}
          onInputChange={(text) => {
            model.setInput(text);
            model.setAcknowledgedContext(undefined);
            model.test.inputChanged();
          }}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <ProgressButton
          type="button"
          size="sm"
          variant="outline"
          pending={model.test.pending === 'check'}
          pendingLabel="Checking…"
          icon={<ListChecksIcon data-icon="inline-start" />}
          disabled={model.test.pending !== undefined}
          onClick={() => void model.test.checkSetup(model.input)}
        >
          Check setup
        </ProgressButton>
      </div>
      <SetupCheck check={model.test.check} />
      {model.pinned ? null : (
        <RealTestPermission
          stepSideEffect={model.stepSideEffect}
          check={model.test.check}
          acknowledged={model.acknowledged}
          onAcknowledgedChange={(checked) => {
            model.setAcknowledgedContext(
              checked ? model.checkContext : undefined,
            );
          }}
        />
      )}
      <Button type="button" disabled={!model.canRun} onClick={model.run}>
        {model.test.pending === 'run' ? (
          <LoadingOrb />
        ) : (
          <FlaskConicalIcon data-icon="inline-start" />
        )}
        {runLabel({ test: model.test, pinned: model.pinned })}
      </Button>
      <TestResult
        preview={model.test.preview}
        apiClient={model.apiClient}
        workspaceId={model.workspaceId}
      />
      {model.test.error === undefined ? null : (
        <Notice tone="destructive">{model.test.error}</Notice>
      )}
    </div>
  );
}

function useNodeTestPanel({
  apiClient,
  userId,
  editable,
  children,
  stepBinding,
  liveTestUnavailable,
  workspaceId,
  workflowId,
  nodeId,
  stepSideEffect,
  priorPreview,
  rememberedPreview,
  ensureSaved,
  onFinished,
  onSucceeded,
  actionRef,
}: NodeTestPanelProps) {
  const [input, setInput] = useState('{}');
  const [usePrior, setUsePrior] = useState(false);
  const [acknowledgedContext, setAcknowledgedContext] = useState<string>();
  const scope = { apiClient, userId, workspaceId, workflowId };
  const {
    query: sampleQuery,
    sample,
    state: sampleState,
    expectedSampleId,
  } = useStepSample({ scope, nodeId, binding: stepBinding, enabled: editable });
  const pinned = sampleState === 'pinned';
  const checkContext = `${stepBinding ?? ''}:${expectedSampleId ?? 'real'}`;
  const acknowledged = acknowledgedContext === checkContext;
  if (acknowledgedContext !== undefined && acknowledgedContext !== checkContext)
    setAcknowledgedContext(undefined);
  const realBlocked = !pinned && liveTestUnavailable !== undefined;
  const test = useNodeTest({
    apiClient,
    workspaceId,
    workflowId,
    nodeId,
    ensureSaved,
    expectedSampleId,
    checkContext,
    initialPreview: rememberedPreview,
    onSampleConflict: () => {
      void sampleQuery.refetch();
    },
    onFinished,
    onSucceeded,
  });
  const canRun = canOfferStepTest({
    editable,
    test,
    ready: sampleQuery.isSuccess,
    sampleState,
    liveTestUnavailable,
    acknowledged,
  });

  function run() {
    if (!canRun) return;
    const priorId = usePrior ? priorPreview?.id : undefined;
    void (test.observing
      ? test.resume()
      : test.runTest({
          text: input,
          ...(priorId === undefined ? {} : { priorPreviewId: priorId }),
        }));
  }
  useImperativeHandle(actionRef, () => ({ runTest: run }));

  return {
    test,
    children,
    editable,
    sampleQuery,
    sample,
    scope,
    nodeId,
    sampleState,
    ensureSaved,
    realBlocked,
    liveTestUnavailable,
    pinned,
    priorPreview,
    usePrior,
    setUsePrior,
    input,
    setInput,
    setAcknowledgedContext,
    stepSideEffect,
    acknowledged,
    checkContext,
    canRun,
    run,
    apiClient,
    workspaceId,
  } as const;
}

function runLabel({
  test,
  pinned,
}: Readonly<{
  test: ReturnType<typeof useNodeTest>;
  pinned: boolean;
}>): string {
  if (test.pending === 'run') return 'Testing…';
  if (test.observing) return 'Check test status';
  if (test.recoveryPending) return 'Retry the same test';
  if (pinned) return 'Test with pinned output';
  return test.preview === undefined ? 'Run test' : 'Run another test';
}

function SetupCheck({
  check,
}: Readonly<{ check: ReturnType<typeof useNodeTest>['check'] }>) {
  if (check === undefined) return null;
  if (check.valid && check.issues.length === 0)
    return <Status tone="success">Setup looks right</Status>;
  return (
    <section aria-label="Setup issues" className="flex flex-col gap-1.5">
      <Status tone="failure">
        {check.issues.length === 1
          ? '1 thing to fix'
          : `${String(check.issues.length)} things to fix`}
      </Status>
      <ul className="flex flex-col gap-1">
        {check.issues.map((issue) => (
          <li
            key={`${issue.path}\u0000${issue.code}`}
            className="flex items-start gap-2 text-[0.8rem] text-muted-foreground"
          >
            <StatusGlyph tone="failure" className="mt-px text-destructive" />
            {describeValidationIssue(issue)}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TestResult({
  preview,
  apiClient,
  workspaceId,
}: Readonly<{
  preview: PreviewRunSummary | undefined;
  apiClient: ApiClient;
  workspaceId: string;
}>) {
  if (preview === undefined) return null;
  const status = describePreviewStatus(preview.status, preview.pinnedSampleId);
  return (
    <section
      aria-label="Test result"
      // The editor's "View output" brings this section into view.
      data-slot="test-result"
      tabIndex={-1}
      className="flex scroll-mt-4 flex-col gap-2 outline-none"
    >
      <p role="status">
        <Status tone={status.tone}>{status.label}</Status>
      </p>
      {preview.errorSummary === undefined ? null : (
        <p className="text-[0.8rem] leading-relaxed text-foreground">
          {preview.errorSummary}
        </p>
      )}
      {preview.safeErrorCode === null ? null : (
        <p className="text-xs text-muted-foreground">
          {`The step reported: ${shortStepError(preview.safeErrorCode)} `}
          <code className="font-mono text-[0.7rem] text-subtle-foreground">
            {preview.safeErrorCode}
          </code>
        </p>
      )}
      {preview.codeDiagnostics === undefined ? null : (
        <CodeDiagnostics diagnostics={preview.codeDiagnostics} />
      )}
      {preview.output?.kind === 'inline' ? (
        <>
          <FilePages
            value={preview.output.value}
            apiClient={apiClient}
            workspaceId={workspaceId}
          />
          <JsonTree value={preview.output.value} label="Test output" />
        </>
      ) : null}
      {preview.output?.kind === 'artifact' ? (
        <ArtifactDownload
          key={preview.output.artifactId}
          apiClient={apiClient}
          workspaceId={workspaceId}
          artifactId={preview.output.artifactId}
        />
      ) : null}
    </section>
  );
}
