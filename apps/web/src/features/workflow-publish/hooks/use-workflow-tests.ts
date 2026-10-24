import { commandIsLive } from '../model/testing/ownership';
import { useTestSuites } from './use-test-suites';
import { getStepSample } from '../data/samples/api';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  workflowTestStartRequestSchema,
  type WorkflowTestPreparation,
  type WorkflowTestStartRequest,
} from '@pertexo/contracts';
import { workflowRunQueryOptions } from '@/features/workflow-runs/queries.public';
import { isActiveRunStatus } from '@/features/workflow-runs/run-labels.public';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { describeCommandError } from '@/lib/api/error-copy';
import { isApiError } from '@/lib/api/error';
import {
  prepareWorkflowTest,
  startWorkflowTest,
  cancelWorkflowTest,
  type WorkflowTestScope,
} from '../data/workflow-tests/api';
import {
  workflowTestsKey,
  workflowTestsQueryOptions,
  workflowTestQueryOptions,
} from '../data/workflow-tests/queries';

export function useWorkflowTests({
  scope,
  enabled,
  ensureSaved,
  verifyIdentity,
}: Readonly<{
  scope: WorkflowTestScope;
  enabled: boolean;
  ensureSaved: () => Promise<{ revision: number }>;
  verifyIdentity: () => Promise<void>;
}>) {
  // The tests bar shows only for test activity: a test or suite started here,
  // or history the person asked for. A running test shows it regardless.
  const [panel, setPanel] = useState<'hidden' | 'summary' | 'history'>(
    'hidden',
  );
  const suites = useTestSuites({
    scope,
    enabled,
    ensureSaved,
    verifyIdentity,
    onStarted: () => {
      setPanel('history');
    },
  });
  const queryClient = useQueryClient();
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
    };
  }, []);
  const [open, setOpen] = useState(false);
  const [preparation, setPreparation] = useState<WorkflowTestPreparation>();
  const [preparing, setPreparing] = useState(false);
  const [preparationError, setPreparationError] = useState<string>();
  const [selectedRunId, selectRun] = useState<string>();
  const history = useQuery({
    ...workflowTestsQueryOptions(scope),
    enabled,
    refetchInterval: (query) =>
      (query.state.data?.items.some((item) => isActiveRunStatus(item.status)) ??
      false)
        ? 2000
        : false,
  });
  const activeId = selectedRunId ?? history.data?.items[0]?.runId;
  const snapshot = useQuery({
    ...workflowTestQueryOptions(scope, activeId ?? ''),
    enabled: enabled && activeId !== undefined,
  });
  const progress = useQuery({
    ...workflowRunQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspaceId,
      activeId ?? '',
    ),
    enabled: enabled && activeId !== undefined,
  });
  const blocked =
    history.data?.items.some(
      (item) =>
        item.startedBy === scope.userId &&
        isActiveRunStatus(
          item.runId === progress.data?.run.id
            ? progress.data.run.status
            : item.status,
        ),
    ) ?? false;
  async function signal() {
    const controller = lifetime.current;
    if (controller === undefined || controller.signal.aborted || !enabled)
      throw new DOMException('Aborted', 'AbortError');
    await verifyIdentity();
    return controller.signal;
  }
  const start = useRetainedCommand<WorkflowTestStartRequest, { runId: string }>(
    async (body, key) => startWorkflowTest(scope, body, key, await signal()),
    async (result) => {
      if (!commandIsLive(lifetime.current)) return;
      selectRun(result.runId);
      setOpen(false);
      setPanel((current) => (current === 'history' ? current : 'summary'));
      await queryClient.invalidateQueries({
        queryKey: [...workflowTestsKey(scope), 'list'],
        exact: true,
      });
    },
    { action: 'starting the workflow test' },
  );
  const cancel = useRetainedCommand<string, undefined>(
    async (runId) => {
      await cancelWorkflowTest(scope, runId, await signal());
      return undefined;
    },
    async () => {
      await queryClient.invalidateQueries({
        queryKey: [...workflowTestsKey(scope), 'list'],
        exact: true,
      });
    },
    { action: 'canceling the workflow test' },
  );
  async function prepare() {
    if (preparing || start.pending || start.uncertain) return;
    start.reset();
    setPreparing(true);
    setPreparationError(undefined);
    setPreparation(undefined);
    setOpen(true);
    try {
      const saved = await ensureSaved();
      const result = await prepareWorkflowTest(scope, await signal());
      if (!commandIsLive(lifetime.current)) return;
      if (result.draftRevision !== saved.revision)
        throw new Error('The saved draft changed. Save and prepare again.');
      setPreparation(result);
    } catch (error) {
      if (commandIsLive(lifetime.current))
        setPreparationError(
          isApiError(error)
            ? (error.problem?.detail ??
                describeCommandError(error, 'preparing the test'))
            : describeCommandError(error, 'preparing the test'),
        );
    } finally {
      if (commandIsLive(lifetime.current)) setPreparing(false);
    }
  }
  async function submit({
    input,
    acknowledgeSideEffects,
  }: Readonly<{ input: unknown; acknowledgeSideEffects: boolean }>) {
    if (preparation === undefined) return;
    await start.send(
      workflowTestStartRequestSchema.parse({
        expectedRevision: preparation.draftRevision,
        expectedSamples: preparation.samples,
        expectedEffectfulSteps: preparation.effectfulSteps.map(
          (step) => step.nodeId,
        ),
        input,
        acknowledgeSideEffects,
      }),
    );
  }
  async function loadTriggerInput(nodeId: string) {
    try {
      const sample = await getStepSample(scope, nodeId, await signal());
      return commandIsLive(lifetime.current) ? sample.output : undefined;
    } catch (error) {
      if (commandIsLive(lifetime.current))
        setPreparationError(
          describeCommandError(error, 'loading the trigger sample'),
        );
      return undefined;
    }
  }
  return {
    suites,
    loadTriggerInput,
    scope,
    open,
    setOpen,
    prepare,
    preparing,
    preparation,
    preparationError,
    submit,
    start,
    cancel,
    history,
    snapshot,
    progress,
    activeId,
    selectRun,
    blocked: blocked || suites.blocked,
    enabled,
    panel,
    showHistory: () => {
      setPanel('history');
    },
    showSummary: () => {
      setPanel('summary');
    },
    hidePanel: () => {
      setPanel('hidden');
    },
  };
}
export type WorkflowTests = ReturnType<typeof useWorkflowTests>;
