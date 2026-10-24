import { isUnconfirmedCommand } from '@/lib/api/commands/contract';
import type {
  NodeValidationResponse,
  PreviewRunSummary,
} from '@pertexo/contracts';
import { useEffect, useRef, useState } from 'react';
import { isApiError } from '@/lib/api/error';
import type { ApiClient } from '@/lib/api/client';
import {
  commandErrorMessage,
  parseCommandJson,
} from '../../data/mutations/command-utils';
import {
  observePreview,
  previewTerminalStatuses,
} from '../../model/testing/preview-observation';
import {
  executeWorkflowNodePreview,
  validateWorkflowNode,
  type NodeTestInputSource,
} from '../../data/node-test.api';

type TestAttempt = Readonly<{
  idempotencyKey: string;
  nodeId: string;
  expectedRevision: number;
  source: NodeTestInputSource;
  expectedSampleId: string | null;
}>;

const INPUT_ERROR = 'Sample input must be valid JSON, like {"amount": 1240}.';

/**
 * One step's checks and test runs against its saved draft. A run is keyed
 * once; after an uncertain answer the same run is retried, and an accepted
 * run that couldn't be observed is resumed rather than sent again.
 */
type NodeTestOptions = Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  nodeId: string;
  expectedSampleId: string | null;
  checkContext: string;
  ensureSaved: () => Promise<Readonly<{ revision: number }>>;
  /** A finished test of this step to show until the next one. */
  initialPreview?: PreviewRunSummary | undefined;
  /** Any test that finished, passed or not. */
  onFinished?: ((preview: PreviewRunSummary) => void) | undefined;
  onSucceeded?: ((preview: PreviewRunSummary) => void) | undefined;
  onSampleConflict?: () => void;
}>;

export function useNodeTest(options: NodeTestOptions) {
  const {
    apiClient,
    workspaceId,
    workflowId,
    checkContext,
    initialPreview,
    onSampleConflict,
  } = options;
  const [pending, setPending] = useState<'check' | 'run'>();
  const [checked, setChecked] =
    useState<Readonly<{ context: string; result: NodeValidationResponse }>>();
  const [preview, setPreview] = useState<PreviewRunSummary | undefined>(
    initialPreview,
  );
  if (checked !== undefined && checked.context !== checkContext)
    setChecked(undefined);
  const [error, setError] = useState<string>();
  const [recoveryPending, setRecoveryPending] = useState(false);
  const attempt = useRef<TestAttempt | undefined>(undefined);
  const operation = useRef(0);
  const activeRequest = useRef<AbortController | undefined>(undefined);

  useEffect(
    () => () => {
      operation.current += 1;
      activeRequest.current?.abort();
    },
    [],
  );

  function begin(kind: 'check' | 'run') {
    activeRequest.current?.abort();
    const controller = new AbortController();
    const id = operation.current + 1;
    operation.current = id;
    activeRequest.current = controller;
    setPending(kind);
    setError(undefined);
    return { controller, isCurrent: () => operation.current === id } as const;
  }

  function fail(isCurrent: () => boolean, cause: unknown, message: string) {
    if (isCurrent() && !(isApiError(cause) && cause.kind === 'canceled'))
      setError(message);
  }

  const context: NodeTestContext = {
    ...options,
    begin,
    fail,
    setChecked,
    setPending,
    setPreview,
  };

  async function runTest(
    input: Readonly<{ text: string; priorPreviewId?: string }>,
  ) {
    const { controller, isCurrent } = begin('run');
    let accepted = false;
    try {
      if (attempt.current === undefined) setRecoveryPending(false);
      const command =
        attempt.current ?? (await newNodeTestAttempt(context, input));
      if (!isCurrent()) return;
      attempt.current = command;
      const response = await executeWorkflowNodePreview(
        apiClient,
        workspaceId,
        workflowId,
        { ...command, signal: controller.signal },
      );
      if (!isCurrent()) return;
      attempt.current = undefined;
      setRecoveryPending(false);
      setPreview(response.preview);
      accepted = true;
      await finishNodeTest(context, response.preview, {
        signal: controller.signal,
        isCurrent,
      });
    } catch (cause) {
      if (
        isCurrent() &&
        isApiError(cause) &&
        cause.problem?.code.startsWith('workflow.sample_')
      )
        onSampleConflict?.();
      fail(
        isCurrent,
        cause,
        accepted
          ? observationErrorMessage(cause)
          : commandErrorMessage(cause, 'the test'),
      );
      if (!accepted) {
        if (!isUnconfirmedCommand(cause)) attempt.current = undefined;
        setRecoveryPending(attempt.current !== undefined);
      }
    } finally {
      if (isCurrent()) setPending(undefined);
    }
  }

  async function resume() {
    if (preview === undefined || previewTerminalStatuses.has(preview.status))
      return;
    const { controller, isCurrent } = begin('run');
    try {
      await finishNodeTest(context, preview, {
        signal: controller.signal,
        isCurrent,
      });
    } catch (cause) {
      fail(isCurrent, cause, observationErrorMessage(cause));
    } finally {
      if (isCurrent()) setPending(undefined);
    }
  }

  /** Editing the sample input invalidates an unanswered check. */
  function inputChanged() {
    if (pending === 'check') {
      operation.current += 1;
      activeRequest.current?.abort();
      setPending(undefined);
    }
    setChecked(undefined);
    setError(undefined);
  }

  return {
    pending,
    check: checked?.context === checkContext ? checked.result : undefined,
    preview,
    error,
    recoveryPending,
    observing:
      preview !== undefined && !previewTerminalStatuses.has(preview.status),
    checkSetup: (inputText: string) => checkNodeSetup(context, inputText),
    runTest,
    resume,
    inputChanged,
  } as const;
}

