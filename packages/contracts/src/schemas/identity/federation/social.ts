import { z } from 'zod';
import { authenticationProviderSchema } from '../authentication.js';

export const socialSignInStartSchema = z
  .object({
    provider: authenticationProviderSchema,
    callbackURL: z.string().max(2048).optional(),
    errorCallbackURL: z.string().max(2048).optional(),
  })
  .strict();

export const socialSignInStartedSchema = z
  .object({ url: z.url(), redirect: z.boolean() })
  .strict();
