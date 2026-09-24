import { useMemo, type ReactNode } from 'react';
import { Toast } from '@base-ui/react/toast';

type Message = Readonly<{ title: ReactNode; description?: ReactNode }>;

// One timing and announcement policy for every notification in the product.
const SUCCESS_TIMEOUT_MS = 4_000;
const INFO_TIMEOUT_MS = 6_000;
const UNDO_TIMEOUT_MS = 8_000;

export type Notifications = Readonly<{
  success(message: Message): string;
  info(message: Message & { timeoutMs?: number }): string;
  /** Errors persist until dismissed and are announced assertively. */
  error(message: Message & { action?: NotificationAction }): string;
  /** The thread timer is the undo window. */
  undo(message: Message & { onUndo: () => void }): string;
  /** One notification that turns from progress into its outcome in place. */
  track<Result>(
    work: Promise<Result>,
    messages: Readonly<{
      loading: Message;
      success: Message | ((result: Result) => Message);
      error: Message | ((error: unknown) => Message);
    }>,
  ): Promise<Result>;
  dismiss(id: string): void;
}>;

type NotificationAction = Readonly<{
  label: string;
  onClick: () => void;
}>;

export function useNotifications(): Notifications {
  const manager = Toast.useToastManager();
  return useMemo<Notifications>(
    () => ({
      success: (message) =>
        manager.add({
          ...message,
          type: 'success',
          timeout: SUCCESS_TIMEOUT_MS,
        }),
      info: ({ timeoutMs, ...message }) =>
        manager.add({
          ...message,
          type: 'info',
          timeout: timeoutMs ?? INFO_TIMEOUT_MS,
        }),
      error: ({ action, ...message }) =>
        manager.add({
          ...message,
          type: 'error',
          timeout: 0,
          priority: 'high',
          ...(action === undefined
            ? {}
            : {
                actionProps: {
                  children: action.label,
                  onClick: action.onClick,
                },
              }),
        }),
      undo: ({ onUndo, ...message }) => {
        const id = manager.add({
          ...message,
          type: 'undo',
          timeout: UNDO_TIMEOUT_MS,
          actionProps: {
            children: 'Undo',
            onClick: () => {
              onUndo();
              manager.close(id);
            },
          },
        });
        return id;
      },
      track: (work, messages) =>
        manager.promise(work, {
          loading: { ...messages.loading, type: 'loading', timeout: 0 },
          success: (result) => ({
            ...(typeof messages.success === 'function'
              ? messages.success(result)
              : messages.success),
            type: 'success',
            timeout: SUCCESS_TIMEOUT_MS,
          }),
          error: (error) => ({
            ...(typeof messages.error === 'function'
              ? messages.error(error)
              : messages.error),
            type: 'error',
            timeout: 0,
            priority: 'high',
          }),
        }),
      dismiss: (id) => {
        manager.close(id);
      },
    }),
    [manager],
  );
}
