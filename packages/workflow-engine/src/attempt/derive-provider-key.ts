import type { WorkflowExecutableNode } from '../compilation/foundation.js';
import type { SideEffectClass } from '../types.js';
import { providerIdempotencyKey } from './retries.js';

export function nodeProviderIdempotencyKey(
  node: WorkflowExecutableNode | undefined,
  runId: string,
  invocationKey: string,
  sideEffectClass: SideEffectClass | undefined = node?.sideEffectClass,
): string | undefined {
  if (node === undefined || sideEffectClass !== 'idempotent_with_key')
    return undefined;
  return providerIdempotencyKey({
    invocationKey,
    namespace: 'pertexo.node-attempt',
    operationIdentity: `${node.definition.key}@${String(node.definition.version)}`,
    runId,
  });
}
