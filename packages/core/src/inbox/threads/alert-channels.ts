import type { FailureNotificationDestinationConfig } from '@pertexo/workflow-model';

/** What a failure alert notice calls the place alerts aren't reaching. */
export const FAILURE_ALERT_CHANNEL_NAMES: Readonly<
  Record<FailureNotificationDestinationConfig['kind'], string>
> = { slack: 'Slack', email: 'email' };
