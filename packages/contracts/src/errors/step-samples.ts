export const stepSampleProblems = {
  'workflow.sample_conflict': {
    status: 409,
    title: 'Pinned sample changed',
    severity: 'info',
    exposeDetail: true,
  },
  'workflow.sample_invalid': {
    status: 400,
    title: 'Invalid pinned sample',
    severity: 'info',
    exposeDetail: true,
  },
  'workflow.sample_limit': {
    status: 409,
    title: 'Pinned sample storage limit reached',
    severity: 'info',
    exposeDetail: true,
  },
} as const;
