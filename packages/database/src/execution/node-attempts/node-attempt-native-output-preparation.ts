import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  NodeAttemptOutputInvalidError,
  type completionSchema,
} from './node-attempt-run-store-contract.js';
import { parseWorkflowExecutionValueSnapshot } from './node-attempt-call-input-record.js';
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionJsonValue,
  serializeWorkflowExecutionJsonValueV3,
} from '../stored-execution-value.js';

/** Independent local producer-byte reconciliation before the write transaction.
 * Metadata alone is not accepted provenance, a semantic attestation or SQL authority.
 */
export function prepareNativeAttemptCompletionOutput(
  input: z.output<typeof completionSchema>,
) {
  const prepared = input.nativeOutput;
  if (prepared === undefined) return undefined;
  if (
    input.outcome.status !== 'succeeded' &&
    input.outcome.status !== 'suspended'
  )
    throw new NodeAttemptOutputInvalidError();
  try {
    const original = serializeWorkflowExecutionJsonValueV3(
      input.outcome.output,
    );
    if (
      Buffer.byteLength(original, 'utf8') !== prepared.byteLength ||
      createHash('sha256').update(original).digest('hex') !== prepared.sha256
    )
      throw new NodeAttemptOutputInvalidError();
    const reference = parseStoredExecutionValueV1(prepared.reference);
    const snapshot = parseWorkflowExecutionValueSnapshot({
      reference,
      sha256: prepared.sha256,
      byteLength: prepared.byteLength,
      ...(reference.kind === 'inline' ? { serializedValue: original } : {}),
    });
    return Object.freeze({
      snapshot,
      serializedReference: serializeStoredExecutionJsonValue(reference),
    });
  } catch {
    throw new NodeAttemptOutputInvalidError();
  }
}
