import { z } from 'zod';
import { authenticationProviderSchema } from '../authentication.js';

const SOCIAL_BOUNDS = Object.freeze({
  callbackURLCharacters: 2048,
  errorCallbackURLCharacters: 2048,
});

export const socialSignInStartSchema = z
  .object({
    provider: authenticationProviderSchema,
    callbackURL: z.string().max(SOCIAL_BOUNDS.callbackURLCharacters).optional(),
    errorCallbackURL: z
      .string()
      .max(SOCIAL_BOUNDS.errorCallbackURLCharacters)
      .optional(),
  })
  .strict();

export const socialSignInStartedSchema = z
  .object({ url: z.url(), redirect: z.boolean() })
  .strict();
