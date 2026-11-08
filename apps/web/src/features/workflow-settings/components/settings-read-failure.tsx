import { Notice } from '@/components/ui/notice';
import { isApiError } from '@/lib/api/error';
import { isAccessLost } from '@/lib/api/error-copy';
import { ReadRecovery } from '@/components/patterns/states/read-recovery';
import type { ReadFailureRecovery } from '@/components/patterns/states/query-view';

/**
 * The settings reads' own failures, for `QueryView`'s `failure`: an
 * unconfigured webhook server, and losing access to the workflow. Lost access
 * keeps the shared Retry, since a restored role or workflow makes it work.
 */
export function settingsReadFailure(
  error: unknown,
  { resource, retrying, retry }: ReadFailureRecovery,
) {
  if (isApiError(error) && error.problem?.code === 'webhook.not_configured')
    return (
      <Notice tone="warning">
        Webhooks are unavailable on this server. Ask the operator to configure
        webhook secret encryption.
      </Notice>
    );
  if (isAccessLost(error))
    return (
      <Notice tone="destructive">
        <ReadRecovery
          error={error}
          resource={resource}
          retrying={retrying}
          retry={retry}
          message="This isn’t available to you. The workflow may have been removed, or your role changed."
        />
      </Notice>
    );
  return undefined;
}
