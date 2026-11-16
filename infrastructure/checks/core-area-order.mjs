/**
 * Core's areas from the bottom up. An area imports only areas in layers below
 * its own; areas in one layer don't import each other. Both
 * `validate-module-imports.mjs` (through `execution-area-rules.mjs`) and
 * `validate-core-area-cycles.mjs` read this table.
 */
export const CORE_AREA_LAYERS = Object.freeze([
  ['shared'],
  ['governance', 'outbox'],
  ['memberships'],
  ['variables', 'connections'],
  ['identity'],
  ['tenant-access'],
  ['notifications'],
  ['artifacts'],
  ['attempts'],
  ['data-tables'],
  ['runs'],
  ['triggers'],
  ['authoring'],
  ['inbox', 'previews'],
  ['lifecycle', 'operator'],
]);

/**
 * Edges the order would allow that batch D cut by an ownership decision; a
 * new one needs its owner's decision first.
 */
const CUT_CORE_AREA_EDGES = Object.freeze(
  new Set([
    'authoring -> connections',
    'lifecycle -> tenant-access',
    'previews -> tenant-access',
  ]),
);

/**
 * Areas whose reach the layer order alone doesn't decide (L4e review P2-2):
 * an import into one that holds credentials or session and member authority,
 * and every import out of the operator, which may otherwise reach almost every
 * product area. Each such edge is listed by name with its reason; the list
 * has a fixed entry budget; increasing that budget needs an explicit reviewed
 * change. An entry no import uses is refused
 * (validate-core-area-cycles.mjs).
 */
const GUARDED_TARGETS = Object.freeze(
  new Set(['connections', 'identity', 'tenant-access']),
);
const GUARDED_SOURCES = Object.freeze(new Set(['operator']));

export const GUARDED_CORE_AREA_EDGE_BUDGET = 12;

export const GUARDED_CORE_AREA_EDGES = Object.freeze({
  'attempts -> connections':
    'A node attempt records the credential use it dispatches with.',
  'notifications -> connections':
    "A failure notice delivery resolves its destination connection's credential.",
  'previews -> connections':
    'A preview attempt records the credential use it dispatches with.',
  'lifecycle -> connections':
    "Workspace deletion removes the workspace's OAuth2 grants.",
  'lifecycle -> identity':
    "Purge detaches the identity directory's memberships in the workspace.",
  'tenant-access -> identity':
    'Invitations and members check sessions and the email policy identity owns.',
  'authoring -> tenant-access':
    'Comment mentions and folder sharing read the workspace members and principals.',
  'operator -> attempts': 'The operator reconciles a stuck attempt.',
  'operator -> governance': 'Every operator command appends its audit fact.',
  'operator -> outbox': 'The operator re-enqueues and replays deliveries.',
  'operator -> runs':
    'The operator cancels runs, lists stuck work and replays accepted runs.',
  'operator -> shared':
    'Stored values, run retention and transaction timeouts the operator reads.',
});

function isGuardedCoreAreaEdge(from, to) {
  return from !== to && (GUARDED_TARGETS.has(to) || GUARDED_SOURCES.has(from));
}

const layerOf = new Map(
  CORE_AREA_LAYERS.flatMap((layer, index) =>
    layer.map((area) => [area, index]),
  ),
);

export function isCoreArea(area) {
  return layerOf.has(area);
}

/** Whether core area `from` may import core area `to`. */
export function coreAreaDependencyAllowed(from, to) {
  if (from === to) return true;
  if (!layerOf.has(from) || !layerOf.has(to)) return false;
  const edge = `${from} -> ${to}`;
  return (
    layerOf.get(to) < layerOf.get(from) &&
    !CUT_CORE_AREA_EDGES.has(edge) &&
    (!isGuardedCoreAreaEdge(from, to) ||
      Object.hasOwn(GUARDED_CORE_AREA_EDGES, edge))
  );
}
