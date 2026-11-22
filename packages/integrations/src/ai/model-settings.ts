import { MODEL_IDENTIFIER_MAX_CHARACTERS } from '@pertexo/node-sdk';
import { z } from 'zod';

export const MODEL_LIMITS = {
  requestBytes: 64 * 1_024,
  responseBytes: 128 * 1_024,
  defaultOutputTokens: 1_024,
  maxOutputTokens: 4_096,
  defaultTimeoutMillis: 30_000,
  maxTimeoutMillis: 60_000,
} as const;

export const modelSettings = {
  model: z
    .string()
    .min(1)
    .max(MODEL_IDENTIFIER_MAX_CHARACTERS)
    .refine((value) => value.trim() !== '')
    .meta({
      title: 'Model identifier',
      description: 'Use the model identifier from your provider.',
    }),
  timeoutMillis: z
    .number()
    .int()
    .positive()
    .max(MODEL_LIMITS.maxTimeoutMillis)
    .optional()
    .meta({ title: 'Timeout', default: MODEL_LIMITS.defaultTimeoutMillis }),
  maxOutputTokens: z
    .number()
    .int()
    .positive()
    .max(MODEL_LIMITS.maxOutputTokens)
    .optional()
    .meta({
      title: 'Maximum output tokens',
      default: MODEL_LIMITS.defaultOutputTokens,
    }),
};
