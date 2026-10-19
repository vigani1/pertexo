import { z } from 'zod';

export const csrfTokenSchema = z.string().min(16).max(256);

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x2b\x2d-\x7e]+$/u);

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
