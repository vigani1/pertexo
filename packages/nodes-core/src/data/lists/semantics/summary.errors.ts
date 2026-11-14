import {
  formatByteSize,
  formatCount,
  STORED_EXECUTION_VALUE_LIMITS,
} from '@pertexo/node-sdk';

export const SUMMARY_RESULT_FAILURE = Object.freeze({
  code: 'list.summary_too_large',
  sentence: `Summarize’s grouped output exceeds the retained data limits (${formatByteSize(STORED_EXECUTION_VALUE_LIMITS.inlineBytes)}, depth ${String(STORED_EXECUTION_VALUE_LIMITS.depth)}, or ${formatCount(STORED_EXECUTION_VALUE_LIMITS.members)} members).`,
  advice:
    'Group fewer distinct values or process the input in smaller batches.',
});
