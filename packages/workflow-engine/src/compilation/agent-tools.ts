import type {
  NodeManifest,
  DataTableFindConfig,
  NodeCatalog,
} from '@pertexo/node-sdk';
import {
  AGENT_LIMITS,
  AGENT_STEP_V3,
  type AgentToolConfig,
  AGENT_SLACK_CONNECTION_SLOT,
  readAgentConfig,
  callableObjectInputSchema,
  isAgentDefinition,
} from '@pertexo/workflow-model';
import { compareIdentity } from './definition-identity.js';
import { sideEffectClass } from './executable.validation.js';
import { fail } from './executable.errors.js';
import { definitionManifest, executorManifest } from './graph-rules.js';
import type { WorkflowExecutableNode } from './workflow-executable.js';

/** Resolve only the manifest version and fixed setup named in the executable. */
export function pinAgentTools(
  node: WorkflowExecutableNode,
  catalog: NodeCatalog,
) {
  if (!isAgentDefinition(node.definition)) return [];
  const settings = readAgentConfig(node);
  if (settings === undefined) fail('Agent tool settings are invalid');
  const slack = settings.tools.some(({ config }) => 'channelId' in config);
  if (slack !== Object.hasOwn(node.connectionRefs, AGENT_SLACK_CONNECTION_SLOT))
    fail('Select a Slack connection for the Agent Slack tool.');
  return settings.tools.map((tool) =>
    pinAgentTool(node, catalog, tool, settings),
  );
}

function pinAgentTool(
  node: WorkflowExecutableNode,
  catalog: NodeCatalog,
  tool: AgentToolConfig,
  {
    model,
    timeoutMillis = AGENT_LIMITS.timeoutMillis,
  }: Pick<
    NonNullable<ReturnType<typeof readAgentConfig>>,
    'model' | 'timeoutMillis'
  >,
) {
  const manifest = definitionManifest(catalog, tool.definition);
  const callable = 'target' in tool.config ? tool.config : undefined;
  const { callableSchema, policy } = toolPolicy(callable, manifest.agentTool);
  const slack = 'channelId' in tool.config ? tool.config : undefined;
  const {
    [AGENT_SLACK_CONNECTION_SLOT]: slackConnectionId,
    ...modelConnections
  } = node.connectionRefs;
  const connectionRefs =
    slack === undefined || slackConnectionId === undefined
      ? {}
      : { [AGENT_SLACK_CONNECTION_SLOT]: slackConnectionId };
  const writePermission =
    'writePermission' in tool ? tool.writePermission : undefined;
  if (
    policy === undefined ||
    (policy.effect === 'write') !== (writePermission !== undefined) ||
    (policy.effect === 'read' && manifest.retryClass !== 'safe') ||
    manifest.connectionRequirements.some(
      (slot) => !Object.hasOwn(connectionRefs, slot),
    )
  )
    fail('Agent tool must have a supported effect policy and setup');
  const executor = executorManifest(catalog, manifest.executor);
  return Object.freeze({
    agentDefinition: node.definition,
    alias: tool.alias,
    description: tool.description,
    model,
    timeoutMillis,
    approval:
      writePermission?.kind === 'approval' ? writePermission.config : undefined,
    policy,
    inputSchema: callableSchema ?? manifest.inputSchema,
    callable,
    modelConnections: Object.freeze(modelConnections),
    fixedInput: Object.freeze(
      slack === undefined ? {} : { channelId: slack.channelId },
    ),
    node: Object.freeze({
      id: node.id,
      definition: manifest.definition,
      configVersion: manifest.configVersion,
      config: Object.freeze(attemptConfig(tool.config)),
      inputMappings: {},
      connectionRefs: Object.freeze(connectionRefs),
      disabled: false,
      sideEffectClass: sideEffectClass(manifest.retryClass),
      executor: manifest.executor,
      executorAbi: executor.abiVersion,
      policyReferences: Object.freeze(
        [...manifest.policyReferences].sort(compareIdentity),
      ),
    }) satisfies WorkflowExecutableNode,
  });
}

function toolPolicy(
  callable: Extract<AgentToolConfig['config'], { target: unknown }> | undefined,
  manifestPolicy: NodeManifest['agentTool'],
) {
  const callableSchema =
    callable === undefined
      ? undefined
      : callableObjectInputSchema(callable.input);
  if (callable !== undefined && callableSchema === undefined)
    fail('Agent Call tools require a bounded object input contract');
  const policy =
    callableSchema === undefined
      ? manifestPolicy
      : {
          effect: 'write' as const,
          inputFields: Object.keys(callableSchema.properties),
          result: { kind: 'bounded_output' as const },
        };
  return { callableSchema, policy };
}

function attemptConfig(
  config: AgentToolConfig['config'],
): WorkflowExecutableNode['config'] {
  if ('table' in config) return pinTableSetup(config);
  if ('target' in config) return { target: { ...config.target } };
  return { timeoutMillis: config.timeoutMillis };
}

function pinTableSetup({
  table,
  tableId,
  columnBindings,
}: DataTableFindConfig) {
  return {
    table,
    ...(tableId === undefined ? {} : { tableId }),
    ...(columnBindings === undefined
      ? {}
      : { columnBindings: Object.freeze(columnBindings) }),
  };
}

export function agentToolForAlias(
  tools: readonly ReturnType<typeof pinAgentTool>[],
  alias: string | undefined,
) {
  if (alias !== undefined) return tools.find((tool) => tool.alias === alias);
  const first = tools[0];
  return first?.agentDefinition.version === AGENT_STEP_V3.version
    ? undefined
    : first;
}
