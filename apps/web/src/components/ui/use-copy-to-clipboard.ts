import { useCallback } from 'react';
import { copyText } from '@/lib/clipboard';
import { useNotifications } from './use-notifications';

/**
 * Copying from a menu, where nothing stays on screen to confirm in place:
 * the outcome is a toast, worded like `CopyButton`'s ("Workflow ID copied").
 * `subject` is lower case, e.g. "workflow ID"; `elsewhere` says where else
 * the value can be copied from if the browser blocks the clipboard.
 */
export function useCopyToClipboard() {
  const notifications = useNotifications();
  return useCallback(
    async (
      value: string,
      subject: string,
      options: Readonly<{ description?: string; elsewhere?: string }> = {},
    ) => {
      if (await copyText(value)) {
        notifications.success({
          title: `${subject.charAt(0).toUpperCase()}${subject.slice(1)} copied`,
          ...(options.description === undefined
            ? {}
            : { description: options.description }),
        });
        return;
      }
      notifications.error({
        title: `Couldn’t copy the ${subject}`,
        description: ['Your browser blocked the clipboard.', options.elsewhere]
          .filter(Boolean)
          .join(' '),
      });
    },
    [notifications],
  );
}
