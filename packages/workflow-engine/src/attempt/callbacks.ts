import {
  callbackWaitConfigSchema,
  type CallbackBindings,
} from '@pertexo/workflow-model';
import { inspectExpression } from '@pertexo/workflow-model/server';
import { findExecutableNodeContext } from '../compilation/graph.js';
import type { WorkflowExecutableNode } from '../compilation/foundation.js';
import { operationError } from '../operation-values.js';
import type { ExecuteNodeAttemptInput } from './contract.js';

export async function resolveAttemptCallbacks(
  input: ExecuteNodeAttemptInput,
  node: WorkflowExecutableNode,
): Promise<CallbackBindings | undefined> {
  const ids = new Set<string>();
  for (const source of Object.values(node.inputMappings)) {
    if (source.kind !== 'expression') continue;
    const checked = inspectExpression(source.expression);
    if (checked.kind === 'valid')
      for (const reference of checked.callbacks) ids.add(reference.nodeId);
  }
  if (ids.size === 0) return undefined;
  const runtime = input.runtime?.callbacks;
  if (runtime === undefined)
    operationError(
      'attempt_invalid',
      'Callback URLs are unavailable. Configure callback keys and use Test workflow or a real run; single-step previews do not issue them.',
    );
  const context = findExecutableNodeContext(
    input.executable.envelope.graph,
    node.id,
  );
  if (context === undefined)
    operationError('attempt_invalid', 'Callback scope is unavailable.');
  const targets = [...ids].sort().map((nodeId) => {
    const target = context.graph.nodes.find((entry) => entry.id === nodeId);
    if (target === undefined)
      operationError('attempt_invalid', 'Callback Wait is outside this scope.');
    const config = callbackWaitConfigSchema.parse(target.config);
    return {
      nodeId,
      timeoutSeconds: config.timeoutSeconds,
      authentication: config.authentication,
    };
  });
  return runtime.prepare({ targets, signal: input.signal });
}
