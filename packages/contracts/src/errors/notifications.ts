export const notificationProblems = {
  'notifications.changed': {
    status: 409,
    title: 'Notification settings changed',
    severity: 'info',
    exposeDetail: true,
  },
  'notifications.unavailable': {
    status: 409,
    title: 'Notification choice unavailable',
    severity: 'info',
    exposeDetail: true,
  },
  'notifications.unsubscribe_unavailable': {
    status: 404,
    title: 'Unsubscribe link unavailable',
    severity: 'info',
    exposeDetail: true,
  },
} as const;
