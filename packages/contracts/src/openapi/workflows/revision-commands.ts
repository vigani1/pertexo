import type { z } from 'zod';

import {
  workflowLifecycleConflictProblemSchema,
  workflowNameConflictProblemSchema,
} from '../../schemas/workflows/authoring.js';

/**
 * Workflow commands that carry an expected aggregate revision in a strict
 * body: archive/restore (ADR 034, lifecycle revision) and rename (ADR 041,
 * name revision). Each revision is independent of drafts and of the other.
 */
export function workflowRevisionCommandSchemas<Projected>(
  project: (
    name: string,
    schema: z.ZodType,
    io: 'input' | 'output',
  ) => Projected,
) {
  return {
    WorkflowLifecycleConflictProblem: project(
      'WorkflowLifecycleConflictProblem',
      workflowLifecycleConflictProblemSchema,
      'output',
    ),
    WorkflowNameConflictProblem: project(
      'WorkflowNameConflictProblem',
      workflowNameConflictProblemSchema,
      'output',
    ),
  };
}
