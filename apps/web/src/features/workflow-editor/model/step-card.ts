import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { PreviewRunSummary } from '@pertexo/contracts/schemas/node-testing';
import { describeRecurrence } from '@/features/catalog/presentation.public';
import { describeAmount } from './field-units';
import type { GraphLevel, WorkflowNode } from './graph-scopes';

// What a step card says about its step, from the step's own setup and its
// connections: which ports it draws (and where they lead), and a short
// summary for the type line. Nothing here is invented: a fact the draft
// doesn't hold isn't shown.

type Side = 'inputs' | 'outputs';

/** The port every Switch keeps for values no case matches. */
const DEFAULT_PORT = 'default';
/** Ports a branching step draws before its setup names any. */
const STARTER_PORTS = 2;

/**
 * The ports a card draws, in catalog order. Branching steps draw only the
 * ports their setup names (Switch cases, Parallel branches, the branches of
 * the Parallel a Merge joins), Switch's default, and any port already
 * connected; before the setup names any, the first few, so a new step can
 * still be wired. Other steps draw every port.
 */
export function shownPorts(
  node: WorkflowNode,
  definition: NodeDefinitionCatalogItem | undefined,
  level: GraphLevel,
  side: Side,
): readonly string[] {
  const ports =
    definition?.ports[side] ??
    (side === 'inputs' ? Object.keys(node.inputMappings) : []);
  if (definition === undefined || ports.length <= 2) return ports;
  const configured = configuredPorts(node, definition, level, side);
  if (configured === undefined) return ports;
  const connected = new Set(
    Object.keys(portLinks(node, level, side, noTitles)),
  );
  const named = ports.filter(
    (port) => configured.ids.has(port) || connected.has(port),
  );
  const branches = ports.filter((port) => port !== DEFAULT_PORT);
  const starters = named.some((port) => port !== DEFAULT_PORT)
    ? []
    : branches.slice(0, configured.minimum);
  return ports.filter(
    (port) =>
      named.includes(port) || starters.includes(port) || port === DEFAULT_PORT,
  );
}

const noTitles: ReadonlyMap<string, string> = new Map();

/**
 * Where each connected port of a step leads: for outputs, the steps it
 * runs next; for inputs, the steps that feed it. Titles come from `titles`.
 */
export function portLinks(
  node: Pick<WorkflowNode, 'id'>,
  level: GraphLevel,
  side: Side,
  titles: ReadonlyMap<string, string>,
): Readonly<Record<string, readonly string[]>> {
  const links: Record<string, string[]> = {};
  for (const edge of level.edges) {
    const [own, other] =
      side === 'outputs'
        ? [edge.source, edge.target]
        : [edge.target, edge.source];
    if (own.nodeId !== node.id) continue;
    (links[own.port] ??= []).push(titles.get(other.nodeId) ?? 'a step');
  }
  return links;
}

/**
 * A port as people read it: "Branch 2" for `branch-02`, "Case 1" for
 * `case-01`, "Otherwise" for a Switch's `default`; other ports as named.
 */
export function portName(port: string): string {
  const numbered = /^(branch|case)-0*(\d+)$/u.exec(port);
  if (numbered !== null)
    return `${numbered[1] === 'branch' ? 'Branch' : 'Case'} ${numbered[2] ?? ''}`;
  return port === 'default' ? 'Otherwise' : port;
}

/** "true → Ask finance", "Branch 2 ← Pull incidents", or just the port. */
export function portLinkLabel(
  port: string,
  side: Side,
  others: readonly string[] | undefined,
): string {
  const [first] = others ?? [];
  const name = portName(port);
  if (first === undefined) return name;
  const more =
    (others?.length ?? 0) > 1 ? ` +${String((others?.length ?? 1) - 1)}` : '';
  return `${name} ${side === 'outputs' ? '→' : '←'} ${first}${more}`;
}

type Configured = Readonly<{ ids: ReadonlySet<string>; minimum: number }>;

