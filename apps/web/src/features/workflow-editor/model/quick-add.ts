import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import type { FinalConnectionState } from '@xyflow/react';
import type { PortRef } from './graph/commands';
import type { GraphLevel } from './graph/scopes';

// Quick add: a step created after another one and linked from one of its
// outputs, either by dropping a link on empty canvas or from the
// step's ⋯ menu.

type Point = Readonly<{ x: number; y: number }>;

/**
 * The output a link drag started from, when it ended over empty
 * canvas. Drags that start from an input, or end on or near a step, are
 * ordinary link attempts and give null.
 */
export function portDropSource({
  state,
  endedOverStep,
}: Readonly<{
  state: FinalConnectionState;
  endedOverStep: boolean;
}>): PortRef | null {
  const handle = state.fromHandle;
  if (handle?.type !== 'source' || state.toNode !== null || endedOverStep)
    return null;
  return typeof handle.id === 'string'
    ? { nodeId: handle.nodeId, port: handle.id }
    : null;
}

/** Where a mouse or touch gesture ended, in viewport coordinates. */
export function gestureEndPoint(event: MouseEvent | TouchEvent): Point | null {
  if ('changedTouches' in event) {
    const touch = event.changedTouches[0];
    return touch === undefined ? null : { x: touch.clientX, y: touch.clientY };
  }
  return { x: event.clientX, y: event.clientY };
}

/** The first output with nothing linked yet, otherwise the first one. */
export function openOutputPort(
  graph: GraphLevel,
  nodeId: string,
  outputs: readonly string[],
): string | undefined {
  const used = new Set(
    graph.edges
      .filter((edge) => edge.source.nodeId === nodeId)
      .map((edge) => edge.source.port),
  );
  return outputs.find((port) => !used.has(port)) ?? outputs[0];
}

/** Steps that can follow another one: they have an input to link. */
export function followingSteps(
  definitions: readonly NodeDefinitionCatalogItem[],
): readonly NodeDefinitionCatalogItem[] {
  return definitions.filter((definition) => definition.ports.inputs.length > 0);
}
