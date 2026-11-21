import type { IntegrationModule } from '../providers/integration-module.js';
import {
  HTTP_REQUEST_DEFINITION_REGISTRATION,
  HTTP_REQUEST_NETWORK_POLICY,
  HTTP_REQUEST_VALUE_POLICY,
} from './request/request.definition.js';
import { HTTP_POLL_DEFINITION_REGISTRATION } from './polling/polling.definition.js';

export const HTTP_MODULE = {
  key: 'http',
  presentation: { name: 'HTTP request', icon: 'globe', group: 'action' },
  steps: [
    { registration: HTTP_REQUEST_DEFINITION_REGISTRATION },
    {
      registration: HTTP_POLL_DEFINITION_REGISTRATION,
      presentation: { icon: 'webhook', group: 'trigger' },
    },
  ],
  policies: [HTTP_REQUEST_NETWORK_POLICY, HTTP_REQUEST_VALUE_POLICY],
} satisfies IntegrationModule;
