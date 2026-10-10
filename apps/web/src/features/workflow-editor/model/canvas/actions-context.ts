import { createContext } from 'react';

/** Commands canvas parts trigger themselves, such as an edge's ✕. */
type CanvasActions = Readonly<{
  editable: boolean;
  removeEdge: (edgeId: string) => void;
  /** Opens the step picker for a For each's body, next to `opener`. */
  addToBody: (loopId: string, opener: HTMLElement) => void;
}>;

export const CanvasActionsContext = createContext<CanvasActions>({
  editable: false,
  removeEdge: () => undefined,
  addToBody: () => undefined,
});
