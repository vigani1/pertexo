/** Fixed guidance when a provider minimum cannot fit the automatic retry contract. */
export const PROVIDER_RETRY_FAILURE = Object.freeze({
  code: 'provider.retry_after_exceeded',
  sentence:
    'The service asked Pertexo to wait longer than the automatic retry limit.',
  advice:
    'Wait for the service’s requested delay before starting another run. Pertexo stopped instead of calling it early.',
} as const);
