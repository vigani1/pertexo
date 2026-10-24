import { z } from 'zod';

export const purpose = z.enum([
  'workspace_notice',
  'two_factor_disabled',
  'recovery_code_sign_in',
  'verification',
  'password_reset',
  'email_change_confirmation',
]);

export const sealedPayload = z
  .object({
    ciphertext: z.string().min(1).max(32_768),
    nonce: z.string().min(1).max(128),
    tag: z.string().min(1).max(256),
    keyVersion: z.string().min(1).max(64),
  })
  .strict();
