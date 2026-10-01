/** ADR063: additive metadata for the existing scoped GET, not a new endpoint. */
export const workflowTemplateOriginReadContract = {
  parameter: {
    name: 'include',
    in: 'query',
    required: false,
    schema: { type: 'string', const: 'templateOrigin' },
  },
  response: {
    description: 'Workflow metadata, or explicitly requested historical origin',
    headers: {
      'Cache-Control': {
        schema: { type: 'string', const: 'private, no-store' },
      },
    },
    content: {
      'application/json': {
        schema: {
          oneOf: [
            { $ref: '#/components/schemas/WorkflowSummaryResponse' },
            {
              $ref: '#/components/schemas/WorkflowTemplateOriginProjectionResponse',
            },
          ],
        },
      },
    },
  },
} as const;
