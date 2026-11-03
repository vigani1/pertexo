import type { RetentionRuleName } from './rules.js';
export type { RetentionRuleName } from './rules.js';

export type RetentionPassResult = Readonly<{
  /** Rows each rule removed or cleared. */
  removed: Readonly<Record<RetentionRuleName, number>>;
  /** Some rule filled its page, so more rows are due now. */
  more: boolean;
}>;
