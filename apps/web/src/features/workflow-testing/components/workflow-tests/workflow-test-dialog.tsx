import { ConfirmationDetails } from '@/components/patterns/actions/confirm-dialog';
import { useRunInput } from '@/features/workflow-runs/input.public';
import { WorkflowTestActions } from './workflow-test-controls';
import { useEffect, useRef, useState } from 'react';
import type {
  AccessibleWorkspace,
  WorkflowSummary,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import { isWorkflowTriggerDefinition } from '@pertexo/workflow-model';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { LabelledField } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { Notice } from '@/components/ui/notice';
import {
  InputCasesPanel,
  useInputCases,
} from '@/features/workflows/input-cases.public';
import type { WorkflowTests } from '../../hooks/use-workflow-tests';
import { formatCount } from '@/lib/format/count';

type WorkflowTestDialogProps = Readonly<{
  tests: WorkflowTests;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary | undefined;
  graph: WorkflowGraphContract;
}>;

export function WorkflowTestDialog(props: WorkflowTestDialogProps) {
  const model = useWorkflowTestForm(props);
  return (
    <Dialog
      open={model.tests.open}
      onOpenChange={(open) => {
        if (!model.locked || model.tests.start.expired) model.setOpen(open);
      }}
    >
      <DialogContent className="flex h-[44rem] flex-col gap-4 overflow-hidden max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11">
        <div className="shrink-0">
          <DialogTitle>Test workflow</DialogTitle>
          <DialogDescription>
            Runs the saved draft. Pins replace their steps; every other step
            runs for real. Test data stays for seven days.
          </DialogDescription>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <ConfirmationDetails>
            {model.tests.preparing ? (
              <p role="status">Saving and preparing the draft…</p>
            ) : null}
            {model.tests.preparationError === undefined ? null : (
              <Notice tone="destructive">{model.tests.preparationError}</Notice>
            )}
            {model.tests.preparation === undefined ? null : (
              <>
                <p className="text-sm text-muted-foreground">
                  Draft revision {model.tests.preparation.draftRevision} ·{' '}
                  {formatCount(
                    model.tests.preparation.samples.length,
                    'pinned step',
                  )}
                  . Wait finishes immediately. Pin Approval, Request input and
                  Call steps to continue past them.
                </p>
                {model.workflow === undefined ? null : (
                  <InputCasesPanel
                    readOnly
                    cases={model.cases}
                    disabled={model.locked}
                    editing={model.editingCase}
                    onEditingChange={model.setEditingCase}
                    onLoad={(loaded) => {
                      model.replaceInput(JSON.stringify(loaded.input, null, 2));
                    }}
                    onAccessLost={() => {
                      model.replaceInput();
                    }}
                    scope={{
                      workspace: model.workspace,
                      workflow: model.workflow,
                    }}
                  />
                )}
                <TriggerSampleControl model={model} />
                <LabelledField
                  id="workflow-test-input"
                  label="Test input (JSON)"
                  error={model.input.validation.error('input')}
                  description="Use {} if the workflow doesn’t read any input."
                >
                  {(control) => (
                    <Textarea
                      {...control}
                      ref={model.input.validation.register('input')}
                      value={model.input.input}
                      onChange={(event) => {
                        model.changeInput(event.currentTarget.value);
                      }}
                      disabled={model.locked}
                      autoComplete="off"
                      spellCheck={false}
                      className="min-h-28 font-mono"
                    />
                  )}
                </LabelledField>
                {model.tests.preparation.effectfulSteps.length === 0 ? null : (
                  <section
                    aria-label="Steps with effects"
                    className="flex flex-col gap-3"
                  >
                    <p className="text-sm">
                      These unpinned steps can change real data:
                    </p>
                    <ul className="list-inside list-disc text-sm">
                      {model.tests.preparation.effectfulSteps.map((step) => (
                        <li key={step.nodeId}>{step.label}</li>
                      ))}
                    </ul>
                    <LabelledField
                      id="workflow-test-effects"
                      label="I understand this test runs for real"
                    >
                      {(control) => (
                        <Switch
                          {...control}
                          checked={model.acknowledged}
                          onCheckedChange={model.setAcknowledged}
                          disabled={model.locked}
                        />
                      )}
                    </LabelledField>
                  </section>
                )}
              </>
            )}
            {model.tests.start.error === undefined ? null : (
              <Notice tone="destructive">{model.tests.start.error}</Notice>
            )}
          </ConfirmationDetails>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <WorkflowTestActions
            tests={model.tests}
            inputBlocked={
              model.editingCase ||
              model.cases.pending ||
              model.sampleState.kind === 'loading'
            }
            acknowledged={model.acknowledged}
            onSubmit={() => void model.submit()}
            onClose={() => {
              model.setOpen(false);
            }}
            onPrepare={() => {
              model.setAcknowledged(false);
              model.input.validation.reset();
              void model.tests.prepare();
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TriggerSampleControl({
  model,
}: Readonly<{ model: ReturnType<typeof useWorkflowTestForm> }>) {
  const trigger = model.trigger;
  return (
    <>
      {trigger === undefined ? null : (
        <Button
          type="button"
          variant="outline"
          disabled={model.locked || model.sampleState.kind === 'loading'}
          onClick={() => {
            void model.loadTriggerInput();
          }}
        >
          {model.sampleState.kind === 'loading'
            ? 'Loading pinned sample…'
            : 'Use trigger’s pinned sample'}
        </Button>
      )}
      {model.sampleState.kind === 'loading' ? (
        <p role="status">
          Loading the trigger’s pinned sample. You can keep editing your input.
        </p>
      ) : null}
      {model.sampleState.kind === 'ready' ? (
        <Notice
          action={
            <Button
              type="button"
              variant="outline"
              disabled={model.locked}
              onClick={model.applyTriggerInput}
            >
              Apply loaded sample
            </Button>
          }
        >
          The pinned sample is ready. Your edited input is kept.
        </Notice>
      ) : null}
      {model.sampleState.kind === 'applied' ? (
        <p role="status">Pinned sample loaded.</p>
      ) : null}
    </>
  );
}

type TriggerInputSample =
  | Readonly<{ kind: 'idle' | 'loading' | 'applied' }>
  | Readonly<{ kind: 'ready'; value: unknown }>;

function useWorkflowTestForm({
  tests,
  workspace,
  workflow,
  graph,
}: WorkflowTestDialogProps) {
  const input = useRunInput();
  const [sampleResult, setSampleResult] = useState<
    Readonly<{
      preparation: WorkflowTests['preparation'];
      sample: TriggerInputSample;
    }>
  >({ preparation: tests.preparation, sample: { kind: 'idle' } });
  const sampleState: TriggerInputSample =
    sampleResult.preparation === tests.preparation
      ? sampleResult.sample
      : { kind: 'idle' };
  function setSampleState(sample: TriggerInputSample) {
    setSampleResult({ preparation: tests.preparation, sample });
  }
  const sampleGeneration = useRef(0);
  const inputRevision = useRef(0);
  useEffect(() => {
    // A closed or newly prepared dialog no longer owns the outstanding read.
    return () => {
      sampleGeneration.current += 1;
    };
  }, [tests.open, tests.preparation]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [editingCase, setEditingCase] = useState(false);
  const cases = useInputCases({
    api: tests.scope.apiClient,
    userId: tests.scope.userId,
    workspaceId: workspace.id,
    workflowId: tests.scope.workflowId,
    canWrite: false,
    enabled: tests.open && tests.enabled,
  });
  const locked = tests.start.pending || tests.start.uncertain;
  const trigger = graph.nodes.find(
    (node) =>
      isWorkflowTriggerDefinition(node.definition) &&
      tests.preparation?.samples.some((pin) => pin.nodeId === node.id),
  );
  function setOpen(open: boolean) {
    if (!open) {
      sampleGeneration.current += 1;
      setSampleState({ kind: 'idle' });
    }
    tests.setOpen(open);
  }
  function changeInput(text: string) {
    inputRevision.current += 1;
    input.changeInput(text);
  }
  function replaceInput(text = '{}') {
    inputRevision.current += 1;
    input.reset(text);
  }
  async function loadTriggerInput() {
    if (trigger === undefined || locked) return;
    const generation = ++sampleGeneration.current;
    const revision = inputRevision.current;
    setSampleState({ kind: 'loading' });
    const value = await tests.loadTriggerInput(trigger.id);
    if (generation !== sampleGeneration.current) return;
    if (value === undefined) setSampleState({ kind: 'idle' });
    else if (revision !== inputRevision.current)
      setSampleState({ kind: 'ready', value });
    else {
      replaceInput(JSON.stringify(value, null, 2));
      setSampleState({ kind: 'applied' });
    }
  }
  function applyTriggerInput() {
    if (sampleState.kind !== 'ready' || locked) return;
    replaceInput(JSON.stringify(sampleState.value, null, 2));
    setSampleState({ kind: 'applied' });
  }
  async function submit() {
    const intent = input.read();
    if (intent === undefined) return;
    try {
      await tests.submit({
        input: intent.value,
        acknowledgeSideEffects: acknowledged,
      });
    } catch {
      input.validation.showErrors({
        input: 'Enter valid JSON within the run-data limits.',
      });
    }
  }

  return {
    tests,
    sampleState,
    setOpen,
    loadTriggerInput,
    applyTriggerInput,
    changeInput,
    replaceInput,
    locked,
    workflow,
    cases,
    workspace,
    editingCase,
    setEditingCase,
    input,
    trigger,
    acknowledged,
    setAcknowledged,
    submit,
  } as const;
}
