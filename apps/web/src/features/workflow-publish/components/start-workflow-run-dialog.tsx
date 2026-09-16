import { useRef, useState, type SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { parseCommandJson } from '../mutations/command-utils';
import type { WorkflowRunIntent } from '../mutations/use-workflow-run-submission';

export function StartWorkflowRunDialog({
  open,
  pending,
  error,
  onOpenChange,
  onStartNew,
  onRetry,
  retryAvailable,
}: Readonly<{
  open: boolean;
  pending: boolean;
  error: string | undefined;
  onOpenChange: (open: boolean) => void;
  onStartNew: (intent: WorkflowRunIntent) => Promise<boolean>;
  onRetry: () => Promise<boolean>;
  retryAvailable: boolean;
}>) {
  const [input, setInput] = useState('{}');
  const [deadline, setDeadline] = useState('');
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<Partial<Record<'input' | 'deadline', string>>>
  >({});
  const [validationAttempted, setValidationAttempted] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const deadlineRef = useRef<HTMLInputElement>(null);

  function readIntent(): WorkflowRunIntent | undefined {
    const errors: Partial<Record<'input' | 'deadline', string>> = {};
    let value: unknown;
    try {
      value = parseCommandJson(input, 'Run input must be valid JSON.');
    } catch {
      errors.input = 'Run input must be valid JSON.';
    }
    const normalizedDeadline = deadline.trim();
    const parsedDeadline =
      normalizedDeadline === '' ? undefined : new Date(normalizedDeadline);
    if (parsedDeadline !== undefined && Number.isNaN(parsedDeadline.getTime()))
      errors.deadline = 'Enter a valid run deadline.';
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
      ...(parsedDeadline === undefined
        ? {}
        : { deadlineAt: parsedDeadline.toISOString() }),
    };
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (retryAvailable) {
      if (await onRetry()) onOpenChange(false);
      return;
    }
    setValidationAttempted(true);
    const intent = readIntent();
    if (intent === undefined) return;
    const accepted = await onStartNew(intent);
    if (accepted) onOpenChange(false);
  }

  async function startDeliberateNewRun() {
    setValidationAttempted(true);
    const intent = readIntent();
    if (intent !== undefined && (await onStartNew(intent))) onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogTitle>Start current published version</DialogTitle>
        <DialogDescription>
          {retryAvailable
            ? 'Retry same run replays the originally submitted input and command key. Start a new run deliberately uses the current fields and a new key.'
            : 'The server resolves the current published version. The accepted version is shown on the run detail page.'}
        </DialogDescription>
        <form
          className="mt-6 space-y-5"
          onSubmit={(event) => void submit(event)}
        >
          <Field data-invalid={fieldErrors.input !== undefined}>
            <FieldLabel htmlFor="run-input">Run input (JSON)</FieldLabel>
            <Textarea
              ref={inputRef}
              id="run-input"
              name="runInput"
              autoComplete="off"
              value={input}
              aria-invalid={fieldErrors.input !== undefined}
              aria-describedby={
                fieldErrors.input === undefined ? undefined : 'run-input-error'
              }
              onBlur={() => {
                try {
                  parseCommandJson(input, 'Run input must be valid JSON.');
                  setFieldErrors((current) =>
                    Object.fromEntries(
                      Object.entries(current).filter(
                        ([field]) => field !== 'input',
                      ),
                    ),
                  );
                } catch {
                  setFieldErrors((current) => ({
                    ...current,
                    input: 'Run input must be valid JSON.',
                  }));
                }
              }}
              onChange={(event) => {
                const value = event.target.value;
                setInput(value);
                if (validationAttempted) {
                  try {
                    parseCommandJson(value, 'Run input must be valid JSON.');
                    setFieldErrors((current) =>
                      Object.fromEntries(
                        Object.entries(current).filter(
                          ([field]) => field !== 'input',
                        ),
                      ),
                    );
                  } catch {
                    setFieldErrors((current) => ({
                      ...current,
                      input: 'Run input must be valid JSON.',
                    }));
                  }
                }
              }}
            />
            {fieldErrors.input === undefined ? null : (
              <FieldError id="run-input-error">{fieldErrors.input}</FieldError>
            )}
          </Field>
          <Field data-invalid={fieldErrors.deadline !== undefined}>
            <FieldLabel htmlFor="run-deadline">Deadline (optional)</FieldLabel>
            <Input
              ref={deadlineRef}
              id="run-deadline"
              name="deadline"
              type="datetime-local"
              value={deadline}
              aria-invalid={fieldErrors.deadline !== undefined}
              aria-describedby={
                fieldErrors.deadline === undefined
                  ? undefined
                  : 'run-deadline-error'
              }
              onBlur={() => {
                setFieldErrors((current) =>
                  deadline === '' || !Number.isNaN(new Date(deadline).getTime())
                    ? withoutFieldError(current, 'deadline')
                    : { ...current, deadline: 'Enter a valid run deadline.' },
                );
              }}
              onChange={(event) => {
                const value = event.target.value;
                setDeadline(value);
                if (validationAttempted)
                  setFieldErrors((current) =>
                    value === '' || !Number.isNaN(new Date(value).getTime())
                      ? withoutFieldError(current, 'deadline')
                      : { ...current, deadline: 'Enter a valid run deadline.' },
                  );
              }}
            />
            {fieldErrors.deadline === undefined ? null : (
              <FieldError id="run-deadline-error">
                {fieldErrors.deadline}
              </FieldError>
            )}
          </Field>
          {error ? <FieldError>{error}</FieldError> : null}
          <div className="flex justify-end gap-2">
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
                onClick={() => void startDeliberateNewRun()}
              >
                Start a new run
              </Button>
            ) : null}
            <Button type="submit" disabled={pending}>
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

function withoutFieldError(
  current: Readonly<Partial<Record<'input' | 'deadline', string>>>,
  field: 'input' | 'deadline',
) {
  return Object.fromEntries(
    Object.entries(current).filter(([name]) => name !== field),
  );
}
