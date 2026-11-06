/**
 * A run job that can never be delivered as written, so it is rebuilt from the
 * run. Only a run still underway needs it, and a running attempt's lease is its
 * clock.
 */
export function overdueDeliveryAction(
  delivery: Readonly<{
    runStatus: string | undefined;
    attemptStatus: string | undefined;
    jobName: string;
  }>,
): 'replace' | 'drop' {
  if (
    delivery.runStatus !== 'queued' &&
    delivery.runStatus !== 'running' &&
    delivery.runStatus !== 'waiting'
  )
    return 'drop';
  return delivery.jobName !== 'execute-node-attempt' ||
    delivery.attemptStatus === 'ready'
    ? 'replace'
    : 'drop';
}
