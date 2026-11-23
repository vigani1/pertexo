import {
  PlatformNodeDefinitionUnavailableError,
  resolvePlatformNodeDefinition,
} from '@pertexo/node-catalog';
import {
  agentMappedInputSchema,
  isAgentDefinition,
  isWorkflowTriggerDefinition,
} from '@pertexo/workflow-model';
import type {
  GraphValidationIssue,
  WorkflowGraph,
  WorkflowNode,
} from '@pertexo/workflow-model';
import type { z } from 'zod';

type StepDefinition = ReturnType<typeof resolvePlatformNodeDefinition>;
type Problem = z.core.$ZodIssue;

// The proposal service uses this marker internally. Issue responses omit it.
export const setupRequiresUser = Symbol('setupRequiresUser');
type FieldSchema = Readonly<{
  properties?: Readonly<Record<string, Readonly<{ title?: string }>>>;
}>;

// The engine hands Merge its settled branches, so nothing maps its input.
const ENGINE_SUPPLIES_INPUT = new Set(['core.merge']);

/**
 * A step that can't run is refused before publish, not at run time, using the
 * same schemas the step checks itself with. Only what is knowable now counts:
 * setup and literal values. A mapped input is judged when its value exists.
 */
export function stepSetupIssues(
  graph: WorkflowGraph,
): readonly GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const levels = [{ graph, path: '$' }];
  for (const level of levels)
    for (const node of level.graph.nodes) {
      // A disabled step, and any loop body inside it, never runs.
      if (node.disabled) continue;
      const path = `${level.path}.nodes.${node.id}`;
      if (node.structured !== undefined)
        levels.push({
          graph: node.structured.body,
          path: `${path}.structured.body`,
        });
      const definition = knownDefinition(node);
      if (definition === undefined) continue;
      issues.push(
        ...configAndConnectionIssues(node, definition, path),
        ...inputIssues(node, definition, path),
      );
    }
  return issues;
}

/** An unknown step has its own issue from the compatibility check. */
function knownDefinition(node: WorkflowNode): StepDefinition | undefined {
  try {
    return resolvePlatformNodeDefinition(node.definition);
  } catch (error) {
    if (error instanceof PlatformNodeDefinitionUnavailableError)
      return undefined;
    throw error;
  }
}

function configAndConnectionIssues(
  node: WorkflowNode,
  definition: StepDefinition,
  path: string,
): readonly GraphValidationIssue[] {
  const parsed = definition.configSchema.safeParse(node.config);
  if (parsed.success)
    return (definition.requiredConnectionsForConfig?.(parsed.data) ?? [])
      .filter((slot) => node.connectionRefs[slot] === undefined)
      .map((slot) =>
        issue(
          `${path}.connectionRefs.${slot}`,
          'Choose a connection for this step.',
          true,
        ),
      );
  return parsed.error.issues.map((problem) =>
    issue(
      problemPath(`${path}.config`, problem),
      describeProblem(problem, {
        given: node.config,
        schema: definition.manifest.configSchema,
        whole: 'This step’s setup isn’t finished.',
      }),
      missingValue(problem, node.config),
    ),
  );
}

function inputIssues(
  node: WorkflowNode,
  definition: StepDefinition,
  path: string,
): readonly GraphValidationIssue[] {
  if (
    isWorkflowTriggerDefinition(node.definition) ||
    ENGINE_SUPPLIES_INPUT.has(node.definition.key)
  )
    return [];
  const literals: Record<string, unknown> = {};
  const mapped = new Set<string>();
  for (const [key, source] of Object.entries(node.inputMappings))
    if (source.kind === 'literal') literals[key] = source.value;
    else mapped.add(key);
  const inputSchema = isAgentDefinition(node.definition)
    ? agentMappedInputSchema
    : definition.inputSchema;
  const parsed = inputSchema.safeParse(literals);
  if (parsed.success) return [];
  return parsed.error.issues.flatMap((problem) => {
    const [field] = problem.path;
    // A rule over the whole input can't be judged until mapped values exist.
    if (field === undefined ? mapped.size > 0 : mapped.has(String(field)))
      return [];
    return [
      issue(
        problemPath(`${path}.inputMappings`, problem),
        describeProblem(problem, {
          given: literals,
          schema: definition.manifest.inputSchema,
          whole: 'This step needs its inputs set.',
        }),
        missingValue(problem, literals),
      ),
    ];
  });
}

function issue(path: string, message: string, missing: boolean) {
  return {
    code: 'invalid_graph' as const,
    path,
    message,
    [setupRequiresUser]: missing,
  };
}

function missingValue(
  problem: Problem,
  given: Readonly<Record<string, unknown>>,
) {
  const [field] = problem.path;
  return field === undefined
    ? Object.keys(given).length === 0
    : given[String(field)] === undefined;
}

function problemPath(prefix: string, problem: Problem): string {
  return problem.path.reduce<string>(
    (current, segment) =>
      typeof segment === 'number'
        ? `${current}[${String(segment)}]`
        : `${current}.${String(segment)}`,
    prefix,
  );
}

function describeProblem(
  problem: Problem,
  {
    given,
    schema,
    whole,
  }: Readonly<{
    given: Readonly<Record<string, unknown>>;
    schema: FieldSchema;
    whole: string;
  }>,
): string {
  const [field] = problem.path;
  if (field === undefined) return whole;
  const name = String(field);
  const label = schema.properties?.[name]?.title ?? name;
  const wantsBoolean =
    problem.code === 'invalid_type' && problem.expected === 'boolean';
  if (wantsBoolean) return `${label} needs a true or false value.`;
  // A schema's words for a missing value are about types, not what to do.
  if (missingValue(problem, given)) return `${label} needs a value.`;
  return `${label}: ${problem.message}`;
}
