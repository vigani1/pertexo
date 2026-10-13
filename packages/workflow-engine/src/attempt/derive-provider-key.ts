import type { WorkflowExecutableNode } from '../compilation/foundation.js';
import { providerIdempotencyKey } from './retries.js';

export function nodeProviderIdempotencyKey(
  node: WorkflowExecutableNode | undefined,
  runId: string,
  invocationKey: string,
): string | undefined {
  if (node?.sideEffectClass !== 'idempotent_with_key') return undefined;
  return providerIdempotencyKey({
    invocationKey,
    namespace: 'pertexo.node-attempt',
    operationIdentity: `${node.definition.key}@${String(node.definition.version)}`,
    runId,
  });
}
