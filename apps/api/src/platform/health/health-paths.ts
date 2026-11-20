/** Where the orchestrator probes the API; metrics and load shedding leave these out. */
export const HEALTH_PATHS = Object.freeze({
  live: '/health/live',
  ready: '/health/ready',
});
