import { isWellFormed } from '../text.js';
import { z } from 'zod';

export function isStorageText(value: string): boolean {
  return !value.includes('\0') && isWellFormed(value);
}

export const storageTextSchema = z
  .string()
  .refine(isStorageText, 'Use valid Unicode text without null characters.');
