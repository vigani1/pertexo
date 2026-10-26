import {
  createNodeCatalog,
  type NodeManifest,
  type PolicyReference,
  type NodeCatalog,
} from '@pertexo/node-sdk';

export const boundedPolicy = { key: 'node.json.bounded', version: 1 } as const;

export const jsonataPolicy = { key: 'jsonata.restricted', version: 1 } as const;

export const schema = { type: 'object', additionalProperties: true } as const;

type FixtureDefinitionKey =
  | 'core.request_input'
  | 'core.approval'
  | 'core.call'
  | 'core.condition'
  | 'core.foreach'
  | 'core.manual'
  | 'core.merge'
  | 'core.parallel'
  | 'core.schedule'
  | 'core.set'
  | 'core.switch'
  | 'core.terminate'
  | 'core.webhook'
  | 'core.wait'
  | 'test.unrelated';

const branchPorts = Array.from(
  { length: 16 },
  (_, index) => `branch-${String(index + 1).padStart(2, '0')}`,
);

const switchPorts = [
  ...Array.from(
    { length: 16 },
    (_, index) => `case-${String(index + 1).padStart(2, '0')}`,
  ),
  'default',
];

const fixtureDefinitions: Readonly<
  Record<
    FixtureDefinitionKey,
    Readonly<{
      capabilities: readonly string[];
      family: NodeManifest['family'];
      inputs: readonly string[];
      outputs: readonly string[];
    }>
  >
> = {
  'core.request_input': {
    capabilities: ['suspends_run'],
    family: 'logic',
    inputs: ['in'],
    outputs: ['out', 'timed_out'],
  },
  'core.approval': {
    capabilities: ['suspends_run'],
    family: 'logic',
    inputs: ['in'],
    outputs: ['approved', 'rejected', 'timed_out'],
  },
  'core.call': {
    capabilities: [],
    family: 'logic',
    inputs: ['in'],
    outputs: ['out'],
  },
  'core.condition': {
    capabilities: [],
    family: 'logic',
    inputs: ['in'],
    outputs: ['true', 'false'],
  },
  'core.foreach': {
    capabilities: [],
    family: 'logic',
    inputs: ['in'],
    outputs: ['out'],
  },
  'core.manual': {
    capabilities: [],
    family: 'trigger',
    inputs: [],
    outputs: ['out'],
  },
  'core.merge': {
    capabilities: [],
    family: 'logic',
    inputs: branchPorts,
    outputs: ['out'],
  },
  'core.parallel': {
    capabilities: [],
    family: 'logic',
    inputs: ['in'],
    outputs: branchPorts,
  },
  'core.schedule': {
    capabilities: [],
    family: 'trigger',
    inputs: [],
    outputs: ['out'],
  },
  'core.set': {
    capabilities: [],
    family: 'transform',
    inputs: ['in'],
    outputs: ['out'],
  },
  'core.switch': {
    capabilities: [],
    family: 'logic',
    inputs: ['in'],
    outputs: switchPorts,
  },
  'core.terminate': {
    capabilities: ['terminates_run'],
    family: 'output',
    inputs: ['in'],
    outputs: [],
  },
  'core.wait': {
    capabilities: ['suspends_run'],
    family: 'logic',
    inputs: ['in'],
    outputs: ['out'],
  },
  'core.webhook': {
    capabilities: [],
    family: 'trigger',
    inputs: [],
    outputs: ['out'],
  },
  'test.unrelated': {
    capabilities: [],
    family: 'transform',
    inputs: ['in'],
    outputs: ['out'],
  },
};

export function manifest(
  key: FixtureDefinitionKey,
  policies: readonly PolicyReference[] = [boundedPolicy],
): NodeManifest {
  const fixture = fixtureDefinitions[key];
  return {
    definition: { key, version: 1 },
    family: fixture.family,
    configVersion: 1,
    configSchema: schema,
    inputSchema: schema,
    outputSchema: schema,
    ports: {
      inputs: fixture.inputs,
      outputs: fixture.outputs,
    },
    credentialRequirements: [],
    connectionRequirements: [],
    retryClass: 'safe',
    resourceClass: 'cpu',
    capabilities: fixture.capabilities,
    executor: { key, version: 1 },
    executorAbi: 1,
    policyReferences: policies,
  };
}

export function nodeCatalog(input?: {
  readonly mutateSet?: boolean;
  readonly unrelated?: boolean;
  readonly driftCapability?: boolean;
  readonly manualRetryClass?: NodeManifest['retryClass'];
  readonly setRetryClass?: NodeManifest['retryClass'];
  readonly condition?: boolean;
  readonly switch?: boolean;
  readonly parallel?: boolean;
  readonly merge?: boolean;
  readonly forEach?: boolean;
  readonly call?: boolean;
  readonly approval?: boolean;
  readonly inputRequest?: boolean;
  readonly schedule?: boolean;
  readonly webhook?: boolean;
  readonly wait?: boolean;
  readonly extraPolicyVersion?: number;
}): NodeCatalog {
  const definitions = [
    manifest('core.manual'),
    manifest(
      'core.set',
      input?.mutateSet ? [jsonataPolicy] : [boundedPolicy, jsonataPolicy],
    ),
    manifest('core.terminate'),
    ...optionalDefinitions(input),
  ];
  const manual = definitions.find(
    ({ definition }) => definition.key === 'core.manual',
  );
  const set = definitions.find(
    ({ definition }) => definition.key === 'core.set',
  );
  if (manual !== undefined && input?.manualRetryClass !== undefined)
    Object.assign(manual, { retryClass: input.manualRetryClass });
  if (set !== undefined && input?.setRetryClass !== undefined)
    Object.assign(set, { retryClass: input.setRetryClass });
  if (input?.driftCapability) {
    if (set !== undefined) Object.assign(set, { capabilities: ['drifted'] });
  }
  return createNodeCatalog({
    definitions,
    executors: definitions.map((definition) => ({
      executor: definition.executor,
      abiVersion: 1,
      definitions: [definition.definition],
      policyReferences: definition.policyReferences,
    })),
    policies: [
      boundedPolicy,
      jsonataPolicy,
      ...(input?.extraPolicyVersion === undefined
        ? []
        : [{ key: 'test.rollout', version: input.extraPolicyVersion }]),
    ],
  });
}

function optionalDefinitions(
  input: Parameters<typeof nodeCatalog>[0],
): readonly NodeManifest[] {
  const choices = [
    ['schedule', 'core.schedule'],
    ['webhook', 'core.webhook'],
    ['wait', 'core.wait'],
    ['condition', 'core.condition'],
    ['switch', 'core.switch'],
    ['parallel', 'core.parallel'],
    ['merge', 'core.merge'],
    ['call', 'core.call'],
    ['approval', 'core.approval'],
    ['inputRequest', 'core.request_input'],
    ['forEach', 'core.foreach'],
    ['unrelated', 'test.unrelated'],
  ] as const;
  return choices.flatMap(([option, key]) =>
    input?.[option] ? [manifest(key)] : [],
  );
}
