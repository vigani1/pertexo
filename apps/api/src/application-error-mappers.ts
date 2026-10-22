import { mapDataTableError } from './data-tables/errors.js';
import { mapApiTokenError } from './api-tokens/errors.js';
import { mapConnectionError } from './connections/errors.js';
import { mapArtifactError } from './artifacts/errors.js';
import { mapIdentityWorkspaceError } from './workspaces/errors.js';
import { mapNodeTestingError } from './node-testing/errors.js';
import { mapNotificationError } from './notifications/errors.js';
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

function mappedFeatureError(
  mapper: RouteErrorMapper['map'],
  error: unknown,
): ApplicationError | undefined {
  const mapped = mapper(error);
  return mapped.code === 'internal.unexpected' && mapped.cause === error
    ? undefined
    : mapped;
}

const ROUTE_ERROR_MAPPERS: readonly RouteErrorMapper[] = Object.freeze([
  {
    route: /^\/v1\/workspaces\/[^/]+\/data-tables(?:\/|$)/u,
    map: mapDataTableError,
  },
  {
    route: /^\/v1\/workspaces\/[^/]+\/api-tokens(?:\/|$)/u,
    map: mapApiTokenError,
  },
  {
    route: /^\/v1\/workspaces\/[^/]+\/artifacts(?:\/|$)/u,
    map: mapArtifactError,
  },
  {
    route:
      /^\/v1\/workspaces\/[^/]+\/(?:previews\/[^/]+|workflows\/[^/]+\/draft\/(?:tests(?:\/[^/]+(?:\/cancel)?)?|test-suites(?:\/[^/]+(?:\/(?:cancel|cases\/[^/]+))?)?|samples|nodes\/[^/]+\/(?:test|sample)))$/u,
    map: mapNodeTestingError,
  },
  {
    route:
      /^\/v1\/workspaces\/[^/]+\/(?:runs(?:\/|$)|run-statistics$|workflows\/[^/]+\/(?:runs(?:\/|$)|step-health$|steps\/[^/]+\/runs$))/u,
    map: mapWorkflowRunError,
  },
  {
    route:
      /^\/v1\/workspaces\/[^/]+\/(?:connections(?:\/|$)|failure-notification-destinations(?:\/|$)|workflows\/[^/]+\/failure-notification-policy$)/u,
    map: mapConnectionError,
  },
  {
    route: /^\/v1\/workspaces\/[^/]+\/notifications(?:\/|$)/u,
    map: mapNotificationError,
  },
  {
    route: /^\/v1\/workspaces\/[^/]+\/workflows(?:\/|$)/u,
    map: mapWorkflowAuthoringError,
  },
  {
    route: /^\/v1\/(?:auth|users|workspaces|invitation-acceptance)(?:\/|$)/u,
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
      const mapper = ROUTE_ERROR_MAPPERS.find(({ route }) => route.test(path));
      return mapper === undefined
        ? undefined
        : mappedFeatureError(mapper.map, error);
    },
  ]);
