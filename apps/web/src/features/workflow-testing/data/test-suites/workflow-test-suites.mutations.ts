import { useSuiteHistory } from './suite-history';
import { commandIsLive } from '../../model/test-ownership';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  workflowTestSuiteStartRequestSchema,
  type WorkflowTestSuitePreparation,
  type WorkflowTestSuiteStartRequest,
} from '@pertexo/contracts';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { describeCommandError } from '@/lib/api/error-copy';
import { isApiError, UserFacingError } from '@/lib/api/error';
import { commandErrorMessage } from '@/lib/workflows/command-errors';
import type { WorkflowTestScope } from '../workflow-tests/workflow-tests.api';
import { workflowTestsKey } from '../workflow-tests/workflow-tests.queries';
import {
  prepareSuite,
  startSuite,
  cancelSuite,
} from './workflow-test-suites.api';
import { suitesKey } from './workflow-test-suites.queries';
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
  const [caseSource, setCaseSource] = useState<'saved' | 'table'>('saved');
  const [preparation, setPreparation] =
    useState<WorkflowTestSuitePreparation>();
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string>();
  const { history, detail, activeId, select, blocked } = useSuiteHistory({
    scope,
    enabled,
  });
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
      if (!commandIsLive(lifetime.current)) return;
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
  async function prepare(source: 'saved' | 'table' = 'saved') {
    if (preparing || start.pending || start.uncertain) return;
    start.reset();
    setPreparing(true);
    setError(undefined);
    setPreparation(undefined);
    setOpen(true);
    setCaseSource(source);
    try {
      const saved = await ensureSaved();
      const value = await prepareSuite(scope, await signal());
      if (!commandIsLive(lifetime.current)) return;
      if (saved.revision !== value.draftRevision)
        throw new UserFacingError('The saved draft changed. Prepare again.');
      setPreparation(value);
    } catch (cause) {
      if (commandIsLive(lifetime.current))
        setError(
          isApiError(cause)
            ? (cause.problem?.detail ??
                describeCommandError(cause, 'preparing the suite'))
            : describeCommandError(cause, 'preparing the suite'),
        );
    } finally {
      if (commandIsLive(lifetime.current)) setPreparing(false);
    }
  }
  async function submit({
    acknowledgeSideEffects,
    evaluation,
  }: Readonly<{
    acknowledgeSideEffects: boolean;
    evaluation?: Extract<
      WorkflowTestSuiteStartRequest,
      { evaluation: unknown }
    >['evaluation'];
  }>) {
    if (preparation === undefined) return;
    await start.send(
      suiteRequest(preparation, acknowledgeSideEffects, evaluation),
    );
  }
  return {
    scope,
    enabled,
    open,
    caseSource,
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

function suiteRequest(
  preparation: WorkflowTestSuitePreparation,
  acknowledgeSideEffects: boolean,
  evaluation:
    | Extract<
        WorkflowTestSuiteStartRequest,
        { evaluation: unknown }
      >['evaluation']
    | undefined,
) {
  return workflowTestSuiteStartRequestSchema.parse({
    expectedRevision: preparation.draftRevision,
    expectedSamples: preparation.samples,
    expectedEffectfulSteps: preparation.effectfulSteps.map(
      (step) => step.nodeId,
    ),
    ...(evaluation === undefined
      ? {
          expectedCases: preparation.cases.map(({ id, revision }) => ({
            id,
            revision,
          })),
        }
      : { evaluation }),
    expectedVariableSetRevision: preparation.variableSetRevision,
    signature: preparation.signature,
    acknowledgeSideEffects,
  });
}