/** The ports a step's setup names, or undefined when it names none by design. */
function configuredPorts(
  node: WorkflowNode,
  definition: NodeDefinitionCatalogItem,
  level: GraphLevel,
  side: Side,
): Configured | undefined {
  const ports = definition.ports[side];
  const setting = portListSetting(definition.configSchema, ports);
  if (setting !== undefined)
    return {
      ids: namedIds(node.config[setting.key], ports),
      minimum: setting.minimum,
    };
  const paired = node.config.parallelNodeId;
  if (
    side !== 'inputs' ||
    !hasProperty(definition.configSchema, 'parallelNodeId')
  )
    return undefined;
  const parallel = level.nodes.find(
    (candidate) => typeof paired === 'string' && candidate.id === paired,
  );
  const ids = new Set<string>();
  for (const value of Object.values(parallel?.config ?? {}))
    for (const id of namedIds(value, ports)) ids.add(id);
  return { ids, minimum: STARTER_PORTS };
}

/**
 * The setup property that lists ports, like Switch `cases` or Parallel
 * `branches`: an array of objects whose `id` is one of the step's ports.
 */
function portListSetting(
  schema: unknown,
  ports: readonly string[],
): Readonly<{ key: string; minimum: number }> | undefined {
  const properties = recordAt(schema, 'properties');
  for (const [key, property] of Object.entries(properties ?? {})) {
    const ids = recordAt(
      recordAt(recordAt(property, 'items'), 'properties'),
      'id',
    );
    const choices = ids === undefined ? undefined : Reflect.get(ids, 'enum');
    if (
      Array.isArray(choices) &&
      choices.length > 0 &&
      choices.every(
        (choice) => typeof choice === 'string' && ports.includes(choice),
      )
    ) {
      const minimum = recordAt(properties, key)?.minItems;
      return {
        key,
        minimum: typeof minimum === 'number' ? minimum : STARTER_PORTS,
      };
    }
  }
  return undefined;
}

function namedIds(value: unknown, ports: readonly string[]): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(value)) return ids;
  for (const item of value) {
    const id: unknown = isRecord(item) ? item.id : undefined;
    if (typeof id === 'string' && ports.includes(id)) ids.add(id);
  }
  return ids;
}

function hasProperty(schema: unknown, key: string): boolean {
  return recordAt(recordAt(schema, 'properties'), key) !== undefined;
}

function recordAt(
  value: unknown,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  const found: unknown = value[key];
  return isRecord(found) ? found : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * A few words from the step's own setup for its card's type line, e.g.
 * "6 rules", "POST" or "Every day at 02:00"; undefined when there's
 * nothing set up to say.
 */
export function stepSummary(
  node: Pick<WorkflowNode, 'definition' | 'config' | 'inputMappings'>,
): string | undefined {
  const { config } = node;
  switch (node.definition.key) {
    case 'core.validate':
      return Array.isArray(config.rules) && config.rules.length > 0
        ? plural(config.rules.length, 'rule')
        : undefined;
    case 'http.request':
      return typeof config.method === 'string' ? config.method : undefined;
    case 'core.wait':
      return typeof config.durationSeconds === 'number' &&
        config.durationSeconds > 0
        ? describeAmount(config.durationSeconds, 'seconds')
        : undefined;
    case 'core.schedule':
      return scheduleWords(config);
    case 'core.set': {
      const count = Object.keys(node.inputMappings).length;
      return count > 0 ? plural(count, 'field') : undefined;
    }
    default:
      return undefined;
  }
}

function scheduleWords(config: WorkflowNode['config']): string | undefined {
  if (config.kind === 'cron' && typeof config.expression === 'string')
    return describeRecurrence({
      kind: 'cron',
      expression: config.expression,
      timezone: typeof config.timezone === 'string' ? config.timezone : 'UTC',
    });
  if (config.kind === 'interval' && typeof config.intervalMinutes === 'number')
    return describeRecurrence({
      kind: 'interval',
      intervalMinutes: config.intervalMinutes,
    });
  return undefined;
}

/**
 * The size of a passed test's output when it came back inline (as UTF-8
 * JSON); undefined for a file output, whose size the test doesn't report.
 */
export function inlineOutputBytes(
  output: PreviewRunSummary['output'],
): number | undefined {
  if (output?.kind !== 'inline') return undefined;
  return new TextEncoder().encode(JSON.stringify(output.value)).length;
}
