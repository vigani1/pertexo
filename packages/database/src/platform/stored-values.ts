const storedDataErrors = new WeakSet<Error>();

/** Preserve the decoder's error while recording that its input came from storage. */
export function decodeStoredValue<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error: unknown) {
    const failure =
      error instanceof Error
        ? error
        : new Error('Stored value could not be decoded', { cause: error });
    storedDataErrors.add(failure);
    throw failure;
  }
}

/** A stored decode failure must never be presented as invalid caller input. */
export function isStoredDataError(error: unknown): boolean {
  return error instanceof Error && storedDataErrors.has(error);
}
