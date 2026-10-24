import type { z } from 'zod';
import type { optionsSchema } from './input.js';
import type { RetentionRuleName } from './rules.js';
export type { RetentionRuleName } from './rules.js';

export type RetentionPassResult = Readonly<{
  /** Rows each rule removed or cleared. */
  removed: Readonly<Record<RetentionRuleName, number>>;
  /** Some rule filled its page, so more rows are due now. */
  more: boolean;
}>;

export interface RetentionDatabase {
  checkReadiness(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  /** Runs every rule once, one page each. */
  enforce(signal?: AbortSignal): Promise<RetentionPassResult>;
}

export type RetentionDatabaseOptions = z.input<typeof optionsSchema>;
