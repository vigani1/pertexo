import type { CodeResult } from '@pertexo/node-sdk';
import { prepareStoredExecutionValue } from '@pertexo/core/runs';
import {
  STORED_EXECUTION_VALUE_LIMITS,
  StoredExecutionValueInvalidError,
} from '@pertexo/node-sdk';

/** The runner wire envelope is larger than the retained run-data envelope. */
export function retainCodeOutput(result: CodeResult): CodeResult {
  if (result.kind === 'failed') return result;
  try {
    prepareStoredExecutionValue({ kind: 'inline', value: result.output });
    return result;
  } catch (error: unknown) {
    if (!(error instanceof StoredExecutionValueInvalidError)) throw error;
    return {
      kind: 'failed',
      code: 'code.output_invalid',
      diagnostics: {
        ...result.diagnostics,
        error: {
          message: `Code output must fit the retained ${String(STORED_EXECUTION_VALUE_LIMITS.inlineBytes / 1024)} KB JSON limit and contain valid Unicode without NUL. Return less data or clean the text.`,
        },
      },
    };
  }
}
