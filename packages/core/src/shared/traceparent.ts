import { z } from 'zod';

export const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  // W3C trace context: an all-zero trace id or parent id is invalid.
  .refine((value) => !/^00-0{32}-/u.test(value))
  .refine((value) => !/^00-[\da-f]{32}-0{16}-/u.test(value))
  .optional();
