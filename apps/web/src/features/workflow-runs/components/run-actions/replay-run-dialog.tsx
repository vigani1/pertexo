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
  FieldControl,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Textarea } from '@/components/ui/textarea';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import {
  useRunReplay,
  type RunReplayIntent,
} from '../../mutations/use-run-replay';

type ReplayField = 'input' | 'deadline';
type FieldErrors = Readonly<Partial<Record<ReplayField, string>>>;

const INPUT_ERROR =
  'The input isn’t valid JSON. Check for a missing quote, comma or brace.';
const DEADLINE_ERROR = 'Enter the deadline as a date and time.';

function inputError(value: string): string | undefined {
  try {
    JSON.parse(value);
    return undefined;
  } catch {
    return INPUT_ERROR;
  }
}

function deadlineError(value: string): string | undefined {
  return value.trim() === '' || !Number.isNaN(new Date(value).getTime())
    ? undefined
    : DEADLINE_ERROR;
}

function withField(
  current: FieldErrors,
  field: ReplayField,
  message: string | undefined,
): FieldErrors {
  const rest = Object.fromEntries(
    Object.entries(current).filter(([name]) => name !== field),
  ) as FieldErrors;
  return message === undefined ? rest : { ...rest, [field]: message };
}

/**
 * Replay starts a new run of this run's exact version. The input is typed
 * explicitly (the API doesn't return the original yet), and an uncertain
 * result can be retried with the same command so it never runs twice.
 */
export function ReplayRunDialog({
  apiClient,
  userId,
  workspaceId,
  sourceRunId,
  workflowVersionId,
  versionLabel,
  open,
  onOpenChange,
  onRunAccepted,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  sourceRunId: string;
  workflowVersionId: string;
  /** "v7" when the version number is known. */
  versionLabel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRunAccepted: (runId: string) => void;
}>) {
  const notifications = useNotifications();
  const [input, setInput] = useState('{}');
  const [deadline, setDeadline] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [validated, setValidated] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const deadlineRef = useRef<HTMLInputElement>(null);
  const replay = useRunReplay({
    apiClient,
    userId,
    workspaceId,
    sourceRunId,
    workflowVersionId,
    onRunAccepted: (runId) => {
      notifications.success({
        title: 'Replay started',
        description: 'Opening the new run.',
      });
      onRunAccepted(runId);
    },
  });

  function readIntent(): RunReplayIntent | undefined {
    const next = withField(
      withField({}, 'input', inputError(input)),
      'deadline',
      deadlineError(deadline),
    );
    setErrors(next);
    if (next.input !== undefined) {
      inputRef.current?.focus();
      return undefined;
    }
    if (next.deadline !== undefined) {
      deadlineRef.current?.focus();
      return undefined;
    }
    const trimmed = deadline.trim();
    return {
      value: JSON.parse(input) as unknown,
      ...(trimmed === ''
        ? {}
        : { deadlineAt: new Date(trimmed).toISOString() }),
    };
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidated(true);
    const intent = readIntent();
    if (intent === undefined) return;
    const accepted = replay.retryAvailable
      ? await replay.retry(intent)
      : await replay.startNew(intent);
    if (accepted) onOpenChange(false);
  }

  function changeOpen(nextOpen: boolean) {
    if (replay.pending) return;
    onOpenChange(nextOpen);
    if (!nextOpen) {
      replay.dismiss();
      setInput('{}');
      setDeadline('');
      setErrors({});
      setValidated(false);
    }
  }

  const version = versionLabel ?? 'the same version';
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogTitle>Replay this run</DialogTitle>
        <DialogDescription>
          Pertexo starts a new run of {version} with the input you enter here.
          It doesn’t copy the original input, and steps that call other services
          run again, so check the input before you continue.
        </DialogDescription>
        <form className="mt-6" onSubmit={(event) => void submit(event)}>
          <FieldGroup>
            <Field data-invalid={errors.input !== undefined}>
              <FieldLabel htmlFor="replay-run-input">
                Replay input (JSON)
              </FieldLabel>
              <FieldControl
                state={errors.input === undefined ? undefined : 'invalid'}
              >
                <Textarea
                  ref={inputRef}
                  id="replay-run-input"
                  name="replayInput"
                  autoComplete="off"
                  autoFocus
                  spellCheck={false}
                  className="font-mono text-[0.8rem]"
                  disabled={replay.pending}
                  value={input}
                  aria-invalid={errors.input !== undefined}
                  aria-describedby={
                    errors.input === undefined
                      ? 'replay-run-input-description'
                      : 'replay-run-input-description replay-run-input-error'
                  }
                  onBlur={() => {
                    setErrors((current) =>
                      withField(current, 'input', inputError(input)),
                    );
                  }}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setInput(value);
                    if (validated)
                      setErrors((current) =>
                        withField(current, 'input', inputError(value)),
                      );
                  }}
                />
              </FieldControl>
              <FieldDescription id="replay-run-input-description">
                Use {'{}'} if the workflow doesn’t read any input.
              </FieldDescription>
              {errors.input === undefined ? null : (
                <FieldError id="replay-run-input-error">
                  {errors.input}
                </FieldError>
              )}
            </Field>
            <Field data-invalid={errors.deadline !== undefined}>
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
                aria-invalid={errors.deadline !== undefined}
                aria-describedby={
                  errors.deadline === undefined
                    ? undefined
                    : 'replay-run-deadline-error'
                }
                onBlur={() => {
                  setErrors((current) =>
                    withField(current, 'deadline', deadlineError(deadline)),
                  );
                }}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDeadline(value);
                  if (validated)
                    setErrors((current) =>
                      withField(current, 'deadline', deadlineError(value)),
                    );
                }}
              />
              {errors.deadline === undefined ? null : (
                <FieldError id="replay-run-deadline-error">
                  {errors.deadline}
                </FieldError>
              )}
            </Field>
            {replay.error === undefined ? null : (
              <FieldError>{replay.error}</FieldError>
            )}
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
            <Button type="submit" variant="primary" disabled={replay.pending}>
              {replay.pending ? (
                <>
                  <LoadingOrb />
                  Replaying…
                </>
              ) : replay.retryAvailable ? (
                'Retry same replay'
              ) : (
                'Replay this version'
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
