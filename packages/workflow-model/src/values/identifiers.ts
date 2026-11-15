/** Lowercase persisted UUIDs. HTTP boundaries may explicitly allow casing. */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** The longest idempotency key a client may send with a command. */
export const IDEMPOTENCY_KEY_MAX_CHARACTERS = 128;
