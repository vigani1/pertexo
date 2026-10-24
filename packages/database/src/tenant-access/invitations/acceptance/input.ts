import { z } from 'zod';

export const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u);
