import { z } from 'zod';

export const storageTextSchema = z
  .string()
  .refine(
    (value) => !value.includes('\0') && !/[\uD800-\uDFFF]/u.test(value),
    'Use valid Unicode text without null characters.',
  );
