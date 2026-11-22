import { createHash } from 'node:crypto';
import { invocationKey } from './invocation-identity.js';

export type AgentChild = Readonly<{
  turn: number;
  work:
    | Readonly<{ kind: 'model_turn' }>
    | Readonly<{ kind: 'tool_call'; ordinal: number }>;
}>;

/** A NUL in the encoded node component cannot originate in a graph node ID. */
export function agentChildInvocationKey(
  workflowVersionId: string,
  parentInvocationKey: string,
  child: AgentChild,
): string {
  const parent = createHash('sha256').update(parentInvocationKey).digest('hex');
  const work =
    child.work.kind === 'model_turn'
      ? 'model'
      : `tool:${String(child.work.ordinal)}`;
  return invocationKey({
    workflowVersionId,
    nodeId: `\u0000agent:${parent}:${String(child.turn)}:${work}`,
  });
}
