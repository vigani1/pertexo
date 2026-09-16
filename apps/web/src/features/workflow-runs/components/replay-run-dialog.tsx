import { useRef, useState, type SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { ApiClient } from '@/lib/api/client';
import {
  useRunReplay,
  type RunReplayIntent,
} from '../mutations/use-run-replay';

export function ReplayRunDialog({
  apiClient,
  workspaceId,
  sourceRunId,
  workflowVersionId,
  onRunAccepted,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  sourceRunId: string;
  workflowVersionId: string;
  onRunAccepted: (runId: string) => void;
}>) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('{}');
  const [deadline, setDeadline] = useState('');
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<Partial<Record<'input' | 'deadline', string>>>
  >({});
  const [validationAttempted, setValidationAttempted] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const deadlineRef = useRef<HTMLInputElement>(null);
  const replay = useRunReplay({
    apiClient,
    workspaceId,
    sourceRunId,
    workflowVersionId,
    onRunAccepted,
  });
  function readIntent(): RunReplayIntent | undefined {
    const errors: Partial<Record<'input' | 'deadline', string>> = {};
    let value: unknown;
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      errors.input = 'Replay input must be valid JSON.';
    }
    const normalizedDeadline = deadline.trim();
    const timestamp =
      normalizedDeadline === '' ? undefined : new Date(normalizedDeadline);
    if (timestamp !== undefined && Number.isNaN(timestamp.getTime()))
      errors.deadline = 'Enter a valid replay deadline.';
    setFieldErrors(errors);
    if (errors.input !== undefined) {
      inputRef.current?.focus();
      return undefined;
    }
    if (errors.deadline !== undefined) {
      deadlineRef.current?.focus();
      return undefined;
    }
    return {
      value,
      ...(timestamp === undefined
        ? {}
        : { deadlineAt: timestamp.toISOString() }),
    };
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationAttempted(true);
    const intent = readIntent();
    if (intent === undefined) return;
    const accepted = replay.retryAvailable
      ? await replay.retry(intent)
      : await replay.startNew(intent);
    if (accepted) setOpen(false);
  }

  function changeOpen(nextOpen: boolean) {
    if (replay.pending) return;
    setOpen(nextOpen);
    if (!nextOpen) {
      replay.dismiss();
      setInput('{}');
      setDeadline('');
      setFieldErrors({});
      setValidationAttempted(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          setOpen(true);
        }}
      >
        Replay run
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent>
          <DialogTitle>Replay this workflow version</DialogTitle>
          <DialogDescription>
            Replay creates a new run from immutable version {workflowVersionId}.
            Enter the intended input explicitly; Pertexo does not copy hidden
            input or assume earlier provider effects are safe to repeat.
          </DialogDescription>
          <form className="mt-6" onSubmit={(event) => void submit(event)}>
            <FieldGroup>
              <Field data-invalid={fieldErrors.input !== undefined}>
                <FieldLabel htmlFor="replay-run-input">
                  Replay input (JSON)
                </FieldLabel>
                <Textarea
                  ref={inputRef}
                  id="replay-run-input"
                  name="replayInput"
                  autoComplete="off"
                  autoFocus
                  disabled={replay.pending}
                  value={input}
                  aria-invalid={fieldErrors.input !== undefined}
                  aria-describedby={
                    fieldErrors.input === undefined
                      ? 'replay-run-input-description'
                      : 'replay-run-input-description replay-run-input-error'
                  }
                  onBlur={() => {
                    setFieldErrors((current) => {
                      try {
                        JSON.parse(input);
                        return withoutReplayFieldError(current, 'input');
                      } catch {
                        return {
                          ...current,
                          input: 'Replay input must be valid JSON.',
                        };
                      }
                    });
                  }}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setInput(value);
                    if (validationAttempted)
                      setFieldErrors((current) => {
                        try {
                          JSON.parse(value);
                          return withoutReplayFieldError(current, 'input');
                        } catch {
                          return {
                            ...current,
                            input: 'Replay input must be valid JSON.',
                          };
                        }
                      });
                  }}
                />
                <FieldDescription id="replay-run-input-description">
                  This is a new side-effecting execution. Review the input
                  before continuing.
                </FieldDescription>
                {fieldErrors.input === undefined ? null : (
                  <FieldError id="replay-run-input-error">
                    {fieldErrors.input}
                  </FieldError>
                )}
              </Field>
              <Field data-invalid={fieldErrors.deadline !== undefined}>
                <FieldLabel htmlFor="replay-run-deadline">
                  Deadline (optional)
                </FieldLabel>
                <Input
                  ref={deadlineRef}
                  id="replay-run-deadline"
                  name="replayDeadline"
                  type="datetime-local"
                  disabled={replay.pending}
                  value={deadline}
                  aria-invalid={fieldErrors.deadline !== undefined}
                  aria-describedby={
                    fieldErrors.deadline === undefined
                      ? undefined
                      : 'replay-run-deadline-error'
                  }
                  onBlur={() => {
                    setFieldErrors((current) =>
                      deadline === '' ||
                      !Number.isNaN(new Date(deadline).getTime())
                        ? withoutReplayFieldError(current, 'deadline')
                        : {
                            ...current,
                            deadline: 'Enter a valid replay deadline.',
                          },
                    );
                  }}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDeadline(value);
                    if (validationAttempted)
                      setFieldErrors((current) =>
                        value === '' || !Number.isNaN(new Date(value).getTime())
                          ? withoutReplayFieldError(current, 'deadline')
                          : {
                              ...current,
                              deadline: 'Enter a valid replay deadline.',
                            },
                      );
                  }}
                />
                {fieldErrors.deadline === undefined ? null : (
                  <FieldError id="replay-run-deadline-error">
                    {fieldErrors.deadline}
                  </FieldError>
                )}
              </Field>
              {replay.error ? <FieldError>{replay.error}</FieldError> : null}
            </FieldGroup>
            <div className="mt-7 flex justify-end gap-2">
              <DialogClose
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={replay.pending}
                  />
                }
              >
                Cancel
              </DialogClose>
              <Button type="submit" variant="solid" disabled={replay.pending}>
                {replay.pending
                  ? 'Replaying…'
                  : replay.retryAvailable
                    ? 'Retry same replay'
                    : 'Replay this version'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function withoutReplayFieldError(
  current: Readonly<Partial<Record<'input' | 'deadline', string>>>,
  field: 'input' | 'deadline',
) {
  return Object.fromEntries(
    Object.entries(current).filter(([name]) => name !== field),
  );
}
