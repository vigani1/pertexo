import { useRunInput } from '@/features/workflow-runs/run-input.public';
import { WorkflowTestActions } from './controls';
import { useState } from 'react';
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

type WorkflowTestDialogProps = Readonly<{
  tests: WorkflowTests;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary | undefined;
  graph: WorkflowGraphContract;
}>;

export function WorkflowTestDialog(props: WorkflowTestDialogProps) {
  const model = useWorkflowTestForm(props);
  const trigger = model.trigger;
  return (
    <Dialog
      open={model.tests.open}
      onOpenChange={(open) => {
        if (!model.locked || model.tests.start.expired)
          model.tests.setOpen(open);
      }}
    >
      <DialogContent className="flex max-h-[calc(100svh-2rem)] flex-col gap-4 overflow-y-auto">
        <div>
          <DialogTitle>Test workflow</DialogTitle>
          <DialogDescription>
            Runs the saved draft. Pins replace their steps; every other step
            runs for real. Test data stays for seven days.
          </DialogDescription>
        </div>
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
              {model.tests.preparation.samples.length} pinned steps. Wait
              finishes immediately. Pin Approval, Request input and Call steps
              to continue past them.
            </p>
            {model.workflow === undefined ? null : (
              <InputCasesPanel
                readOnly
                cases={model.cases}
                workspace={model.workspace}
                workflow={model.workflow}
                disabled={model.locked}
                editing={model.editingCase}
                onEditingChange={model.setEditingCase}
                onLoad={(loaded) => {
                  model.input.reset(JSON.stringify(loaded.input, null, 2));
                }}
                onAccessLost={() => {
                  model.input.reset();
                }}
              />
            )}
            {trigger === undefined ? null : (
              <Button
                type="button"
                variant="outline"
                disabled={model.locked}
                onClick={() => {
                  void model.tests
                    .loadTriggerInput(trigger.id)
                    .then((value) => {
                      if (value !== undefined)
                        model.input.reset(JSON.stringify(value, null, 2));
                    });
                }}
              >
                Use trigger’s pinned sample
              </Button>
            )}
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
                    model.input.changeInput(event.currentTarget.value);
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
        <WorkflowTestActions
          tests={model.tests}
          inputBlocked={
            model.editingCase || model.cases.pending || model.cases.uncertain
          }
          acknowledged={model.acknowledged}
          onSubmit={() => void model.submit()}
          onPrepare={() => {
            model.setAcknowledged(false);
            model.input.validation.reset();
            void model.tests.prepare();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function useWorkflowTestForm({
  tests,
  workspace,
  workflow,
  graph,
}: WorkflowTestDialogProps) {
  const input = useRunInput();
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
