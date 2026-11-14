import { STORED_EXECUTION_VALUE_LIMITS } from '@pertexo/node-sdk';

export const SUMMARY_RESULT_FAILURE = Object.freeze({
  code: 'list.summary_too_large',
  sentence: `Summarize’s grouped output exceeds the retained data limits (${String(STORED_EXECUTION_VALUE_LIMITS.inlineBytes / 1024)} KiB, depth ${String(STORED_EXECUTION_VALUE_LIMITS.depth)}, or ${STORED_EXECUTION_VALUE_LIMITS.members.toLocaleString('en-US')} members).`,
  advice:
    'Group fewer distinct values or process the input in smaller batches.',
});
