export const webhooksProblems = {
  'webhook.setting_up': {
    status: 409,
    title: 'Webhook still being set up',
    severity: 'info',
    exposeDetail: true,
  },
  'trigger.coordination_unavailable': {
    status: 503,
    title: 'Event coordination temporarily unavailable',
    severity: 'warn',
    exposeDetail: false,
  },
  'webhook.not_configured': {
    status: 503,
    title: 'Webhooks are not configured',
    severity: 'warn',
    exposeDetail: false,
  },
  'webhook.authentication_failed': {
    status: 401,
    title: 'Webhook authentication failed',
    severity: 'info',
    exposeDetail: false,
  },
  'webhook.payload_too_large': {
    status: 413,
    title: 'Webhook payload too large',
    severity: 'info',
    exposeDetail: false,
  },
  'webhook.unsupported_media_type': {
    status: 415,
    title: 'Unsupported webhook media type',
    severity: 'info',
    exposeDetail: false,
  },
  'webhook.invalid_json': {
    status: 400,
    title: 'Invalid webhook JSON',
    severity: 'info',
    exposeDetail: false,
  },
  'webhook.method_not_allowed': {
    status: 405,
    title: 'Webhook method not allowed',
    severity: 'info',
    exposeDetail: false,
  },
  'webhook.idempotency_conflict': {
    status: 409,
    title: 'Webhook idempotency conflict',
    severity: 'warn',
    exposeDetail: false,
  },
  'webhook.rate_limited': {
    status: 429,
    title: 'Webhook rate limit reached',
    severity: 'warn',
    exposeDetail: false,
  },
  // ADR 056: returned only after the signature verified.
  'webhook.workflow_paused': {
    status: 423,
    title: 'Workflow paused',
    severity: 'warn',
    exposeDetail: false,
  },
  'webhook.unavailable': {
    status: 503,
    title: 'Webhook unavailable',
    severity: 'error',
    exposeDetail: false,
  },
} as const;
