import { useRef, useState, type SyntheticEvent } from 'react';
import { PlayIcon } from 'lucide-react';
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
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Textarea } from '@/components/ui/textarea';
import type { WorkflowRunIntent } from '../mutations/use-workflow-run-submission';

type RunField = 'input' | 'deadline';
type RunFieldErrors = Readonly<Partial<Record<RunField, string>>>;

const INPUT_ERROR =
  'Run input must be valid JSON, like {"customerId": "customer-7"}.';
const DEADLINE_ERROR = 'Enter a valid run deadline.';

/**
 * Starts the published version with an input and an optional deadline. After
 * an uncertain start it offers the exact same run again, or a new one.
 */
export function RunLens({
  open,
  pending,
  error,
  retryAvailable,
  onOpenChange,
  onStartNew,
  onRetry,
}: Readonly<{
  open: boolean;
  pending: boolean;
  error: string | undefined;
  retryAvailable: boolean;
  onOpenChange: (open: boolean) => void;
  onStartNew: (intent: WorkflowRunIntent) => Promise<boolean>;
  onRetry: () => Promise<boolean>;
}>) {
  const [input, setInput] = useState('{}');
  const [deadline, setDeadline] = useState('');
  const [errors, setErrors] = useState<RunFieldErrors>({});
  const [attempted, setAttempted] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const deadlineRef = useRef<HTMLInputElement>(null);

  function recheck(field: RunField, value: string) {
    setErrors((current) => {
      const message = fieldError(field, value);
      const rest = Object.fromEntries(
        Object.entries(current).filter(([name]) => name !== field),
      );
      return message === undefined ? rest : { ...rest, [field]: message };
    });
  }

  function readIntent(): WorkflowRunIntent | undefined {
    setAttempted(true);
    const inputError = fieldError('input', input);
    const deadlineError = fieldError('deadline', deadline);
    setErrors({
      ...(inputError === undefined ? {} : { input: inputError }),
      ...(deadlineError === undefined ? {} : { deadline: deadlineError }),
    });
    if (inputError !== undefined) {
      inputRef.current?.focus();
      return undefined;
    }
    if (deadlineError !== undefined) {
      deadlineRef.current?.focus();
      return undefined;
    }
    const deadlineAt =
      deadline.trim() === '' ? undefined : new Date(deadline).toISOString();
    return {
      value: JSON.parse(input) as unknown,
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
    };
  }

  async function startNew() {
    const intent = readIntent();
    if (intent !== undefined && (await onStartNew(intent))) onOpenChange(false);
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!retryAvailable) {
      await startNew();
      return;
    }
    if (await onRetry()) onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogTitle>Run with input</DialogTitle>
        <DialogDescription>
          {retryAvailable
            ? 'Retry sends the same run again, with the same input. It can’t start twice. Start a new run to use what’s in the fields now.'
            : 'Starts the published version. The run page opens as soon as it’s accepted.'}
        </DialogDescription>
        <form className="mt-6" onSubmit={(event) => void submit(event)}>
          <FieldGroup>
            <Field data-invalid={errors.input !== undefined}>
              <FieldLabel htmlFor="run-input">Run input (JSON)</FieldLabel>
              <Textarea
                ref={inputRef}
                id="run-input"
                name="runInput"
                autoComplete="off"
                spellCheck={false}
                className="min-h-32 font-mono"
                value={input}
                aria-invalid={errors.input !== undefined}
                aria-describedby={
                  errors.input === undefined ? undefined : 'run-input-error'
                }
                onBlur={() => {
                  recheck('input', input);
                }}
                onChange={(event) => {
                  setInput(event.target.value);
                  if (attempted) recheck('input', event.target.value);
                }}
              />
              {errors.input === undefined ? null : (
                <FieldError id="run-input-error">{errors.input}</FieldError>
              )}
            </Field>
            <Field data-invalid={errors.deadline !== undefined}>
              <FieldLabel htmlFor="run-deadline">
                Deadline (optional)
              </FieldLabel>
              <Input
                ref={deadlineRef}
                id="run-deadline"
                name="deadline"
                type="datetime-local"
                value={deadline}
                aria-invalid={errors.deadline !== undefined}
                aria-describedby={
                  errors.deadline === undefined
                    ? 'run-deadline-zone'
                    : 'run-deadline-zone run-deadline-error'
                }
                onBlur={() => {
                  recheck('deadline', deadline);
                }}
                onChange={(event) => {
                  setDeadline(event.target.value);
                  if (attempted) recheck('deadline', event.target.value);
                }}
              />
              <FieldDescription id="run-deadline-zone">
                In your time zone ({localUtcOffset()}). The run stops if it
                isn’t finished by then.
              </FieldDescription>
              {errors.deadline === undefined ? null : (
                <FieldError id="run-deadline-error">
                  {errors.deadline}
                </FieldError>
              )}
            </Field>
            {error === undefined ? null : <FieldError>{error}</FieldError>}
          </FieldGroup>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <DialogClose
              render={
                <Button type="button" variant="ghost" disabled={pending} />
              }
            >
              Cancel
            </DialogClose>
            {retryAvailable ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => void startNew()}
              >
                Start a new run
              </Button>
            ) : null}
            <Button type="submit" disabled={pending}>
              {pending ? <LoadingOrb /> : <PlayIcon data-icon="inline-start" />}
              {pending
                ? 'Starting…'
                : retryAvailable
                  ? 'Retry same run'
                  : 'Start published version'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function fieldError(field: RunField, value: string): string | undefined {
  if (field === 'deadline')
    return value === '' || !Number.isNaN(new Date(value).getTime())
      ? undefined
      : DEADLINE_ERROR;
  try {
    JSON.parse(value);
    return undefined;
  } catch {
    return INPUT_ERROR;
  }
}

/** "UTC+2" or "UTC−3:30", from the browser's current offset. */
function localUtcOffset(): string {
  const offsetMinutes = -new Date().getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '−';
  const hours = Math.floor(Math.abs(offsetMinutes) / 60);
  const minutes = Math.abs(offsetMinutes) % 60;
  return `UTC${sign}${String(hours)}${minutes === 0 ? '' : `:${String(minutes).padStart(2, '0')}`}`;
}
