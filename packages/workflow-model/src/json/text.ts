import { z } from 'zod';

export function isStorageText(value: string): boolean {
  return !value.includes('\0') && !/[\uD800-\uDFFF]/u.test(value);
}

export const storageTextSchema = z
  .string()
  .refine(isStorageText, 'Use valid Unicode text without null characters.');
