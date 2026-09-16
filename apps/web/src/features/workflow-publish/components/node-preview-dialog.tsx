import type {
  NodeValidationResponse,
  PreviewRunSummary,
} from '@pertexo/contracts/schemas/node-testing';
import { useEffect, useRef, useState } from 'react';
import { ArtifactDownload } from '@/features/artifacts/public';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { isApiError } from '@/lib/api/api-error';
import type { ApiClient } from '@/lib/api/client';
import {
  executeWorkflowNodePreview,
  getWorkflowNodePreview,
  validateWorkflowNode,
} from '../node-preview.api';
import {
  commandErrorMessage,
  isUncertainCommandError,
  parseCommandJson,
} from '../mutations/command-utils';

const previewTerminalStatuses = new Set<PreviewRunSummary['status']>([
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);

type PreviewExecutionAttempt = Readonly<{
  idempotencyKey: string;
  nodeId: string;
  expectedRevision: number;
  value: unknown;
}>;

export function NodePreviewDialog({
  open,
  onOpenChange,
  apiClient,
  workspaceId,
  workflowId,
  nodeId,
  ensureSaved,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
  nodeId: string;
  ensureSaved: () => Promise<Readonly<{ revision: number }>>;
}>) {
  const [input, setInput] = useState('{}');
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState<'validate' | 'execute'>();
  const [validation, setValidation] = useState<NodeValidationResponse>();
  const [preview, setPreview] = useState<PreviewRunSummary>();
  const [error, setError] = useState<string>();
  const [executionRecoveryPending, setExecutionRecoveryPending] =
    useState(false);
  const attempt = useRef<PreviewExecutionAttempt | undefined>(undefined);
  const operation = useRef(0);
  const activeRequest = useRef<AbortController | undefined>(undefined);

  useEffect(
    () => () => {
      operation.current += 1;
      activeRequest.current?.abort();
    },
    [],
  );

  function beginOperation() {
    activeRequest.current?.abort();
    const controller = new AbortController();
    const operationId = operation.current + 1;
    operation.current = operationId;
    activeRequest.current = controller;
    return { controller, operationId } as const;
  }

  function operationIsCurrent(operationId: number) {
    return operation.current === operationId;
  }

  async function savedRevision() {
    return (await ensureSaved()).revision;
  }

  async function validateNode() {
    const { controller, operationId } = beginOperation();
    setPending('validate');
    setError(undefined);
    try {
      const revision = await savedRevision();
      if (!operationIsCurrent(operationId)) return;
      const value = parseCommandJson(input, 'Sample input must be valid JSON.');
      const response = await validateWorkflowNode(
        apiClient,
        workspaceId,
        workflowId,
        {
          nodeId,
          expectedRevision: revision,
          sampleInput: value,
          signal: controller.signal,
        },
      );
      if (operationIsCurrent(operationId)) setValidation(response);
    } catch (cause) {
      if (
        operationIsCurrent(operationId) &&
        !(isApiError(cause) && cause.kind === 'canceled')
      )
        setError(commandErrorMessage(cause, 'validate this node'));
    } finally {
      if (operationIsCurrent(operationId)) setPending(undefined);
    }
  }

  async function executeNode() {
    const { controller, operationId } = beginOperation();
    setPending('execute');
    setError(undefined);
    let acceptedForObservation = false;
    try {
      if (!acknowledged)
        throw new Error(
          'Acknowledge the disclosed side effects before test execution.',
        );
      let command = attempt.current;
      if (command === undefined) {
        setExecutionRecoveryPending(false);
        const revision = await savedRevision();
        if (!operationIsCurrent(operationId)) return;
        const value = parseCommandJson(input, 'Test input must be valid JSON.');
        command = {
          idempotencyKey: crypto.randomUUID(),
          nodeId,
          expectedRevision: revision,
          value,
        };
      }
      attempt.current = command;
      const accepted = await executeWorkflowNodePreview(
        apiClient,
        workspaceId,
        workflowId,
        {
          nodeId: command.nodeId,
          expectedRevision: command.expectedRevision,
          value: command.value,
          idempotencyKey: command.idempotencyKey,
          signal: controller.signal,
        },
      );
      if (!operationIsCurrent(operationId)) return;
      attempt.current = undefined;
      setExecutionRecoveryPending(false);
      setPreview(accepted.preview);
      if (!previewTerminalStatuses.has(accepted.preview.status)) {
        acceptedForObservation = true;
        const observed = await pollPreview(
          apiClient,
          workspaceId,
          accepted.preview.id,
          controller.signal,
        );
        if (operationIsCurrent(operationId)) setPreview(observed);
      }
    } catch (cause) {
      if (
        operationIsCurrent(operationId) &&
        !(isApiError(cause) && cause.kind === 'canceled')
      )
        setError(
          acceptedForObservation
            ? previewObservationErrorMessage(cause)
            : commandErrorMessage(cause, 'test execute this node'),
        );
      if (!acceptedForObservation) {
        const uncertain = isUncertainCommandError(cause);
        if (!uncertain) attempt.current = undefined;
        setExecutionRecoveryPending(uncertain && attempt.current !== undefined);
      }
    } finally {
      if (operationIsCurrent(operationId)) setPending(undefined);
    }
  }

  async function resumePreview() {
    if (preview === undefined || previewTerminalStatuses.has(preview.status))
      return;
    const { controller, operationId } = beginOperation();
    setPending('execute');
    setError(undefined);
    try {
      const observed = await pollPreview(
        apiClient,
        workspaceId,
        preview.id,
        controller.signal,
      );
      if (operationIsCurrent(operationId)) setPreview(observed);
    } catch (cause) {
      if (
        operationIsCurrent(operationId) &&
        !(isApiError(cause) && cause.kind === 'canceled')
      )
        setError(previewObservationErrorMessage(cause));
    } finally {
      if (operationIsCurrent(operationId)) setPending(undefined);
    }
  }

  const observingAcceptedPreview =
    preview !== undefined && !previewTerminalStatuses.has(preview.status);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending === undefined) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogTitle>Preview selected node</DialogTitle>
        <DialogDescription>
          Validate is read-only. Test execute may contact providers or cause
          external side effects and requires explicit acknowledgement.
        </DialogDescription>
        <div className="mt-5 space-y-4">
          <Field>
            <FieldLabel htmlFor="preview-input">Sample input (JSON)</FieldLabel>
            <Textarea
              id="preview-input"
              name="previewInput"
              autoComplete="off"
              value={input}
              onChange={(event) => {
                if (pending === 'validate') {
                  operation.current += 1;
                  activeRequest.current?.abort();
                  setPending(undefined);
                }
                setInput(event.target.value);
                setAcknowledged(false);
                setValidation(undefined);
                setError(undefined);
              }}
            />
          </Field>
          {validation ? (
            <div className="rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={validation.valid ? 'muted' : 'destructive'}>
                  {validation.valid ? 'Node valid' : 'Node invalid'}
                </Badge>
                <span>
                  {validation.disclosure.sideEffectClass.replaceAll('_', ' ')}
                </span>
              </div>
              <p className="mt-2 text-muted-foreground">
                {validation.disclosure.mayCauseExternalSideEffect
                  ? 'May cause an external side effect.'
                  : 'No external side effect reported.'}
                {validation.disclosure.mayContactProvider
                  ? ' May contact a provider.'
                  : ''}
              </p>
            </div>
          ) : null}
          <label className="flex items-start gap-3 text-sm">
            <input
              className="mt-1 size-4"
              type="checkbox"
              name="acknowledgeSideEffects"
              checked={acknowledged}
              onChange={(event) => {
                setAcknowledged(event.target.checked);
              }}
            />
            I understand that test execution may contact providers or cause
            external side effects.
          </label>
          {preview ? (
            <p role="status" className="text-sm">
              Preview status:{' '}
              <strong>{preview.status.replaceAll('_', ' ')}</strong>
              {preview.safeErrorCode ? ` · ${preview.safeErrorCode}` : ''}
            </p>
          ) : null}
          {preview?.output?.kind === 'artifact' ? (
            <ArtifactDownload
              key={preview.output.artifactId}
              apiClient={apiClient}
              workspaceId={workspaceId}
              artifactId={preview.output.artifactId}
            />
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending !== undefined}
                />
              }
            >
              Close
            </DialogClose>
            <Button
              type="button"
              variant="outline"
              disabled={pending !== undefined}
              onClick={() => void validateNode()}
            >
              {pending === 'validate' ? 'Validating…' : 'Validate node'}
            </Button>
            <Button
              type="button"
              disabled={
                pending !== undefined ||
                (!observingAcceptedPreview && !acknowledged)
              }
              onClick={() =>
                void (observingAcceptedPreview
                  ? resumePreview()
                  : executeNode())
              }
            >
              {pending === 'execute'
                ? 'Executing…'
                : observingAcceptedPreview
                  ? 'Resume preview status'
                  : error
                    ? executionRecoveryPending
                      ? 'Retry original test'
                      : 'Retry test safely'
                    : preview === undefined
                      ? 'Test execute'
                      : 'Run another test'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function previewObservationErrorMessage(error: unknown): string {
  if (isUncertainCommandError(error))
    return 'Preview execution was accepted. Its status could not be refreshed; resume status for this preview.';
  return commandErrorMessage(error, 'check this preview status');
}

async function pollPreview(
  apiClient: ApiClient,
  workspaceId: string,
  previewRunId: string,
  signal: AbortSignal,
): Promise<PreviewRunSummary> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await delay(1_000, signal);
    const response = await getWorkflowNodePreview(
      apiClient,
      workspaceId,
      previewRunId,
      signal,
    );
    if (previewTerminalStatuses.has(response.preview.status))
      return response.preview;
  }
  throw new Error(
    'The preview is still running. Close and reopen it to check again.',
  );
}

function delay(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
