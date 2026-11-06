type PublishedNode = Readonly<{
  id?: unknown;
  definition?: Readonly<{ key?: unknown; version?: unknown }>;
  connectionRefs?: Readonly<Record<string, unknown>>;
  structured?: Readonly<{ body?: Readonly<{ nodes?: unknown }> }>;
}>;

/** Whether the published node sends with this Slack bot-token connection. */
export function publishesSlackBinding(
  executable: unknown,
  nodeId: string,
  connectionId: string,
): boolean {
  const graph = (executable as { graph?: { nodes?: unknown } } | null)?.graph;
  const pending: unknown[] = [graph?.nodes];
  while (pending.length > 0) {
    const nodes = pending.pop();
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes as PublishedNode[]) {
      const matchesConnectionUse =
        node.id === nodeId &&
        node.definition?.key === 'slack.send_message' &&
        node.definition.version === 1 &&
        node.connectionRefs?.slack_bot_token === connectionId;
      if (matchesConnectionUse) return true;
      pending.push(node.structured?.body?.nodes);
    }
  }
  return false;
}
