import {
  HTTP_HEADERS_CONNECTION,
  OAUTH2_CONNECTION,
} from './connections.definition.js';
import { createHttpRequestExecutorRegistration } from './request/request.executor.js';
import { httpPollExecutor } from './polling/polling.executor.js';
