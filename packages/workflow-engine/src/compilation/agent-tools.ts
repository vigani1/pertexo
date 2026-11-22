import type { DataTableConfig, NodeCatalog } from '@pertexo/node-sdk';
import {
  AGENT_LIMITS,
  AGENT_SLACK_CONNECTION_SLOT,
  agentConfigSchema,
  isAgentDefinition,
} from '@pertexo/workflow-model';
import { compareIdentity } from './definition-identity.js';
import { sideEffectClass } from './executable.validation.js';
import { fail } from './executable.errors.js';
import { definitionManifest, executorManifest } from './graph-rules.js';
import type { WorkflowExecutableNode } from './workflow-executable.js';

/** Resolve only the manifest version and fixed setup named in the executable. */
export function pinAgentTool(
  node: WorkflowExecutableNode,
  catalog: NodeCatalog,
) {
  if (!isAgentDefinition(node.definition)) return undefined;
  const parsed = agentConfigSchema.safeParse(node.config);
  if (!parsed.success) fail('Agent tool settings are invalid');
  const {
    tool,
    model,
    timeoutMillis = AGENT_LIMITS.timeoutMillis,
  } = parsed.data;
  const manifest = definitionManifest(catalog, tool.definition);
  const policy = manifest.agentTool;
  const slack = 'channelId' in tool.config ? tool.config : undefined;
  const {
    [AGENT_SLACK_CONNECTION_SLOT]: slackConnectionId,
    ...modelConnections
  } = node.connectionRefs;
  if ((slack === undefined) !== (slackConnectionId === undefined))
    fail('Select a Slack connection for the Agent Slack tool.');
  const connectionRefs =
    slackConnectionId === undefined
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
    alias: tool.alias,
    model,
    timeoutMillis,
    approval:
      writePermission?.kind === 'approval' ? writePermission.config : undefined,
    policy,
    inputSchema: manifest.inputSchema,
    modelConnections: Object.freeze(modelConnections),
    fixedInput: Object.freeze(
      slack === undefined ? {} : { channelId: slack.channelId },
    ),
    node: Object.freeze({
      id: node.id,
      definition: manifest.definition,
      configVersion: manifest.configVersion,
      config: Object.freeze(
        'table' in tool.config
          ? pinTableSetup(tool.config)
          : { timeoutMillis: tool.config.timeoutMillis },
      ),
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

function pinTableSetup({ table, columnBindings }: DataTableConfig) {
  return {
    table,
    ...(columnBindings === undefined
      ? {}
      : { columnBindings: Object.freeze(columnBindings) }),
  };
}
