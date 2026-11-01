import type { WebhookAuthentication } from '@pertexo/contracts';

/** The statuses that decide whether an address takes deliveries. */
export type EndpointStanding = Readonly<{
  endpointStatus: string;
  workflowLifecycleStatus: string;
  workspaceStatus: string;
}>;

/**
 * The one place this is decided. The public lookup asks it before any signature is
 * checked or any limit spent, so a closed address reads as an unknown one; admission
 * asks it again under its locks, because the answer can change in between.
 */
export function endpointTakesDeliveries({
  endpointStatus,
  workflowLifecycleStatus,
  workspaceStatus,
}: EndpointStanding): boolean {
  return (
    endpointStatus === 'active' &&
    workflowLifecycleStatus === 'active' &&
    workspaceStatus === 'active'
  );
}

/** Changing how senders prove themselves replaces the address and the secret. */
export function authenticationChangeRotates(
  current: WebhookAuthentication,
  next: WebhookAuthentication,
): boolean {
  return (
    current.mode !== next.mode ||
    (current.mode === 'header_secret' &&
      next.mode === 'header_secret' &&
      current.headerName !== next.headerName)
  );
}

/** Why a trigger in this status can't take an endpoint, or undefined when it can. */
export function provisionRefusal(
  status: string,
): 'setting_up' | 'provisioned' | 'unavailable' | undefined {
  if (status === 'desired' || status === 'pending') return 'setting_up';
  if (status === 'active' || status === 'degraded') return 'provisioned';
  return status === 'configuration_required' ? undefined : 'unavailable';
}
