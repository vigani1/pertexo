export const promotionProblems = {
  'workflow.promotion_conflict': {
    status: 409,
    title: 'Promotion needs review',
    severity: 'warn',
    exposeDetail: true,
  },
  'workflow.promotion_unavailable': {
    status: 503,
    title: 'Promotion unavailable',
    severity: 'warn',
    exposeDetail: true,
  },
} as const;
