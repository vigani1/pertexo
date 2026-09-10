import { z } from 'zod';

export const csrfTokenSchema = z.string().min(16).max(256);

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x2b\x2d-\x7e]+$/u);

export const webhookJsonContentTypeSchema = z
  .string()
  .regex(
    /^[aA][pP][pP][lL][iI][cC][aA][tT][iI][oO][nN]\/[jJ][sS][oO][nN](?:\s*;\s*[cC][hH][aA][rR][sS][eE][tT]=[uU][tT][fF]-8)?$/u,
  );
