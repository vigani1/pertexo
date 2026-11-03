import {
  applyDecorators,
  createParamDecorator,
  Delete,
  Get,
  Header,
  HttpCode,
  Patch,
  Post,
  Put,
  Redirect,
  SetMetadata,
  UseGuards,
  UseInterceptors,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  type NestInterceptor,
  type Type,
} from '@nestjs/common';
import type { AnyRoute, RouteCapability } from '@pertexo/contracts/server';
import { map, type Observable } from 'rxjs';
import type { z } from 'zod';

import { requestIdempotencyKey } from '../../platform/http/idempotency-key.js';
import { parseRequestInput } from '../../platform/http/request-input.js';
import { firstRequestHeader } from '../../platform/http/request-headers.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { AutomationAuthenticationGuard } from '../../authentication/automation/guard.js';
import { WORKSPACE_AUTHORIZATION } from '../tokens.js';
import type { IdentityWorkspaceRequest } from '../workspace-transport.js';
import {
  capabilityGuard,
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from './guards.js';

const ROUTE_METADATA = Symbol('ROUTE_METADATA');

const METHOD_DECORATORS = {
  get: Get,
  post: Post,
  put: Put,
  patch: Patch,
  delete: Delete,
} as const;

/**
 * Registers a handler from its declaration: method, path, status, limit, sign-in,
 * the coarse capability check, CSRF, its input and its answer. A controller adds only
 * what isn't a route fact, and takes the parsed input with `@In()`.
 */
export function Route(route: AnyRoute): MethodDecorator {
  return applyDecorators(
    SetMetadata(ROUTE_METADATA, route),
    METHOD_DECORATORS[route.method](nestPath(route.path)),
    HttpCode(route.success.status),
    RateLimit(route.rateLimit),
    UseGuards(...routeGuards(route)),
    UseInterceptors(RouteContractInterceptor),
    ...(route.cacheControl === undefined
      ? []
      : [Header('Cache-Control', route.cacheControl)]),
    ...Object.entries(route.responseHeaders ?? {}).map(([name, value]) =>
      Header(name, value),
    ),
    ...('redirect' in route.success
      ? [Redirect(undefined, route.success.status)]
      : []),
  );
}

/**
 * The same route when its feature isn't configured: same path, sign-in and access
 * checks, but it reads nothing it's sent, so every caller learns the feature is off.
 */
export function UnconfiguredRoute(route: AnyRoute): MethodDecorator {
  const {
    query: _query,
    body: _body,
    headers: _headers,
    idempotent: _idempotent,
    ...answersOnly
  } = route;
  return Route(answersOnly);
}

/** A handler's declared input, already parsed before it ran. */
export const In = createParamDecorator(
  (_data: unknown, context: ExecutionContext): unknown =>
    parsedInputs.get(context.switchToHttp().getRequest<object>()),
);

const parsedInputs = new WeakMap<object, RouteInputValues>();

type RouteInputValues = Readonly<{
  params: unknown;
  query: unknown;
  body: unknown;
  idempotencyKey: string | undefined;
  headers: unknown;
}>;

type RouteInputSource = IdentityWorkspaceRequest &
  Readonly<{ params?: unknown; query?: unknown; body?: unknown }>;

/** Every declared input parses, whether or not the handler reads it; a failure is the caller's. */
function parseInputs(route: AnyRoute, request: RouteInputSource) {
  return {
    params: parseDeclared(route.params, request.params),
    query: parseDeclared(route.query, request.query ?? {}),
    // A route that documents its own request body, such as a form post, reads it itself.
    body:
      route.requestDocument === undefined
        ? parseDeclared(route.body?.schema, request.body)
        : undefined,
    idempotencyKey:
      route.idempotent === true
        ? requestIdempotencyKey(request.headers ?? {})
        : undefined,
    headers: parseDeclared(route.headers, declaredHeaders(route, request)),
  };
}

function declaredHeaders(route: AnyRoute, request: RouteInputSource) {
  return Object.fromEntries(
    Object.keys(route.headers?.shape ?? {}).map((name) => [
      name,
      firstRequestHeader(request.headers ?? {}, name),
    ]),
  );
}

function parseDeclared(schema: z.ZodType | undefined, value: unknown): unknown {
  return schema === undefined ? undefined : parseRequestInput(schema, value);
}

function declaredRoute(context: ExecutionContext): AnyRoute {
  return Reflect.getMetadata(ROUTE_METADATA, context.getHandler()) as AnyRoute;
}

/** Ours, not the caller's: it must not read as a bad request. */
class RouteResponseContractError extends Error {
  public override readonly name = 'RouteResponseContractError';
}

/** Parses the declared input before the handler, and checks the answer after it. */
class RouteContractInterceptor implements NestInterceptor {
  public intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const route = declaredRoute(context);
    const request = context.switchToHttp().getRequest<RouteInputSource>();
    parsedInputs.set(request, parseInputs(route, request));
    const answers = [route.success, ...(route.otherSuccesses ?? [])];
    if (!answers.some((answer) => 'body' in answer)) return next.handle();
    const reply = context.switchToHttp().getResponse<{ statusCode: number }>();
    return next
      .handle()
      .pipe(
        map((value: unknown) =>
          checkedAnswer(answers, reply.statusCode, value),
        ),
      );
  }
}

/** The answer the handler chose must be one the route declares, in that answer's shape. */
function checkedAnswer(
  answers: readonly AnyRoute['success'][],
  status: number,
  value: unknown,
): unknown {
  const answer = answers.find((candidate) => candidate.status === status);
  if (answer === undefined)
    throw new RouteResponseContractError(
      `A ${String(status)} response isn't declared`,
    );
  if (!('body' in answer)) return value;
  const checked = answer.body.schema.safeParse(value);
  if (checked.success) return checked.data;
  throw new RouteResponseContractError(
    `A ${String(status)} response didn't match ${answer.body.name}`,
    { cause: checked.error },
  );
}

function nestPath(path: string): string {
  return path.replaceAll(/\{([^{}]+)\}/gu, ':$1');
}

function routeGuards({
  access,
  method,
}: AnyRoute): readonly Type<CanActivate>[] {
  if (access.auth === 'public') return [];
  const csrf = method !== 'get' && access.csrf !== 'header_or_body';
  return [
    access.auth === 'session'
      ? SessionAuthenticationGuard
      : AutomationAuthenticationGuard,
    ...(access.capabilities ?? []).map(guardFor),
    ...(csrf ? [CsrfProtectionGuard] : []),
  ];
}

const capabilityGuards = new Map<string, Type<CanActivate>>();

function guardFor({
  name,
  statuses,
  disclosure,
}: RouteCapability): Type<CanActivate> {
  const key = `${name}|${disclosure}|${statuses.join()}`;
  let guard = capabilityGuards.get(key);
  if (guard === undefined) {
    guard = capabilityGuard(WORKSPACE_AUTHORIZATION, name, {
      disclosure,
      allowedWorkspaceStatuses: statuses,
    });
    capabilityGuards.set(key, guard);
  }
  return guard;
}
