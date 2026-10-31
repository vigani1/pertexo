const manual = {
  id: 'manual',
  definition: { key: 'core.manual', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
};

export type HttpStep = Readonly<{
  id: string;
  method: 'GET' | 'POST';
  url: string;
}>;

function httpNode({ id, method, url }: HttpStep, index: number) {
  return {
    id,
    label: id,
    definition: { key: 'http.request', version: 1 },
    position: { x: (index + 1) * 10, y: 0 },
    configVersion: 1,
    config: {
      method,
      url,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
      timeoutMillis: 120_000,
      maxRedirects: 0,
      maxResponseBytes: 4_096,
      inlineResponseBytes: 4_096,
    },
    inputMappings:
      method === 'POST'
        ? { body: { kind: 'literal', value: { encoding: 'utf8', value: id } } }
        : {},
    connectionRefs: {},
  };
}

const inLine = (order: readonly { id: string }[]) =>
  order.slice(1).map((node, index) => ({
    id: `e${String(index)}`,
    source: { nodeId: order[index]?.id ?? '', port: 'out' },
    target: { nodeId: node.id, port: 'in' },
  }));

const triggerNode = (
  key: string,
  config: Readonly<Record<string, unknown>>,
) => ({
  ...manual,
  id: 'trigger',
  definition: { key, version: 1 },
  config,
});

/** The same line of HTTP steps, started by this trigger instead of by hand. */
export function triggeredChain(
  trigger: Readonly<{
    key: 'core.schedule' | 'core.webhook' | 'core.workflow_error';
    config?: Readonly<Record<string, unknown>>;
  }>,
  steps: readonly HttpStep[],
) {
  const order = [
    triggerNode(trigger.key, trigger.config ?? {}),
    ...steps.map(httpNode),
  ];
  return { settings: {}, nodes: order, edges: inLine(order) };
}

/** One Slack message through a real connection: the provider decides how it ends. */
export function slackMessage(connectionId: string, text: string) {
  const order = [
    manual,
    {
      id: 'slack',
      label: 'slack',
      definition: { key: 'slack.send_message', version: 1 },
      position: { x: 10, y: 0 },
      configVersion: 1,
      config: { timeoutMillis: 5_000 },
      inputMappings: {
        channelId: { kind: 'literal', value: 'C123ABC' },
        text: { kind: 'literal', value: text },
      },
      connectionRefs: { slack_bot_token: connectionId },
    },
  ];
  return { settings: {}, nodes: order, edges: inLine(order) };
}

/** A published graph of HTTP steps in a line, the workflow a beta user builds. */
export function httpChain(
  steps: readonly HttpStep[],
  settings: Readonly<{ maxRunDurationMs?: number }> = {},
) {
  const nodes = steps.map(httpNode);
  const order = [manual, ...nodes];
  return {
    settings,
    nodes: order,
    edges: nodes.map((node, index) => ({
      id: `e${String(index)}`,
      source: { nodeId: order[index]?.id ?? 'manual', port: 'out' },
      target: { nodeId: node.id, port: 'in' },
    })),
  };
}
