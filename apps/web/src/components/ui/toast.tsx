import type { CSSProperties, ReactNode } from 'react';
import { Toast } from '@base-ui/react/toast';
import { XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buttonVariants } from './button-variants';
import { StatusGlyph, type StatusTone } from './status';
import { LoadingOrb } from './loading-orb';

const TONE_BY_TYPE: Record<string, StatusTone> = {
  success: 'success',
  error: 'failure',
  info: 'live',
  undo: 'queued',
  attention: 'attention',
};

const TIMER_COLOR_BY_TYPE: Record<string, string> = {
  success: 'text-success',
  info: 'text-primary',
  undo: 'text-secondary',
  attention: 'text-warning',
};

function ToastLeading({ type }: Readonly<{ type: string | undefined }>) {
  if (type === 'loading') return <LoadingOrb />;
  return <StatusGlyph tone={TONE_BY_TYPE[type ?? 'info'] ?? 'live'} />;
}

function ToastCard({ toast }: Readonly<{ toast: Toast.Root.ToastObject }>) {
  const timeout = toast.timeout ?? 0;
  const timerColor = TIMER_COLOR_BY_TYPE[toast.type ?? ''];
  return (
    <Toast.Root
      toast={toast}
      className={cn(
        'lens group/toast relative grid w-full grid-cols-[1rem_minmax(0,1fr)_auto_auto] items-center gap-2.5 rounded-lg py-3 pr-2.5 pl-3 text-sm outline-none',
        'transition-[opacity,transform] duration-300 ease-unspool data-ending-style:translate-x-6 data-ending-style:opacity-0 data-limited:hidden data-starting-style:translate-y-3 data-starting-style:opacity-0 motion-reduce:transition-none',
        toast.type === 'loading' && 'live-edge',
        toast.type === 'error' && 'ring-1 ring-destructive/30',
      )}
    >
      <ToastLeading type={toast.type} />
      <Toast.Content className="min-w-0">
        <Toast.Title className="font-semibold text-foreground" />
        <Toast.Description className="mt-0.5 text-[0.8rem] text-muted-foreground" />
      </Toast.Content>
      <Toast.Action className={buttonVariants({ size: 'sm' })} />
      <Toast.Close
        aria-label="Dismiss notification"
        className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
      >
        <XIcon aria-hidden="true" />
      </Toast.Close>
      {timeout > 0 && timerColor !== undefined ? (
        <span
          aria-hidden="true"
          style={{ '--toast-timeout': `${String(timeout)}ms` } as CSSProperties}
          className={cn(
            'absolute bottom-1.5 left-3 h-0.5 w-[calc(100%-1.5rem)] rounded-full bg-current',
            'animate-[thread-timer_var(--toast-timeout)_linear_forwards] group-data-expanded/toast:[animation-play-state:paused] motion-reduce:animate-none',
            'after:absolute after:-top-0.5 after:-right-0.5 after:size-1.5 after:rounded-full after:bg-current after:shadow-[0_0_6px_currentColor]',
            timerColor,
          )}
        />
      ) : null}
    </Toast.Root>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => <ToastCard key={toast.id} toast={toast} />);
}

/**
 * App-wide notification viewport: bottom-right lenses, at most three visible,
 * each with a thread that counts down its timeout and pauses on hover/focus.
 * Errors never time out. Use `useNotifications` to raise one.
 */
export function NotificationsProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <Toast.Provider limit={3}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="fixed right-4 bottom-4 z-60 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
