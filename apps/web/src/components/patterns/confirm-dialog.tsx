import type { ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';

type ConfirmDialogProps = Readonly<{
  open: boolean;
  /** `true` from the trigger; `false` when people dismiss it (never while locked). */
  onOpenChange: (open: boolean) => void;
  /** Opens the dialog, e.g. `<Button variant="destructive">Delete</Button>`. */
  trigger?: ReactElement;
  title: ReactNode;
  description?: ReactNode;
  /** What happens, one line each, under the description. */
  consequences?: readonly string[];
  /** Extra inputs the confirmation needs, e.g. a typed name. */
  children?: ReactNode;
  tone?: 'default' | 'destructive';
  confirmLabel: string;
  pendingLabel?: string;
  pending?: boolean;
  /** Keeps the dialog open, e.g. while an outcome is unconfirmed. Defaults to `pending`. */
  locked?: boolean;
  /**
   * Runs the confirmed command. Return its promise and put success effects
   * (toasts, closing) after it: callbacks passed to `mutate()` are dropped
   * once this dialog unmounts. A rejection keeps the dialog open; show the
   * failure through `error`.
   */
  onConfirm: () => unknown;
  cancelLabel?: string;
  /** Replaces the plain close, e.g. "Stay" that keeps an unfinished edit. */
  onCancel?: () => void;
  /**
   * The last attempt's outcome is unknown: confirming sends the exact same
   * command again ("Try again"), its failure reads as a warning, and Close
   * drops it. Nothing else can be sent until it is resolved.
   */
  unconfirmed?:
    | Readonly<{
        onRetry: () => unknown;
        onDismiss: () => void;
      }>
    | undefined;
  error?: ReactNode;
  /** Unconfirmed outcomes are warnings, not failures. */
  errorTone?: 'destructive' | 'warning';
  errorAction?: ReactNode;
  /** A second way out between Cancel and confirm, e.g. "Leave anyway". */
  secondaryAction?: ReactNode;
  confirmDisabled?: boolean;
}>;

/**
 * The one confirmation dialog: title, what happens, optional inputs, one
 * failure line and Cancel beside the confirming command, which shows the
 * standard pending treatment. It is a form, so Enter confirms.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  consequences,
  children,
  tone = 'default',
  confirmLabel,
  pendingLabel,
  pending = false,
  locked = pending,
  onConfirm,
  cancelLabel = 'Cancel',
  onCancel,
  unconfirmed,
  error,
  errorTone = 'destructive',
  errorAction,
  secondaryAction,
  confirmDisabled = false,
}: ConfirmDialogProps) {
  const run = unconfirmed?.onRetry ?? onConfirm;
  const cancel =
    unconfirmed === undefined
      ? onCancel
      : () => {
          unconfirmed.onDismiss();
          onOpenChange(false);
        };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || !locked) onOpenChange(next);
      }}
    >
      {trigger === undefined ? null : <DialogTrigger render={trigger} />}
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        {description === undefined ? null : (
          <DialogDescription>{description}</DialogDescription>
        )}
        {consequences === undefined ? null : (
          <ul className="mt-4 flex flex-col gap-2 text-sm leading-relaxed text-muted-foreground">
            {consequences.map((line) => (
              <li key={line} className="flex gap-2.5">
                <span
                  aria-hidden="true"
                  className="mt-2.5 h-px w-3 shrink-0 bg-border-strong"
                />
                {line}
              </li>
            ))}
          </ul>
        )}
        <form
          noValidate
          className="mt-6 flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending || confirmDisabled) return;
            // Failures render through `error`; nothing else to do here.
            void Promise.resolve(run()).catch(() => undefined);
          }}
        >
          {children}
          {error === undefined ? null : (
            <Notice
              role="alert"
              tone={unconfirmed === undefined ? errorTone : 'warning'}
              action={errorAction}
            >
              {error}
            </Notice>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {cancel === undefined ? (
              <DialogClose
                disabled={locked}
                render={<Button type="button" variant="ghost" />}
              >
                {cancelLabel}
              </DialogClose>
            ) : (
              <Button type="button" variant="ghost" onClick={cancel}>
                {unconfirmed === undefined ? cancelLabel : 'Close'}
              </Button>
            )}
            {secondaryAction}
            <ProgressButton
              type="submit"
              variant={tone === 'destructive' ? 'destructive' : 'primary'}
              pending={pending}
              pendingLabel={pendingLabel ?? confirmLabel}
              disabled={confirmDisabled}
            >
              {unconfirmed === undefined ? confirmLabel : 'Try again'}
            </ProgressButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
