export const callbackProblems = {
  'callback.already_received': {
    status: 409,
    title: 'Callback already received',
    severity: 'info',
    exposeDetail: false,
  },
  'callback.expired': {
    status: 410,
    title: 'Callback is no longer available',
    severity: 'info',
    exposeDetail: false,
  },
  'callback.unavailable': {
    status: 503,
    title: 'Callbacks are unavailable',
    severity: 'error',
    exposeDetail: false,
  },
} as const;
