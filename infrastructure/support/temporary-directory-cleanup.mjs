export async function preserveTemporaryDirectoryFailure(primary, cleanup) {
  try {
    await cleanup();
  } catch (cleanupError) {
    if (primary.failed)
      throw new AggregateError(
        [primary.error, cleanupError],
        'Temporary-directory work failed and cleanup was incomplete',
      );
    throw cleanupError instanceof Error
      ? cleanupError
      : new Error('Temporary-directory cleanup failed', {
          cause: cleanupError,
        });
  }
}
