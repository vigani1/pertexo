import { UUID_PATTERN } from '@pertexo/workflow-model';
import { resolvePlatformNodeDefinition } from '@pertexo/node-catalog';
import {
  canonicalizeJson,
  type JsonValue,
  resolveValueSource,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model';
import type { ExpressionEvaluator } from '@pertexo/workflow-model/server';

export type NodeValidationIssue = Readonly<{
  path: string;
  code: string;
  message: string;
}>;

type NodeSideEffectDisclosure = Readonly<{
  sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe';
  mayContactProvider: boolean;
  mayCauseExternalSideEffect: boolean;
  dryRun: 'not_supported' | 'provider_supported';
}>;

export type PreparedNodePreview = Readonly<{
  definition: Readonly<{ key: string; version: number }>;
  disclosure: NodeSideEffectDisclosure;
  executableNode: Readonly<Record<string, JsonValue>>;
  executor: Readonly<{ key: string; version: number }>;
  integration?: Readonly<{ providerKey: string; operationKey: string }>;
  issues: readonly NodeValidationIssue[];
  resolvedInput: JsonValue;
}>;

const MAX_ISSUES = 100;
const MAX_ISSUE_PATH_LENGTH = 1_024;
const MAX_ISSUE_CODE_LENGTH = 128;
const MAX_ISSUE_MESSAGE_LENGTH = 500;

function issue(
  issues: NodeValidationIssue[],
  value: NodeValidationIssue,
): void {
  if (issues.length < MAX_ISSUES)
    issues.push(
      Object.freeze({
        path: value.path.slice(0, MAX_ISSUE_PATH_LENGTH),
        code: value.code.slice(0, MAX_ISSUE_CODE_LENGTH),
        message: value.message.slice(0, MAX_ISSUE_MESSAGE_LENGTH),
      }),
    );
}

function zodPath(prefix: string, path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (current, segment) =>
      typeof segment === 'number'
        ? `${current}[${String(segment)}]`
        : `${current}.${String(segment)}`,
    prefix,
  );
}

function disclosure(
  retryClass: 'safe' | 'idempotent-with-key' | 'unsafe',
  integration: unknown,
  capabilities: readonly string[],
): NodeSideEffectDisclosure {
  return Object.freeze({
    sideEffectClass:
      retryClass === 'idempotent-with-key' ? 'idempotent_with_key' : retryClass,
    mayContactProvider: integration !== undefined,
    mayCauseExternalSideEffect: retryClass !== 'safe',
    dryRun: capabilities.includes('provider_dry_run')
      ? 'provider_supported'
      : 'not_supported',
  });
}

function findNode(graph: WorkflowGraph, nodeId: string): WorkflowNode | null {
  const stack: WorkflowGraph[] = [graph];
  let found: WorkflowNode | null = null;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const node of current.nodes) {
      if (node.id === nodeId) {
        if (found !== null) return null;
        found = node;
      }
      if (node.structured !== undefined) stack.push(node.structured.body);
    }
  }
  return found;
}

export async function prepareNodeValidation(
  input: Readonly<{
    graph: WorkflowGraph;
    nodeId: string;
    sampleInput?: JsonValue;
    deferInput?: boolean;
    expressionEvaluator?: ExpressionEvaluator;
  }>,
): Promise<
  PreparedNodePreview | Readonly<{ issues: readonly NodeValidationIssue[] }>
> {
  const issues: NodeValidationIssue[] = [];
  const node = findNode(input.graph, input.nodeId);
  if (node === null) {
    issue(issues, {
      path: '$.nodeId',
      code: 'node.not_found_or_ambiguous',
      message: 'Selected node does not identify exactly one draft node',
    });
    return Object.freeze({ issues: Object.freeze(issues) });
  }

  let definition;
  try {
    definition = resolvePlatformNodeDefinition(node.definition);
  } catch {
    issue(issues, {
      path: '$.definition',
      code: 'node.definition_unavailable',
      message: 'Selected node definition is unavailable',
    });
    return Object.freeze({ issues: Object.freeze(issues) });
  }

  if (node.configVersion !== definition.manifest.configVersion)
    issue(issues, {
      path: '$.configVersion',
      code: 'node.config_version_incompatible',
      message: 'Selected node configuration version is incompatible',
    });

  const parsedConfig = definition.configSchema.safeParse(node.config);
  if (!parsedConfig.success)
    for (const problem of parsedConfig.error.issues)
      issue(issues, {
        path: zodPath('$.config', problem.path),
        code: 'node.config_invalid',
        message: problem.message,
      });

  const requiredSlots = new Set(definition.manifest.connectionRequirements);
  for (const slot of [...requiredSlots].sort()) {
    const reference = node.connectionRefs[slot];
    if (reference === undefined || !UUID_PATTERN.test(reference))
      issue(issues, {
        path: `$.connectionRefs.${slot}`,
        code: 'node.connection_required',
        message: 'Required connection reference is missing or invalid',
      });
  }
  for (const slot of Object.keys(node.connectionRefs).sort())
    if (!requiredSlots.has(slot))
      issue(issues, {
        path: `$.connectionRefs.${slot}`,
        code: 'node.connection_unexpected',
        message: 'Connection reference is not declared by this definition',
      });

  const mapped: Record<string, JsonValue> = {};
  if (input.deferInput !== true) {
    const runInput = canonicalizeJson(input.sampleInput ?? {});
    for (const key of Object.keys(node.inputMappings).sort()) {
      const source = node.inputMappings[key];
      if (source === undefined) continue;
      const resolution = await resolveValueSource(
        source,
        { runInput, nodeOutputs: {} },
        input.expressionEvaluator,
      );
      if (resolution.kind === 'value') mapped[key] = resolution.value;
      else
        issue(issues, {
          path: `$.inputMappings.${key}`,
          code:
            resolution.kind === 'missing'
              ? 'node.mapping_missing'
              : 'node.mapping_invalid',
          message:
            resolution.kind === 'error'
              ? resolution.message
              : 'Sample input does not resolve this mapping',
        });
    }
  }
  const resolvedInput = canonicalizeJson(mapped);
  if (input.deferInput !== true) {
    const parsedInput = definition.inputSchema.safeParse(resolvedInput);
    if (!parsedInput.success)
      for (const problem of parsedInput.error.issues)
        issue(issues, {
          path: zodPath('$.resolvedInput', problem.path),
          code: 'node.input_invalid',
          message: problem.message,
        });
  }

  return Object.freeze({
    definition: Object.freeze({ ...definition.manifest.definition }),
    disclosure: disclosure(
      definition.manifest.retryClass,
      definition.manifest.integration,
      definition.manifest.capabilities,
    ),
    executableNode: Object.freeze(
      canonicalizeJson({
        id: node.id,
        definition: node.definition,
        configVersion: node.configVersion,
        config: node.config,
        inputMappings: node.inputMappings,
        connectionRefs: node.connectionRefs,
      }) as Readonly<Record<string, JsonValue>>,
    ),
    executor: Object.freeze({ ...definition.manifest.executor }),
    ...(definition.manifest.integration === undefined
      ? {}
      : { integration: Object.freeze({ ...definition.manifest.integration }) }),
    issues: Object.freeze(issues),
    resolvedInput,
  });
}
