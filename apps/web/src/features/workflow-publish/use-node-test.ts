import type {
  NodeValidationResponse,
  PreviewRunSummary,
} from '@pertexo/contracts/schemas/node-testing';
import { useEffect, useRef, useState } from 'react';
import { isApiError } from '@/lib/api/api-error';
import type { ApiClient } from '@/lib/api/client';
import {
  commandErrorMessage,
  isUncertainCommandError,
  parseCommandJson,
} from './mutations/command-utils';
import {
  observePreview,
  previewTerminalStatuses,
} from './model/preview-observation';
import {
  executeWorkflowNodePreview,
  validateWorkflowNode,
  type NodeTestInputSource,
} from './node-test.api';

type TestAttempt = Readonly<{
  idempotencyKey: string;
  nodeId: string;
  expectedRevision: number;
  source: NodeTestInputSource;
}>;

const INPUT_ERROR = 'Sample input must be valid JSON, like {"amount": 1240}.';

/**
 * One step's checks and test runs against its saved draft. A run is keyed
 * once; after an uncertain answer the same run is retried, and an accepted
 * run that couldn't be observed is resumed rather than sent again.
 */
export function useNodeTest({
  apiClient,
  workspaceId,
  workflowId,
  nodeId,
  ensureSaved,
  initialPreview,
  onFinished,
  onSucceeded,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  nodeId: string;
  ensureSaved: () => Promise<Readonly<{ revision: number }>>;
  /** A finished test of this step to show until the next one. */
  initialPreview?: PreviewRunSummary | undefined;
  /** Any test that finished, passed or not. */
  onFinished?: (preview: PreviewRunSummary) => void;
  onSucceeded?: (preview: PreviewRunSummary) => void;
}>) {
  const [pending, setPending] = useState<'check' | 'run'>();
  const [check, setCheck] = useState<NodeValidationResponse>();
  const [preview, setPreview] = useState<PreviewRunSummary | undefined>(
    initialPreview,
  );
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

  async function checkSetup(inputText: string) {
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
      if (isCurrent()) setCheck(response);
    } catch (cause) {
      fail(isCurrent, cause, commandErrorMessage(cause, 'the check'));
    } finally {
      if (isCurrent()) setPending(undefined);
    }
  }

  async function newAttempt(
    input: Readonly<{ text: string; priorPreviewId?: string }>,
  ): Promise<TestAttempt> {
    const { revision } = await ensureSaved();
    return {
      idempotencyKey: crypto.randomUUID(),
      nodeId,
      expectedRevision: revision,
      source:
        input.priorPreviewId === undefined
          ? { kind: 'manual', value: parseCommandJson(input.text, INPUT_ERROR) }
          : { kind: 'prior_preview', previewRunId: input.priorPreviewId },
    };
  }

  async function finish(
    accepted: PreviewRunSummary,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ) {
    const observed = previewTerminalStatuses.has(accepted.status)
      ? accepted
      : await observePreview(apiClient, workspaceId, accepted.id, signal);
    if (!isCurrent()) return;
    setPreview(observed);
    onFinished?.(observed);
    if (observed.status === 'succeeded') onSucceeded?.(observed);
  }

  async function runTest(
    input: Readonly<{ text: string; priorPreviewId?: string }>,
  ) {
    const { controller, isCurrent } = begin('run');
    let accepted = false;
    try {
      if (attempt.current === undefined) setRecoveryPending(false);
      const command = attempt.current ?? (await newAttempt(input));
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
      await finish(response.preview, controller.signal, isCurrent);
    } catch (cause) {
      fail(
        isCurrent,
        cause,
        accepted
          ? observationErrorMessage(cause)
          : commandErrorMessage(cause, 'the test'),
      );
      if (!accepted) {
        if (!isUncertainCommandError(cause)) attempt.current = undefined;
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
      await finish(preview, controller.signal, isCurrent);
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
    setCheck(undefined);
    setError(undefined);
  }

  return {
    pending,
    check,
    preview,
    error,
    recoveryPending,
    observing:
      preview !== undefined && !previewTerminalStatuses.has(preview.status),
    checkSetup,
    runTest,
    resume,
    inputChanged,
  } as const;
}

function observationErrorMessage(error: unknown): string {
  if (isUncertainCommandError(error))
    return 'The test was accepted, but its status couldn’t be refreshed. Check its status again.';
  return commandErrorMessage(error, 'checking the test status');
}
