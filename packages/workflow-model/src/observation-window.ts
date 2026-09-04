/**
 * Storage-to-engine contract for one coordinator advancement window.
 * Changing these values requires a versioned cursor/protocol migration.
 */
export const WORKFLOW_OBSERVATION_WINDOW_LIMITS_V1 = Object.freeze({
  facts: 10_000,
  canonicalFactBytes: 4_096,
  canonicalWindowBytes: 40_960_000,
});
