import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  workflowTestSuiteStartRequestSchema,
  type WorkflowTestSuitePreparation,
  type WorkflowTestSuiteStartRequest,
} from '@pertexo/contracts';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { describeCommandError } from '@/lib/api/error-copy';
import { isApiError } from '@/lib/api/error';
import { commandErrorMessage } from '../data/mutations/command-utils';
import type { WorkflowTestScope } from '../data/workflow-tests/api';
import { workflowTestsKey } from '../data/workflow-tests/queries';
import { prepareSuite, startSuite, cancelSuite } from '../data/test-suites/api';
import {
  suitesKey,
  suitesQueryOptions,
  suiteQueryOptions,
} from '../data/test-suites/queries';
export function useTestSuites({
  scope,
  enabled,
  ensureSaved,
  verifyIdentity,
  onStarted,
}: Readonly<{
  scope: WorkflowTestScope;
  enabled: boolean;
  ensureSaved: () => Promise<{ revision: number }>;
  verifyIdentity: () => Promise<void>;
  /** A suite started, so its progress can show. */
  onStarted?: () => void;
}>) {
  const cache = useQueryClient();
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
    };
  }, [
    enabled,
    scope.apiClient,
    scope.userId,
    scope.workspaceId,
    scope.workflowId,
  ]);
  const [open, setOpen] = useState(false);
  const [preparation, setPreparation] =
    useState<WorkflowTestSuitePreparation>();
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string>();
  const [selectedId, select] = useState<string>();
  const history = useQuery({
    ...suitesQueryOptions(scope),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.status === 'running') === true
        ? 2000
        : false,
  });
  const activeId = selectedId ?? history.data?.items[0]?.suiteId;
  const detail = useQuery({
    ...suiteQueryOptions(scope, activeId ?? ''),
    enabled: enabled && activeId !== undefined,
    refetchInterval: (query) =>
      query.state.data?.status === 'running' ? 1000 : false,
  });
  const latestRunId = detail.data?.cases.reduce<string | null>(
    (last, entry) => entry.runId ?? last,
    null,
  );
  useEffect(() => {
    if (latestRunId !== undefined && latestRunId !== null)
      void cache.invalidateQueries({
        queryKey: [
          ...workflowTestsKey({
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            workflowId: scope.workflowId,
          }),
          'list',
        ],
        exact: true,
      });
  }, [cache, latestRunId, scope.userId, scope.workspaceId, scope.workflowId]);
  const blocked =
    history.data?.items.some(
      (item) =>
        item.startedBy === scope.userId &&
        (item.suiteId === detail.data?.suiteId
          ? detail.data.status
          : item.status) === 'running',
    ) === true;
  async function signal() {
    const controller = lifetime.current;
    if (!enabled || controller === undefined || controller.signal.aborted)
      throw new DOMException('Aborted', 'AbortError');
    await verifyIdentity();
    return controller.signal;
  }
  async function refresh() {
    await Promise.all([
      cache.invalidateQueries({ queryKey: suitesKey(scope) }),
      cache.invalidateQueries({ queryKey: workflowTestsKey(scope) }),
    ]);
  }
  const start = useRetainedCommand<
    WorkflowTestSuiteStartRequest,
    { suiteId: string }
  >(
    async (body, key) => startSuite(scope, body, key, await signal()),
    async (result) => {
      if (lifetime.current?.signal.aborted !== false) return;
      select(result.suiteId);
      setOpen(false);
      onStarted?.();
      await refresh();
    },
    { action: 'starting the test suite' },
  );
  const cancel = useRetainedCommand<string, unknown>(
    async (suiteId) => cancelSuite(scope, suiteId, await signal()),
    refresh,
    { action: 'canceling the test suite' },
  );
  async function prepare() {
    if (preparing || start.pending || start.uncertain) return;
    start.reset();
    setPreparing(true);
    setError(undefined);
    setPreparation(undefined);
    setOpen(true);
    try {
      const saved = await ensureSaved();
      const value = await prepareSuite(scope, await signal());
      if (lifetime.current?.signal.aborted !== false) return;
      if (saved.revision !== value.draftRevision)
        throw new Error('The saved draft changed. Prepare again.');
      setPreparation(value);
    } catch (cause) {
      if (lifetime.current?.signal.aborted === false)
        setError(
          isApiError(cause)
            ? (cause.problem?.detail ??
                describeCommandError(cause, 'preparing the suite'))
            : describeCommandError(cause, 'preparing the suite'),
        );
    } finally {
      if (lifetime.current?.signal.aborted === false) setPreparing(false);
    }
  }
  async function submit({
    acknowledgeSideEffects,
  }: Readonly<{ acknowledgeSideEffects: boolean }>) {
    if (preparation === undefined) return;
    await start.send(
      workflowTestSuiteStartRequestSchema.parse({
        expectedRevision: preparation.draftRevision,
        expectedSamples: preparation.samples,
        expectedEffectfulSteps: preparation.effectfulSteps.map(
          (step) => step.nodeId,
        ),
        expectedCases: preparation.cases.map(({ id, revision }) => ({
          id,
          revision,
        })),
        expectedVariableSetRevision: preparation.variableSetRevision,
        signature: preparation.signature,
        acknowledgeSideEffects,
      }),
    );
  }
  return {
    scope,
    enabled,
    open,
    setOpen,
    preparation,
    preparing,
    error,
    startError:
      start.uncertain || start.cause === null
        ? start.error
        : commandErrorMessage(start.cause, 'starting the suite'),
    prepare,
    start,
    submit,
    cancel,
    history,
    detail,
    activeId,
    select,
    blocked,
  };
}
export type TestSuites = ReturnType<typeof useTestSuites>;
