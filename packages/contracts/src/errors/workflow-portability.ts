/** Bounded public portability errors; uploaded content never forms a title. */
export const WORKFLOW_PORTABILITY_PROBLEM_CODES = [
  'workflow.portability_unavailable',
  'workflow.portability_compatibility_conflict',
  'workflow.portability_review_conflict',
  'workflow.portability_invalid',
] as const;

export const WORKFLOW_PORTABILITY_PROBLEM_DETAILS = {
  'workflow.portability_unavailable': {
    status: 503,
    title: 'Workflow import unavailable',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.portability_compatibility_conflict': {
    status: 409,
    title: 'Workflow compatibility changed',
    severity: 'info',
    exposeDetail: true,
  },
  'workflow.portability_review_conflict': {
    status: 409,
    title: 'Reviewed workflow changed',
    severity: 'info',
    exposeDetail: true,
  },
  'workflow.portability_invalid': {
    status: 422,
    title: 'Invalid portable workflow',
    severity: 'info',
    exposeDetail: true,
  },
  'workflow.template_origin_unavailable': {
    status: 503,
    title: 'Historical template origin unavailable',
    severity: 'warn',
    exposeDetail: true,
  },
} as const;
