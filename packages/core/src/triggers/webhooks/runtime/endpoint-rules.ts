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
