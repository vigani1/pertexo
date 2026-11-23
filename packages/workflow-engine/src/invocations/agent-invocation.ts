import { createHash } from 'node:crypto';
import { invocationKey } from './invocation-identity.js';

export type AgentChild = Readonly<{
  turn: number;
  work:
    | Readonly<{ kind: 'model_turn' }>
    | Readonly<{ kind: 'tool_call'; ordinal: number }>;
}>;

export type AgentWorkIdentity = AgentChild &
  Readonly<{ parentInvocationKey: string }>;

const agentNodePrefix = '\u0000agent:';
function agentChildNodePrefix(parentInvocationKey: string): string {
  const parent = createHash('sha256').update(parentInvocationKey).digest('hex');
  return `${agentNodePrefix}${parent}:`;
}

export function isAgentChildOf(
  key: string,
  workflowVersionId: string,
  parentInvocationKey: string,
): boolean {
  const prefix = [
    encodeURIComponent(workflowVersionId),
    encodeURIComponent(agentChildNodePrefix(parentInvocationKey)),
  ].join('|');
  return key.startsWith(prefix);
}

const modelTurn = 'model';

export function isAgentWorkInvocationKey(key: string): boolean {
  const [, nodeComponent] = key.split('|');
  return (
    nodeComponent?.startsWith(encodeURIComponent(agentNodePrefix)) === true
  );
}

export function isAgentModelTurnInvocationKey(key: string): boolean {
  return (
    isAgentWorkInvocationKey(key) &&
    key.split('|')[1]?.endsWith(encodeURIComponent(`:${modelTurn}`)) === true
  );
}

/** A NUL in the encoded node component cannot originate in a graph node ID. */
export function agentChildInvocationKey(
  workflowVersionId: string,
  parentInvocationKey: string,
  child: AgentChild,
): string {
  const work =
    child.work.kind === 'model_turn'
      ? modelTurn
      : `tool:${String(child.work.ordinal)}`;
  return invocationKey({
    workflowVersionId,
    nodeId: `${agentChildNodePrefix(parentInvocationKey)}${String(child.turn)}:${work}`,
  });
}
