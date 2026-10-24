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

export function WorkflowTestDialog({
  tests,
  workspace,
  workflow,
  graph,
}: Readonly<{
  tests: WorkflowTests;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary | undefined;
  graph: WorkflowGraphContract;
}>) {
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
      await tests.submit(intent.value, acknowledged);
    } catch {
      input.validation.showErrors({
        input: 'Enter valid JSON within the run-data limits.',
      });
    }
  }
  return (
    <Dialog
      open={tests.open}
      onOpenChange={(open) => {
        if (!locked || tests.start.expired) tests.setOpen(open);
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
        {tests.preparing ? (
          <p role="status">Saving and preparing the draft…</p>
        ) : null}
        {tests.preparationError === undefined ? null : (
          <Notice tone="destructive">{tests.preparationError}</Notice>
        )}
        {tests.preparation === undefined ? null : (
          <>
            <p className="text-sm text-muted-foreground">
              Draft revision {tests.preparation.draftRevision} ·{' '}
              {tests.preparation.samples.length} pinned steps. Wait finishes
              immediately. Pin Approval, Request input and Call steps to
              continue past them.
            </p>
            {workflow === undefined ? null : (
              <InputCasesPanel
                readOnly
                cases={cases}
                workspace={workspace}
                workflow={workflow}
                disabled={locked}
                editing={editingCase}
                onEditingChange={setEditingCase}
                onLoad={(loaded) => {
                  input.reset(JSON.stringify(loaded.input, null, 2));
                }}
                onAccessLost={() => {
                  input.reset();
                }}
              />
            )}
            {trigger === undefined ? null : (
              <Button
                type="button"
                variant="outline"
                disabled={locked}
                onClick={() => {
                  void tests.loadTriggerInput(trigger.id).then((value) => {
                    if (value !== undefined)
                      input.reset(JSON.stringify(value, null, 2));
                  });
                }}
              >
                Use trigger’s pinned sample
              </Button>
            )}
            <LabelledField
              id="workflow-test-input"
              label="Test input (JSON)"
              error={input.validation.error('input')}
              description="Use {} if the workflow doesn’t read any input."
            >
              {(control) => (
                <Textarea
                  {...control}
                  ref={input.validation.register('input')}
                  value={input.input}
                  onChange={(event) => {
                    input.changeInput(event.currentTarget.value);
                  }}
                  disabled={locked}
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-28 font-mono"
                />
              )}
            </LabelledField>
            {tests.preparation.effectfulSteps.length === 0 ? null : (
              <section
                aria-label="Steps with effects"
                className="flex flex-col gap-3"
              >
                <p className="text-sm">
                  These unpinned steps can change real data:
                </p>
                <ul className="list-inside list-disc text-sm">
                  {tests.preparation.effectfulSteps.map((step) => (
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
                      checked={acknowledged}
                      onCheckedChange={setAcknowledged}
                      disabled={locked}
                    />
                  )}
                </LabelledField>
              </section>
            )}
          </>
        )}
        {tests.start.error === undefined ? null : (
          <Notice tone="destructive">{tests.start.error}</Notice>
        )}
        <WorkflowTestActions
          tests={tests}
          inputBlocked={editingCase || cases.pending || cases.uncertain}
          acknowledged={acknowledged}
          onSubmit={() => void submit()}
          onPrepare={() => {
            setAcknowledged(false);
            input.validation.reset();
            void tests.prepare();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
