/** An instance's limits when its operator sets nothing, sized for a real server. */
export const DEFAULT_RUN_CAPACITY_LIMITS = Object.freeze({
  activeRunLimit: 20,
  queuedRunLimit: 10_000,
});
