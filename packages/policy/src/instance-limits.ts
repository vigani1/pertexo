/*
 * An instance's limits when its operator sets nothing, sized for a real
 * server. They live here, not in core, so reading startup settings doesn't
 * load the core runtime: a refused start used to load ~1,800 modules first.
 */
export const DEFAULT_RUN_CAPACITY_LIMITS = Object.freeze({
  activeRunLimit: 20,
  queuedRunLimit: 10_000,
});
/** Default retained-file quota when an instance sets no override. */
export const DEFAULT_ARTIFACT_COUNT_LIMIT = 10_000;
/** Default endpoint burst budget when an instance sets no override. */
export const DEFAULT_WEBHOOK_ENDPOINT_BURST_LIMIT = 600;
