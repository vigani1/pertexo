export const formProblems = {
  'form.unavailable': {
    status: 404,
    title: 'Form unavailable',
    severity: 'info',
    exposeDetail: true,
  },
  'form.changed': {
    status: 409,
    title: 'Form changed',
    severity: 'info',
    exposeDetail: true,
  },
  'form.access_conflict': {
    status: 409,
    title: 'Form access changed',
    severity: 'info',
    exposeDetail: true,
  },
  'form.invalid': {
    status: 400,
    title: 'Check the form fields',
    severity: 'info',
    exposeDetail: true,
  },
  'form.required': {
    status: 409,
    title: 'Use the workflow form',
    severity: 'info',
    exposeDetail: true,
  },
} as const;
