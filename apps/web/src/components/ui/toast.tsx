import type { ReactNode } from 'react';
import { Toast } from '@base-ui/react/toast';
import { XIcon } from 'lucide-react';
import { cn } from '@/lib/class-names';
import { buttonVariants } from './button-variants';
import {
  StatusMark,
  type StatusTone,
} from '@/components/patterns/status/status-mark';
import { LoadingOrb } from './loading-orb';
import { NoticeTimer } from '@/components/patterns/notices/notice-timer';

const TONE_BY_TYPE: Record<string, StatusTone> = {
  success: 'success',
  error: 'failure',
  info: 'live',
  undo: 'queued',
  attention: 'attention',
};

function ToastLeading({ type }: Readonly<{ type: string | undefined }>) {
  if (type === 'loading') return <LoadingOrb />;
  return (
    <StatusMark display="mark" tone={TONE_BY_TYPE[type ?? 'info'] ?? 'live'} />
  );
}

function ToastCard({ toast }: Readonly<{ toast: Toast.Root.ToastObject }>) {
  const timeout = toast.timeout ?? 0;
  return (
    <Toast.Root
      toast={toast}
      className={cn(
        'popup-lens group/toast relative grid w-full grid-cols-[1.25rem_minmax(0,1fr)_auto_auto] items-center gap-2.5 rounded-lg py-3 pr-2.5 pl-3 text-sm outline-none',
        'transition-[opacity,transform] duration-300 ease-unspool data-ending-style:translate-x-6 data-ending-style:opacity-0 data-limited:hidden data-starting-style:translate-y-3 data-starting-style:opacity-0 motion-reduce:transition-none',
        toast.type === 'loading' && 'live-edge',
      )}
    >
      <ToastLeading type={toast.type} />
      <Toast.Content className="min-w-0">
        <Toast.Title className="font-semibold text-foreground" />
        <Toast.Description className="mt-0.5 text-label text-muted-foreground" />
      </Toast.Content>
      <Toast.Action className={buttonVariants({ size: 'sm' })} />
      <Toast.Close
        aria-label="Dismiss notification"
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
          'relative rounded-full',
        )}
      >
        <XIcon aria-hidden="true" />
      </Toast.Close>
      <NoticeTimer timeout={timeout} appearance="thread" />
    </Toast.Root>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => <ToastCard key={toast.id} toast={toast} />);
}

/**
 * App-wide notification viewport: bottom-right lenses, at most three visible,
 * each with a countdown thread that pauses on hover and focus.
 * While a side sheet is open the stack steps aside (see `globals.css`).
 * Modal dialogs place it below their backdrop so actions stay unobstructed.
 * Errors never time out. Use `useNotifications` to raise one.
 */
export function NotificationsProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <Toast.Provider limit={3}>
      {children}
      <Toast.Portal>
        <Toast.Viewport
          data-slot="toast-viewport"
          className="fixed top-[var(--toast-top,auto)] right-[var(--toast-right,1rem)] bottom-[var(--toast-bottom,1rem)] z-[var(--toast-z-index,60)] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 outline-none [pointer-events:var(--toast-pointer-events,auto)]"
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
