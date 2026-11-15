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
  return (
    layerOf.get(to) < layerOf.get(from) &&
    !CUT_CORE_AREA_EDGES.has(`${from} -> ${to}`)
  );
}
