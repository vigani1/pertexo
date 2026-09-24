import { createContext } from 'react';

/** Commands canvas parts trigger themselves, such as an edge's ✕. */
type CanvasActions = Readonly<{
  editable: boolean;
  removeEdge: (edgeId: string) => void;
}>;

export const CanvasActionsContext = createContext<CanvasActions>({
  editable: false,
  removeEdge: () => undefined,
});
