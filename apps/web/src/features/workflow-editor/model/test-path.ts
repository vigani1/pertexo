import { stepTitle } from './graph-adapter';
import type { GraphLevel } from './graph-scopes';

/** The default output port; any other port is named on the path. */
const DEFAULT_PORT = 'out';
/** Steps a path names before it starts with "…". */
const PATH_STEP_LIMIT = 4;

/**
 * The path that leads into a tested step, as the bar under the canvas
 * reads it: "New invoice → Check payload → Over 5,000? (false) → Post to
 * ERP". It follows single connections back from the step on its level; a
 * step more than one connection leads into starts the path with "…", as do
 * paths longer than a few steps. A branch names the port it left through.
 * Only the graph is read: which way a run would go is never guessed.
 */
export function describeTestPath(graph: GraphLevel, nodeId: string): string {
  const names = new Map(graph.nodes.map((node) => [node.id, stepTitle(node)]));
  const steps = [names.get(nodeId) ?? 'A removed step'];
  const seen = new Set([nodeId]);
  let current = nodeId;
  let open = false;
  for (;;) {
    const incoming = graph.edges.filter(
      (edge) => edge.target.nodeId === current,
    );
    const [only] = incoming;
    if (incoming.length !== 1 || only === undefined) {
      open = incoming.length > 1;
      break;
    }
    const source = only.source.nodeId;
    if (seen.has(source)) {
      open = true;
      break;
    }
    seen.add(source);
    const name = names.get(source) ?? 'A removed step';
    steps.unshift(
      only.source.port === DEFAULT_PORT
        ? name
        : `${name} (${only.source.port})`,
    );
    current = source;
  }
  const shown = steps.slice(-PATH_STEP_LIMIT);
  const lead = open || shown.length < steps.length ? ['…'] : [];
  return [...lead, ...shown].join(' → ');
}
