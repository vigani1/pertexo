import type { FailureNotificationDestinationConfig } from '@pertexo/workflow-model';
import {
  eligibleNotificationConnection,
  eligibleNotificationDestination,
} from '@pertexo/workflow-model';

/** How a failure alert ended when nobody can say it arrived. */
export const UNDELIVERED_ALERT_STATUSES = [
  'dead_letter',
  'outcome_unknown',
] as const;

type FailureAlertFacts = Readonly<{
  destination: Readonly<{
    connection_id: string | null;
    destination_status: string;
    kind: FailureNotificationDestinationConfig['kind'];
    side_effect_class: string;
    current_config_version: number;
  }>;
  connection:
    | Readonly<{
        auth_type: string;
        provider_key: string;
        status: string;
        current_secret_version_id: string | null;
        secret_exists: boolean;
      }>
    | undefined;
  /** A workflow's policy names this destination. */
  hasPolicy: boolean;
  /**
   * The destination's latest finished alert didn't arrive, is recent, and neither
   * the destination nor its credential has changed since. A later delivery or a
   * fix is what ends this; the next alert then shows whether it worked.
   */
  latestAlertUndelivered: boolean;
}>;

/**
 * Whether failure alerts through this destination need someone. The revision names
 * the cause, not the failure: more failed alerts for one cause don't make the
 * notice unread again, or send another mail.
 */
export function failureAlertAttention({
  destination,
  connection,
  hasPolicy,
  latestAlertUndelivered,
}: FailureAlertFacts): Readonly<{ active: boolean; sourceRevision: string }> {
  const honourable =
    eligibleNotificationDestination(destination) &&
    eligibleNotificationConnection(destination.kind, connection) &&
    connection.secret_exists;
  const policyStranded = hasPolicy && !honourable;
  const undelivered =
    destination.destination_status === 'enabled' && latestAlertUndelivered;
  const cause = policyStranded ? 'policy' : 'delivery';
  return {
    active: policyStranded || undelivered,
    sourceRevision: `${cause}:${String(destination.current_config_version)}:${connection?.current_secret_version_id ?? 'none'}`,
  };
}
