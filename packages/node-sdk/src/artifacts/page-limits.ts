/** Explicit file pages keep large datasets outside mapped values and checkpoints. */
export const FILE_PAGE_LIMITS = Object.freeze({
  fileBytes: 10_485_760,
  totalBytes: 10_485_760,
  totalItems: 100_000,
  pages: 256,
  bytes: 65_536,
  items: 1_000,
  depth: 48,
  members: 4_000,
});

export const FILE_TRANSFER_NO_PROGRESS_MILLIS = 60_000;
