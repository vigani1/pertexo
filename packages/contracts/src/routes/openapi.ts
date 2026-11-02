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
import {
  routePathParameters,
  type AnyRoute,
  type RouteAccess,
  type RouteMethod,
} from './define.js';

type OperationsByMethod = Partial<Record<RouteMethod, unknown>>;

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
    if (body !== undefined)
      schemas[body.name] = jsonSchema(body.schema, 'input');
    schemas[success.body.name] = jsonSchema(success.body.schema, 'output');
  }
  return schemas;
}

function operation(route: AnyRoute) {
  return {
    operationId: route.operationId,
    ...security(route.access),
    parameters: [
      ...routePathParameters(route.path).map((name) =>
        pathParameter(
          name,
          jsonSchema(requiredShapeField(route.params, name), 'input'),
        ),
      ),
      ...csrfParameter(route),
      ...(route.idempotent === true ? [idempotencyHeaderParameter()] : []),
      ...queryParameters(route),
    ],
    ...(route.body === undefined
      ? {}
      : { requestBody: jsonRequest(route.body.name) }),
    responses: {
      [String(route.success.status)]: jsonResponse(
        route.success.description,
        route.success.body.name,
      ),
      ...route.problems,
    },
  };
}

function security(access: RouteAccess) {
  if (access.auth === 'public') return {};
  return access.auth === 'session'
    ? { security: [{ cookieSession: [] }] }
    : { security: automationSecurity };
}

function csrfParameter(route: AnyRoute) {
  if (route.method === 'get' || route.access.auth === 'public') return [];
  return route.access.auth === 'session'
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
