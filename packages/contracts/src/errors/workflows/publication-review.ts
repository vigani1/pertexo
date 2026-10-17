export const publicationReviewProblems = {
  'workflow.publish_approval_required': {
    status: 409,
    title: 'Publication approval required',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.publication_review_conflict': {
    status: 409,
    title: 'Publication request unavailable',
    severity: 'warn',
    exposeDetail: true,
  },
} as const;
