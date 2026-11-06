export function notifyConsumerObserver(notify: () => void): boolean {
  try {
    notify();
    return true;
  } catch {
    // Operational telemetry cannot change queue delivery semantics.
    return false;
  }
}
