import { z } from 'zod';

import {
  automationCsrfHeaderParameter,
  automationSecurity,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  pathParameter,
  queryParameter,
} from '../openapi/primitives.js';
import { projectContractSchema } from '../openapi/schema-projection.js';
import {
  routePathParameters,
  type NamedSchema,
  type AnyRoute,
  type RouteAccess,
  type RouteMethod,
} from './define.js';

type OperationsByMethod = Partial<
  Record<RouteMethod, ReturnType<typeof operation>>
>;

/** The `paths` object for routes, in declaration order. */
export function routePaths(
  routes: readonly AnyRoute[],
): Record<string, OperationsByMethod> {
  const paths: Record<string, OperationsByMethod> = {};
  for (const route of routes)
    paths[route.path] = {
      ...paths[route.path],
      [route.method]: operation(route),
    };
  return paths;
}

/** The component schemas routes name, each projected for the way it's used. */
export function routeSchemas(
  routes: readonly AnyRoute[],
): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const { body, success } of routes) {
    if (body !== undefined) schemas[body.name] = projected(body, 'input');
    if ('body' in success)
      schemas[success.body.name] = projected(success.body, 'output');
  }
  return schemas;
}

function projected(named: NamedSchema, io: 'input' | 'output') {
  return named.projected === true
    ? projectContractSchema(named.name, named.schema, io)
    : jsonSchema(named.schema, io);
}

function operation(route: AnyRoute) {
  return {
    operationId: route.operationId,
    ...tokenScopes(route.access),
    ...(route.description === undefined
      ? {}
      : { description: route.description }),
    ...security(route.access),
    ...parameters(route),
    ...requestBody(route),
    responses: {
      [String(route.success.status)]:
        'body' in route.success
          ? jsonResponse(route.success.description, route.success.body.name)
          : route.success.response,
      ...route.problems,
    },
  };
}

function parameters(route: AnyRoute) {
  const all = [
    ...routePathParameters(route.path).map((name) =>
      pathParameter(
        name,
        jsonSchema(requiredShapeField(route.params, name), 'input'),
      ),
    ),
    ...csrfParameter(route),
    ...(route.idempotent === true ? [idempotencyHeaderParameter()] : []),
    ...queryParameters(route),
  ];
  return all.length === 0 ? {} : { parameters: all };
}

function requestBody({ body, requestDocument }: AnyRoute) {
  if (requestDocument !== undefined) return { requestBody: requestDocument };
  return body === undefined ? {} : { requestBody: jsonRequest(body.name) };
}

function tokenScopes(access: RouteAccess) {
  if (access.auth !== 'session_or_token') return {};
  return {
    'x-pertexo-api-token-scopes': (access.capabilities ?? []).map(
      ({ name }) => name,
    ),
  };
}

function security(access: RouteAccess) {
  if (access.auth === 'public') return {};
  return access.auth === 'session'
    ? { security: [{ cookieSession: [] }] }
    : { security: automationSecurity };
}

function csrfParameter({ method, access }: AnyRoute) {
  if (method === 'get' || access.auth === 'public') return [];
  if (access.csrf === 'header_or_body')
    return [
      {
        ...csrfHeaderParameter(),
        required: false,
        description:
          'Required for JSON POST; native form POST supplies csrfToken in its body.',
      },
    ];
  return access.auth === 'session'
    ? [csrfHeaderParameter()]
    : [automationCsrfHeaderParameter()];
}

function queryParameters({ query }: AnyRoute) {
  if (query === undefined) return [];
  return Object.entries(query.shape).map(([name, schema]) =>
    queryParameter(name, schema as z.ZodType, {
      required: !(schema as z.ZodType).safeParse(undefined).success,
    }),
  );
}

function requiredShapeField(
  shape: AnyRoute['params'],
  name: string,
): z.ZodType {
  const fields = shape?.shape as
    Readonly<Record<string, z.ZodType>> | undefined;
  return fields?.[name] ?? z.never();
}
