import type { FailureNotificationDestinationResponse } from '@pertexo/contracts/schemas/failure-notifications';
import { Notice } from '@/components/ui/notice';
import { Status } from '@/components/ui/status';
import { describeDestination } from '../../model/destination-label';

/**
 * The workflow's current failure-alert choice in words. A destination that
 * was turned off stays the choice, but nothing is sent until it is replaced
 * or turned back on, so that is said plainly.
 */
export function CurrentAlertDestination({
  destination,
  connectionNames,
}: Readonly<{
  destination: FailureNotificationDestinationResponse | null;
  connectionNames: ReadonlyMap<string, string>;
}>) {
  if (destination === null)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Status tone="neutral">Off</Status>
        Failures of this workflow aren’t announced anywhere.
      </p>
    );
  const label = describeDestination(destination, connectionNames);
  if (destination.status === 'disabled')
    return (
      <Notice tone="warning" title={`Failures go to: ${label}`}>
        That destination is turned off, so nothing is sent. Choose another
        destination below, or turn it back on in Alerts.
      </Notice>
    );
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <Status tone="success">On</Status>
      <span className="text-muted-foreground">Failures go to</span>
      <span className="min-w-0 font-medium break-words">{label}</span>
    </p>
  );
}
