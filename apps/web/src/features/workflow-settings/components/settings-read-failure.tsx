import { Notice } from '@/components/ui/notice';
import { isApiError } from '@/lib/api/error';
import { settingsReadIsUnavailable } from '../model/settings-query';

/**
 * The settings reads' own failures, for `QueryView`'s `failure`: an
 * unconfigured webhook server, and losing access to the workflow.
 */
export function settingsReadFailure(error: unknown) {
  if (isApiError(error) && error.problem?.code === 'webhook.not_configured')
    return (
      <Notice tone="warning">
        Webhooks are unavailable on this server. Ask the operator to configure
        webhook secret encryption.
      </Notice>
    );
  if (settingsReadIsUnavailable(error))
    return (
      <p className="text-sm text-muted-foreground">
        This isn’t available to you. The workflow may have been removed, or your
        role changed.
      </p>
    );
  return undefined;
}
