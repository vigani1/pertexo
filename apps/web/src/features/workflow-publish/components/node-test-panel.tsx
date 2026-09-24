import type { PreviewRunSummary } from '@pertexo/contracts/schemas/node-testing';
import { FlaskConicalIcon, ListChecksIcon } from 'lucide-react';
import { useImperativeHandle, useState, type Ref } from 'react';
import { Notice } from '@/components/ui/notice';
import { JsonTree } from '@/components/patterns/json-tree';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Status, StatusGlyph } from '@/components/ui/status';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ArtifactDownload } from '@/features/artifacts/public';
import type { ApiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import {
  describePreviewStatus,
  sideEffectSentence,
} from '../model/preview-observation';
import { describeValidationIssue } from '../model/workflow-issues';
import { useNodeTest } from '../use-node-test';

export type NodeTestHandle = Readonly<{ runTest: () => void }>;

/**
 * The inspector's Test tab: check the step's setup (read-only), then run it
 * for real after acknowledging what that does outside Pertexo.
 */
export function NodeTestPanel({
  apiClient,
  workspaceId,
  workflowId,
  nodeId,
  stepSideEffect,
  priorPreview,
  ensureSaved,
  onSucceeded,
  actionRef,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  nodeId: string;
  stepSideEffect: string | undefined;
  /** A passed test of the step right before this one. */
  priorPreview: Readonly<{ id: string; stepName: string }> | undefined;
  ensureSaved: () => Promise<Readonly<{ revision: number }>>;
  onSucceeded?: (preview: PreviewRunSummary) => void;
  actionRef?: Ref<NodeTestHandle>;
}>) {
  const [input, setInput] = useState('{}');
  const [usePrior, setUsePrior] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const test = useNodeTest({
    apiClient,
    workspaceId,
    workflowId,
    nodeId,
    ensureSaved,
    ...(onSucceeded === undefined ? {} : { onSucceeded }),
  });
  const priorId = usePrior ? priorPreview?.id : undefined;
  const canRun = test.pending === undefined && (test.observing || acknowledged);

  function run() {
    if (!canRun) return;
    void (test.observing
      ? test.resume()
      : test.runTest({
          text: input,
          ...(priorId === undefined ? {} : { priorPreviewId: priorId }),
        }));
  }
  useImperativeHandle(actionRef, () => ({ runTest: run }));

  return (
    <div
      className={cn(
        'flex flex-col gap-4 rounded-lg',
        test.pending === 'run' && 'live-edge',
      )}
    >
      {priorPreview === undefined ? null : (
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Use the output from testing {priorPreview.stepName}</span>
          <Switch checked={usePrior} onCheckedChange={setUsePrior} />
        </label>
      )}
      {usePrior ? null : (
        <Field>
          <FieldLabel htmlFor={`test-input-${nodeId}`}>
            Sample input (JSON)
          </FieldLabel>
          <Textarea
            id={`test-input-${nodeId}`}
            name="previewInput"
            autoComplete="off"
            spellCheck={false}
            className="min-h-24 font-mono"
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setAcknowledged(false);
              test.inputChanged();
            }}
          />
        </Field>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={test.pending !== undefined}
          onClick={() => void test.checkSetup(input)}
        >
          {test.pending === 'check' ? (
            <LoadingOrb />
          ) : (
            <ListChecksIcon data-icon="inline-start" />
          )}
          {test.pending === 'check' ? 'Checking…' : 'Check setup'}
        </Button>
      </div>
      <SetupCheck check={test.check} />
      <Field>
        <FieldDescription>
          {sideEffectSentence(stepSideEffect, test.check?.disclosure)}
        </FieldDescription>
        <label className="flex items-center justify-between gap-3 text-sm font-medium">
          <span>I understand this test runs for real</span>
          <Switch checked={acknowledged} onCheckedChange={setAcknowledged} />
        </label>
      </Field>
      <Button type="button" disabled={!canRun} onClick={run}>
        {test.pending === 'run' ? (
          <LoadingOrb />
        ) : (
          <FlaskConicalIcon data-icon="inline-start" />
        )}
        {runLabel(test)}
      </Button>
      <TestResult
        preview={test.preview}
        apiClient={apiClient}
        workspaceId={workspaceId}
      />
      {test.error === undefined ? null : (
        <Notice tone="destructive">{test.error}</Notice>
      )}
    </div>
  );
}

function runLabel(test: ReturnType<typeof useNodeTest>): string {
  if (test.pending === 'run') return 'Testing…';
  if (test.observing) return 'Check test status';
  if (test.recoveryPending) return 'Retry the same test';
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
  const status = describePreviewStatus(preview.status);
  return (
    <section aria-label="Test result" className="flex flex-col gap-2">
      <p role="status">
        <Status tone={status.tone}>{status.label}</Status>
      </p>
      {preview.output?.kind === 'inline' ? (
        <JsonTree value={preview.output.value} label="Test output" />
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
