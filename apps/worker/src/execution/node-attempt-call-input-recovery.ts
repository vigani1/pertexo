import { createHash } from 'node:crypto';
import {
  serializeWorkflowExecutionJsonValueV3,
  type NodeAttemptLease,
  type NodeAttemptRunStore,
} from '@pertexo/database/execution';
import type { createWorkflowExecutionValueCodec } from './workflow-execution-value-codec.js';

/** Reuse committed creation provenance under independently authenticated recovery. */
export async function recoverNodeAttemptCallInput(
  input: Readonly<{
    lease: NodeAttemptLease;
    signal: AbortSignal;
    runStore: Pick<NodeAttemptRunStore, 'readCallDeclarationInput'>;
    values?: Pick<
      ReturnType<typeof createWorkflowExecutionValueCodec>,
      'hydrate'
    >;
  }>,
): Promise<Readonly<{ value: unknown }> | undefined> {
  const read = input.runStore.readCallDeclarationInput?.bind(input.runStore);
  const hydrate = input.values?.hydrate;
  if (read === undefined || hydrate === undefined)
    throw new TypeError('Native Call snapshot recovery is unavailable');
  const snapshot = await read({ lease: input.lease, signal: input.signal });
  if (snapshot === undefined) return undefined;
  const value = await hydrate({
    owner: { kind: 'attempt', lease: input.lease },
    reference: snapshot.reference,
    signal: input.signal,
  });
  const integrityBytes =
    snapshot.reference.kind === 'inline'
      ? snapshot.serializedValue
      : serializeWorkflowExecutionJsonValueV3(value);
  if (integrityBytes === undefined)
    throw new TypeError('Recovered Call inline bytes are missing');
  if (
    Buffer.byteLength(integrityBytes, 'utf8') !== snapshot.byteLength ||
    createHash('sha256').update(integrityBytes).digest('hex') !==
      snapshot.sha256 ||
    (snapshot.reference.kind === 'inline' &&
      serializeWorkflowExecutionJsonValueV3(
        JSON.parse(integrityBytes) as unknown,
      ) !== serializeWorkflowExecutionJsonValueV3(value))
  )
    throw new TypeError('Recovered Call snapshot metadata does not match');
  return { value };
}
