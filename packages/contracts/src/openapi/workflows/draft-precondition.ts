import {
  strongEtagSchema,
  workflowRevisionConflictProblemSchema,
} from '../../schemas/workflows/authoring.js';
import { jsonSchema } from '../../routes/openapi-primitives.js';
import { projectContractSchema } from '../../routes/schema-projection.js';

export const workflowDraftConflictSchemas = {
  WorkflowRevisionConflictProblem: projectContractSchema(
    'WorkflowRevisionConflictProblem',
    workflowRevisionConflictProblemSchema,
    'output',
  ),
};

const etagResponseHeader = {
  ETag: {
    description: 'Strong opaque validator for this draft representation',
    required: true,
    schema: jsonSchema(strongEtagSchema, 'output'),
  },
} as const;

export const workflowDraftConflictResponse = {
  description: 'The draft representation is no longer current',
  headers: etagResponseHeader,
  content: {
    'application/problem+json': {
      schema: {
        $ref: '#/components/schemas/WorkflowRevisionConflictProblem',
      },
    },
  },
};
