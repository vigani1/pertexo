export const PROMOTION_LIMITS = Object.freeze({
  workflows: 20,
  graphBytes: 2 * 1024 * 1024,
  responseBytes: 4 * 1024 * 1024,
  requirements: 1000,
  page: 50,
});

/** How many people a restricted connection can be shared with. */
export const CONNECTION_SHARE_LIMIT = 100;

/** How many members and groups a restricted folder can list. */
export const FOLDER_GRANT_LIMIT = 100;

export const COLLABORATION_LIMITS = Object.freeze({
  body: 8000,
  mentions: 20,
  page: 20,
  presence: 100,
  tabs: 10,
  leaseSeconds: 45,
  heartbeatMs: 15000,
  pollMs: 10000,
});
