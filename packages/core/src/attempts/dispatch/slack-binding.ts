import {
  AGENT_SEND_SLACK_MESSAGE,
  AGENT_SLACK_CONNECTION_SLOT,
  agentConfigSchema,
  isAgentDefinition,
} from '@pertexo/workflow-model';
import {
  isAgentModelTurnInvocationKey,
  isAgentWorkInvocationKey,
} from '@pertexo/workflow-engine/server';

type PublishedNode = Readonly<{
  id?: unknown;
  definition?: Readonly<{ key?: unknown; version?: unknown }>;
  config?: unknown;
  connectionRefs?: Readonly<Record<string, unknown>>;
  structured?: Readonly<{ body?: Readonly<{ nodes?: unknown }> }>;
}>;

/** Whether the published node sends with this Slack bot-token connection. */
export function publishesSlackBinding(
  executable: unknown,
  nodeId: string,
  connectionId: string,
  invocationKey: string,
): boolean {
  const graph = (executable as { graph?: { nodes?: unknown } } | null)?.graph;
  const pending: unknown[] = [graph?.nodes];
  while (pending.length > 0) {
    const nodes = pending.pop();
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes as PublishedNode[]) {
      const matchesConnectionUse =
        node.id === nodeId &&
        node.connectionRefs?.[AGENT_SLACK_CONNECTION_SLOT] === connectionId &&
        sendsSlack(node, invocationKey);
      if (matchesConnectionUse) return true;
      pending.push(node.structured?.body?.nodes);
    }
  }
  return false;
}

function sendsSlack(node: PublishedNode, invocationKey: string): boolean {
  const { definition } = node;
  if (
    definition?.key === AGENT_SEND_SLACK_MESSAGE.key &&
    definition.version === AGENT_SEND_SLACK_MESSAGE.version
  )
    return true;
  if (
    typeof definition?.key !== 'string' ||
    typeof definition.version !== 'number' ||
    !isAgentDefinition({ key: definition.key, version: definition.version }) ||
    !isAgentWorkInvocationKey(invocationKey) ||
    isAgentModelTurnInvocationKey(invocationKey)
  )
    return false;
  const config = agentConfigSchema.safeParse(node.config);
  return (
    config.success &&
    config.data.tool.definition.key === AGENT_SEND_SLACK_MESSAGE.key
  );
}
