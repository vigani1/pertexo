import { z } from 'zod';

const TRANSPORT_HEADERS_BOUNDS = Object.freeze({
  csrfTokenMinimumCharacters: 16,
  csrfTokenCharacters: 256,
  idempotencyKeyCharacters: 128,
});

export const csrfTokenSchema = z
  .string()
  .min(TRANSPORT_HEADERS_BOUNDS.csrfTokenMinimumCharacters)
  .max(TRANSPORT_HEADERS_BOUNDS.csrfTokenCharacters);

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(TRANSPORT_HEADERS_BOUNDS.idempotencyKeyCharacters)
  .regex(/^[\x21-\x2b\x2d-\x7e]+$/u);
/** How long a key is honored: a retry with the same key inside it replays. */
export { IDEMPOTENCY_KEY_RETENTION_HOURS } from '@pertexo/workflow-model';

// JSON Schema patterns carry no flags, so letters match either case by hand.
const caseless = (text: string) =>
  text.replace(/[a-z]/gu, (letter) => `[${letter}${letter.toUpperCase()}]`);

/** JSON (including `+json` types), form-encoded or plain text, in UTF-8. */
export const webhookContentTypeSchema = z
  .string()
  .regex(
    new RegExp(
      `^(?:${caseless('application')}\\/(?:[A-Za-z0-9.-]+\\+)?${caseless('json')}|${caseless('application')}\\/${caseless('x-www-form-urlencoded')}|${caseless('text')}\\/${caseless('plain')})(?:\\s*;\\s*${caseless('charset')}=(?:${caseless('utf-8')}|"${caseless('utf-8')}"))?$`,
      'u',
    ),
  );
