/** Readers yield to the event loop after this many bytes, so one large file can't starve other runs. */
export const READ_YIELD_BYTES = 65_536;

/** Inline text is fed to a parser in pieces of this size, so cancellation is checked between them. */
export const INLINE_CHUNK_BYTES = 4_096;
