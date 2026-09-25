import { stepTitle } from './graph-adapter';
import { levelSinks } from './graph-order';
import {
  indexGraph,
  isForEach,
  loopOf,
  sameScope,
  walkLevels,
  type GraphLevel,
  type ScopePath,
} from './graph-scopes';

// ADR 020's rules for a For each body, checked in the browser so people see
// them while building: the body has steps, stays apart from the steps
// around it, ends in one step (its output is each item's result) and every
// step is on the way from the body's start to that end. These are feedback,
// never fixes; the server's validation still decides.

export type BodyIssueCode = 'empty' | 'crossing' | 'sinks' | 'unreachable';

export type BodyIssue = Readonly<{
  code: BodyIssueCode;
  message: string;
  /** The body steps it's about, if any. */
  nodeIds: readonly string[];
}>;

const noIssues: readonly BodyIssue[] = Object.freeze([]);
const cache = new WeakMap<
  GraphLevel,
  ReadonlyMap<string, readonly BodyIssue[]>
>();

/** Every For each's body issues, by For each ID. Cached per graph. */
export function forEachBodyIssues(
  graph: GraphLevel,
): ReadonlyMap<string, readonly BodyIssue[]> {
  const cached = cache.get(graph);
  if (cached !== undefined) return cached;
  const issues = new Map<string, BodyIssue[]>();
  const add = (loopId: string, issue: BodyIssue) => {
    const list = issues.get(loopId) ?? [];
    if (!list.some((existing) => existing.code === issue.code))
      list.push(issue);
    issues.set(loopId, list);
  };
  walkLevels(graph, (level) => {
    for (const node of level.nodes) {
      if (!isForEach(node)) continue;
      for (const issue of topologyIssues(node.structured?.body))
        add(node.id, issue);
    }
  });
  for (const [loopId, issue] of crossingIssues(graph)) add(loopId, issue);
  cache.set(graph, issues);
  return issues;
}

/** One For each's body issues. */
export function bodyIssuesOf(
  graph: GraphLevel,
  loopId: string,
): readonly BodyIssue[] {
  return forEachBodyIssues(graph).get(loopId) ?? noIssues;
}

function topologyIssues(body: GraphLevel | undefined): readonly BodyIssue[] {
  if (body === undefined || body.nodes.length === 0)
    return [
      {
        code: 'empty',
        message:
          'The body is empty. Add the step each item should run through.',
        nodeIds: [],
      },
    ];
  const sinks = levelSinks(body);
  if (sinks.length > 1)
    return [
      {
        code: 'sinks',
        message: `The body ends in ${String(sinks.length)} steps: ${names(body, sinks)}. Connect them into one last step; its output is each item’s result.`,
        nodeIds: sinks,
      },
    ];
  const stranded = strandedSteps(body, sinks);
  return stranded.length === 0
    ? noIssues
    : [
        {
          code: 'unreachable',
          message: `${names(body, stranded)} ${stranded.length === 1 ? 'isn’t' : 'aren’t'} on the way from the body’s start to its last step. Remove the connection that loops back, or connect ${stranded.length === 1 ? 'it' : 'them'} into the body’s path.`,
          nodeIds: stranded,
        },
      ];
}

/** Steps a body's start can't reach, or that can't reach its one end. */
function strandedSteps(
  body: GraphLevel,
  sinks: readonly string[],
): readonly string[] {
  const ids = new Set(body.nodes.map((node) => node.id));
  const next = new Map<string, string[]>();
  const previous = new Map<string, string[]>();
  for (const edge of body.edges) {
    const { nodeId: source } = edge.source;
    const { nodeId: target } = edge.target;
    if (!ids.has(source) || !ids.has(target)) continue;
    next.set(source, [...(next.get(source) ?? []), target]);
    previous.set(target, [...(previous.get(target) ?? []), source]);
  }
  const roots = [...ids].filter((id) => !previous.has(id));
  const fromStart = reach(roots, next);
  const toEnd = reach(sinks, previous);
  return body.nodes.flatMap((node) =>
    fromStart.has(node.id) && toEnd.has(node.id) ? [] : [node.id],
  );
}

function reach(
  start: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending = [...start];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (reached.has(id)) continue;
    reached.add(id);
    pending.push(...(edges.get(id) ?? []));
  }
  return reached;
}

/** Connections joining steps on different levels, for each body involved. */
function crossingIssues(graph: GraphLevel): readonly [string, BodyIssue][] {
  const index = indexGraph(graph);
  const found: [string, BodyIssue][] = [];
  walkLevels(graph, (level, scope) => {
    for (const edge of level.edges) {
      const ends = [edge.source.nodeId, edge.target.nodeId].flatMap((id) => {
        const at = index.nodes.get(id);
        return at === undefined ? [] : [{ id, scope: at.scope }];
      });
      if (ends.every((end) => sameScope(end.scope, scope))) continue;
      for (const loopId of bodiesTouched(scope, ends))
        found.push([
          loopId,
          {
            code: 'crossing',
            message:
              'A connection crosses the body’s edge. Steps in a body only connect to each other; remove that connection.',
            nodeIds: ends.flatMap((end) =>
              loopOf(end.scope) === loopId ? [end.id] : [],
            ),
          },
        ]);
    }
  });
  return found;
}

function bodiesTouched(
  scope: ScopePath,
  ends: readonly Readonly<{ scope: ScopePath }>[],
): ReadonlySet<string> {
  return new Set(
    [scope, ...ends.map((end) => end.scope)].flatMap((candidate) => {
      const loopId = loopOf(candidate);
      return loopId === undefined ? [] : [loopId];
    }),
  );
}

function names(body: GraphLevel, ids: readonly string[]): string {
  const titles = ids.map((id) => {
    const node = body.nodes.find((candidate) => candidate.id === id);
    return node === undefined ? 'a step' : `“${stepTitle(node)}”`;
  });
  if (titles.length <= 1) return titles.join('');
  return `${titles.slice(0, -1).join(', ')} and ${titles.at(-1) ?? ''}`;
}