function observationErrorMessage(error: unknown): string {
  if (isUnconfirmedCommand(error))
    return 'The test was accepted, but its status couldn’t be refreshed. Check its status again.';
  return commandErrorMessage(error, 'checking the test status');
}

function readTestSource(
  sampleId: string | null,
  input: Readonly<{ text: string; priorPreviewId?: string }>,
): NodeTestInputSource {
  if (sampleId !== null) return { kind: 'manual', value: {} };
  if (input.priorPreviewId !== undefined)
    return { kind: 'prior_preview', previewRunId: input.priorPreviewId };
  return { kind: 'manual', value: parseCommandJson(input.text, INPUT_ERROR) };
}

type NodeTestContext = NodeTestOptions &
  Readonly<{
    begin: (
      kind: 'check' | 'run',
    ) => Readonly<{ controller: AbortController; isCurrent: () => boolean }>;
    fail: (isCurrent: () => boolean, cause: unknown, message: string) => void;
    setChecked: (
      value: Readonly<{ context: string; result: NodeValidationResponse }>,
    ) => void;
    setPending: (pending: 'check' | 'run' | undefined) => void;
    setPreview: (preview: PreviewRunSummary) => void;
  }>;
async function checkNodeSetup(context: NodeTestContext, inputText: string) {
  const {
    begin,
    ensureSaved,
    apiClient,
    workspaceId,
    workflowId,
    nodeId,
    setChecked,
    checkContext,
    fail,
    setPending,
  } = context;
  const { controller, isCurrent } = begin('check');
  try {
    const { revision } = await ensureSaved();
    if (!isCurrent()) return;
    const response = await validateWorkflowNode(
      apiClient,
      workspaceId,
      workflowId,
      {
        nodeId,
        expectedRevision: revision,
        sampleInput: parseCommandJson(inputText, INPUT_ERROR),
        signal: controller.signal,
      },
    );
    if (isCurrent()) setChecked({ context: checkContext, result: response });
  } catch (cause) {
    fail(isCurrent, cause, commandErrorMessage(cause, 'the check'));
  } finally {
    if (isCurrent()) setPending(undefined);
  }
}
async function newNodeTestAttempt(
  { ensureSaved, nodeId, expectedSampleId }: NodeTestContext,
  input: Readonly<{ text: string; priorPreviewId?: string }>,
): Promise<TestAttempt> {
  const { revision } = await ensureSaved();
  return {
    idempotencyKey: crypto.randomUUID(),
    nodeId,
    expectedRevision: revision,
    expectedSampleId,
    source: readTestSource(expectedSampleId, input),
  };
}
async function finishNodeTest(
  {
    apiClient,
    workspaceId,
    setPreview,
    onFinished,
    onSucceeded,
  }: NodeTestContext,
  accepted: PreviewRunSummary,
  {
    signal,
    isCurrent,
  }: Readonly<{ signal: AbortSignal; isCurrent: () => boolean }>,
) {
  const observed = previewTerminalStatuses.has(accepted.status)
    ? accepted
    : await observePreview(apiClient, workspaceId, accepted.id, signal);
  if (!isCurrent()) return;
  setPreview(observed);
  onFinished?.(observed);
  if (observed.status === 'succeeded') onSucceeded?.(observed);
}
