import { mapConnectionError } from './connections/errors.js';
import { mapIdentityWorkspaceError } from './identity-workspace/errors.js';
import { mapNodeTestingError } from './node-testing/errors.js';
import type {
  ApplicationError,
  HttpApplicationErrorMapper,
} from './platform/http/index.js';
import { mapWorkflowAuthoringError } from './workflow-authoring/errors.js';
import { mapWorkflowRunError } from './workflow-runs/errors.js';

type RouteErrorMapper = Readonly<{
  route: RegExp;
  map: (error: unknown) => ApplicationError;
}>;

const ROUTE_ERROR_MAPPERS: readonly RouteErrorMapper[] = Object.freeze([
  {
    route:
      /^\/v1\/workspaces\/[^/]+\/(?:previews\/[^/]+|workflows\/[^/]+\/draft\/nodes\/[^/]+\/test)$/u,
    map: mapNodeTestingError,
  },
  {
    route:
      /^\/v1\/workspaces\/[^/]+\/(?:runs(?:\/|$)|workflows\/[^/]+\/runs(?:\/|$))/u,
    map: mapWorkflowRunError,
  },
  {
    route:
      /^\/v1\/workspaces\/[^/]+\/(?:connections(?:\/|$)|failure-notification-destinations(?:\/|$)|workflows\/[^/]+\/failure-notification-policy$)/u,
    map: mapConnectionError,
  },
  {
    route: /^\/v1\/workspaces\/[^/]+\/workflows(?:\/|$)/u,
    map: mapWorkflowAuthoringError,
  },
  {
    route: /^\/v1\/(?:auth|workspaces)(?:\/|$)/u,
    map: mapIdentityWorkspaceError,
  },
]);

function requestPath(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return undefined;
  }
}

export const APPLICATION_ERROR_MAPPERS: readonly HttpApplicationErrorMapper[] =
  Object.freeze([
    (error, request) => {
      const path = requestPath(request.url);
      if (path === undefined) return undefined;
      return ROUTE_ERROR_MAPPERS.find(({ route }) => route.test(path))?.map(
        error,
      );
    },
  ]);
