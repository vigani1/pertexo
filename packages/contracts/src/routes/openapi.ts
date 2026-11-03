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
  for (const route of routes) {
    if (route.body !== undefined)
      schemas[route.body.name] = projected(route.body, 'input');
    for (const success of successes(route))
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
      ...Object.fromEntries(
        successes(route).map((success) => [
          String(success.status),
          successResponse(success),
        ]),
      ),
      ...route.problems,
    },
  };
}

function successes(route: AnyRoute) {
  return [route.success, ...(route.otherSuccesses ?? [])];
}

function successResponse(success: AnyRoute['success']) {
  if (!('body' in success)) return success.response;
  return {
    ...jsonResponse(success.description, success.body.name),
    ...(success.headers === undefined ? {} : { headers: success.headers }),
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
    ...idempotencyParameter(route),
    ...queryParameters(route),
    ...headerParameters(route),
  ];
  return all.length === 0 ? {} : { parameters: all };
}

function idempotencyParameter({ idempotent }: AnyRoute) {
  if (idempotent === undefined || idempotent === false) return [];
  if (idempotent === true) return [idempotencyHeaderParameter()];
  return [
    {
      ...idempotencyHeaderParameter({ required: false }),
      description: `Required when ${idempotent.when}`,
    },
  ];
}

function requestBody({ body, requestDocument }: AnyRoute) {
  if (requestDocument !== undefined) return { requestBody: requestDocument };
  if (body === undefined) return {};
  // A body the schema can do without, such as an empty settings object, is optional.
  const required = !body.schema.safeParse(undefined).success;
  return { requestBody: { ...jsonRequest(body.name), required } };
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
  if (access.auth === 'public') return { security: [] };
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
  const required = requiredFields(query);
  return Object.entries(query.shape).map(([name, schema]) =>
    queryParameter(name, schema as z.ZodType, {
      required: required.has(name),
    }),
  );
}

function headerParameters({ headers }: AnyRoute) {
  if (headers === undefined) return [];
  const required = requiredFields(headers);
  return Object.entries(headers.shape).map(([name, field]) => {
    const schema = field as z.ZodType;
    return {
      in: 'header',
      name,
      required: required.has(name),
      // A header's purpose is rarely clear from its name, so `.describe()` says it.
      ...(schema.description === undefined
        ? {}
        : { description: schema.description }),
      schema: jsonSchema(schema, 'input'),
    };
  });
}

/**
 * The fields an empty object is refused for. Asking each field about `undefined`
 * would call an exact-optional field required, though leaving it out is fine.
 */
function requiredFields(object: z.ZodObject): ReadonlySet<PropertyKey> {
  const issues = object.safeParse({}).error?.issues ?? [];
  return new Set(
    issues.flatMap(({ code, path: [field, ...nested] }) =>
      code === 'invalid_type' && field !== undefined && nested.length === 0
        ? [field]
        : [],
    ),
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
