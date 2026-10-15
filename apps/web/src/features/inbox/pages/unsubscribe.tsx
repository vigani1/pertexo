import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ApiClient } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Status } from '@/components/ui/status';
import { unsubscribeFromNotices } from '../data/preferences.api';
/** No query key or automatic request contains the fragment capability. */
export function NoticeUnsubscribePage({
  apiClient,
  token,
}: {
  apiClient: ApiClient;
  token: string | null;
}) {
  const cache = useQueryClient();
  const command = useMutation({
    mutationFn: () =>
      token === null
        ? Promise.reject(new Error('Unavailable link'))
        : unsubscribeFromNotices(apiClient, token),
    retry: false,
    // The capability stays opaque; refresh any personal schedules cached in this tab.
    onSuccess: () =>
      cache.invalidateQueries({
        predicate: ({ queryKey }) =>
          queryKey[0] === 'identity' &&
          queryKey[4] === 'inbox' &&
          queryKey[5] === 'preferences',
      }),
  });
  return (
    <main className="min-h-dvh bg-background px-5 py-12 text-foreground">
      <div className="mx-auto flex max-w-xl flex-col gap-6">
        <p className="font-heading text-lg">Pertexo</p>
        <h1 className="font-heading text-2xl">Turn off personal email?</h1>
        <p className="text-sm text-muted-foreground">
          This turns off workspace notification email for your account. Your
          Inbox, pending requests and shared workflow alerts stay available.
        </p>
        {token === null || command.isError ? (
          <Notice tone="warning">
            This link is unavailable or could not be confirmed. You can retry,
            or sign in and change Notification settings.
          </Notice>
        ) : null}
        {command.isSuccess ? (
          <Status tone="success">Personal notification email is off</Status>
        ) : (
          <Button
            disabled={token === null || command.isPending}
            onClick={() => {
              command.mutate();
            }}
          >
            {command.isPending
              ? 'Turning email off…'
              : 'Turn off personal email'}
          </Button>
        )}
        <Link to="/login" className="text-sm underline underline-offset-4">
          Sign in
        </Link>
      </div>
    </main>
  );
}
