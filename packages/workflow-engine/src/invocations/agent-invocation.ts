import { createHash } from 'node:crypto';
import { invocationKey } from './invocation-identity.js';

export type AgentChild = Readonly<{
  turn: number;
  toolAlias?: string;
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

function agentNodeComponent(key: string): string | undefined {
  const [, component] = key.split('|');
  return component?.startsWith(encodeURIComponent(agentNodePrefix)) === true
    ? component
    : undefined;
}

export function isAgentWorkInvocationKey(key: string): boolean {
  return agentNodeComponent(key) !== undefined;
}

export function isAgentModelTurnInvocationKey(key: string): boolean {
  const parts = agentNodeComponent(key)?.split(encodeURIComponent(':'));
  return parts?.length === 4 && parts[3] === modelTurn;
}

export function agentToolAliasFromInvocationKey(
  key: string,
): string | undefined {
  const parts = agentNodeComponent(key)?.split(encodeURIComponent(':'));
  return parts?.length === 6 && parts[3] === 'tool' ? parts[5] : undefined;
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
      : `tool:${String(child.work.ordinal)}${child.toolAlias === undefined ? '' : `:${child.toolAlias}`}`;
  return invocationKey({
    workflowVersionId,
    nodeId: `${agentChildNodePrefix(parentInvocationKey)}${String(child.turn)}:${work}`,
  });
}
