import type { ReactElement, ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';

type ConfirmDialogProps = Readonly<{
  state: Readonly<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    locked: boolean;
  }>;
  trigger?: ReactElement;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
  /** Return the command promise; the caller owns its visible failure and success effects. */
  onSubmit: () => unknown;
  submitDisabled?: boolean;
}>;

/** A controlled confirmation form: Enter submits, and locked state prevents dismissal. */
export function ConfirmDialog({
  state,
  trigger,
  title,
  description,
  children,
  footer,
  onSubmit,
  submitDisabled = false,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={state.open}
      onOpenChange={(next) => {
        if (next || !state.locked) state.onOpenChange(next);
      }}
    >
      {trigger === undefined ? null : <DialogTrigger render={trigger} />}
      <DialogContent className="flex flex-col overflow-hidden">
        <DialogTitle className="shrink-0">{title}</DialogTitle>
        {description === undefined ? null : (
          <DialogDescription className="shrink-0">
            {description}
          </DialogDescription>
        )}
        <form
          noValidate
          className="mt-6 flex min-h-0 flex-1 flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (submitDisabled) return;
            // The caller renders the failure; a rejected command must not escape the form.
            void Promise.resolve(onSubmit()).catch(() => undefined);
          }}
        >
          {children}
          {footer}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The shared footer layout leaves each confirmation's commands explicit. */
export function ConfirmationFooter({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex shrink-0 flex-wrap justify-end gap-2">{children}</div>
  );
}

/** The scrollable form content; simple confirmations need no empty area. */
export function ConfirmationDetails({
  consequences,
  children,
  error,
  tone = 'destructive',
  errorAction,
}: Readonly<{
  consequences?: readonly string[] | undefined;
  children?: ReactNode;
  error?: ReactNode;
  tone?: 'destructive' | 'warning';
  errorAction?: ReactNode;
}>) {
  if (
    children === undefined &&
    consequences === undefined &&
    error === undefined
  )
    return null;
  return (
    <div className="-mx-1 flex min-h-0 flex-col gap-5 overflow-y-auto overscroll-contain px-1">
      {consequences === undefined ? null : (
        <ul className="flex flex-col gap-2 text-sm leading-relaxed text-muted-foreground">
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
      {children}
      {error === undefined ? null : (
        <Notice role="alert" tone={tone} action={errorAction}>
          {error}
        </Notice>
      )}
    </div>
  );
}
