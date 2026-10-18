import { z } from 'zod';

export const authorizationStartedSchema = z
  .object({ authorizationUrl: z.url() })
  .strict();
