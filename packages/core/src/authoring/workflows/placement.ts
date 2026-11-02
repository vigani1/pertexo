import {
  workflowDefinitionPlacementIssues,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import type { WorkflowDefinitionCatalog } from '@pertexo/workflow-model/server';
import { WorkflowDefinitionPlacementError } from './errors.js';

/** A new node must come from the catalog; without one, any node may be placed. */
export function requirePlaceableDefinitionAdditions(
  previous: WorkflowGraph,
  next: WorkflowGraph,
  placementCatalog: WorkflowDefinitionCatalog | undefined,
): void {
  if (placementCatalog === undefined) return;
  const issues = workflowDefinitionPlacementIssues(
    previous,
    next,
    placementCatalog,
  );
  if (issues.length > 0)
    throw new WorkflowDefinitionPlacementError(Object.freeze(issues));
}
