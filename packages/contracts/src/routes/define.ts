import type {
  AuthorizationCapability,
  WorkspaceStatusList,
} from '@pertexo/workflow-model';
import type { z } from 'zod';

export type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** `@Route` hands this to the limiter, whose own type checks each name. */
export type RouteRateClass =
  | 'webhook_preflight'
  | 'callback_ingress'
  | 'notice_unsubscribe'
  | 'form_read'
  | 'form_submission'
  | 'form_workspace_submission'
  | 'form_upload'
  | 'identity_start'
  | 'automation_authentication'
  | 'directory_provisioning'
  | 'identity_callback'
  | 'authenticated_read'
  | 'data_table_export'
  | 'actor_mutation'
  | 'ordinary_mutation'
  | 'workflow_compile'
  | 'run_admission'
  | 'preview_test'
  | 'connection_mutation'
  | 'provider_test'
  | 'destination_test'
  | 'trigger_mutation'
  | 'provider_execution';

/**
 * The coarse first check. Core re-checks under lock, so this isn't the authority:
 * it answers early and documents the route.
 */
export type RouteCapability = Readonly<{
  name: AuthorizationCapability;
  statuses: WorkspaceStatusList;
  disclosure: 'not_found' | 'forbidden';
}>;

export type RouteAccess =
  | Readonly<{ auth: 'public' }>
  | Readonly<{
      auth: 'session' | 'session_or_token';
      capability?: RouteCapability;
    }>;

/** A schema with the name its OpenAPI component takes. */
export type NamedSchema<Schema extends z.ZodType = z.ZodType> = Readonly<{
  name: string;
  schema: Schema;
}>;

export function named<Schema extends z.ZodType>(
  name: string,
  schema: Schema,
): NamedSchema<Schema> {
  return { name, schema };
}

type RouteShape = z.ZodObject;

export type RouteDeclaration<
  Params extends RouteShape = RouteShape,
  Query extends RouteShape = RouteShape,
  Body extends z.ZodType = z.ZodType,
  Response extends z.ZodType = z.ZodType,
  Idempotent extends boolean = boolean,
> = Readonly<{
  operationId: string;
  method: RouteMethod;
  /** OpenAPI form: `/v1/workspaces/{workspaceId}/variables`. */
  path: `/${string}`;
  access: RouteAccess;
  rateLimit: RouteRateClass;
  params?: Params;
  query?: Query;
  body?: NamedSchema<Body>;
  idempotent?: Idempotent;
  cacheControl?: string;
  success: Readonly<{
    status: number;
    description: string;
    body: NamedSchema<Response>;
  }>;
  /** OpenAPI responses by status, from `problemResponse` or `responseReference`. */
  problems: Readonly<Record<string, unknown>>;
}>;

export type AnyRoute = RouteDeclaration;

const PATH_PARAMETER = /\{(?<name>[^}]+)\}/gu;

export function routePathParameters(path: string): readonly string[] {
  return [...path.matchAll(PATH_PARAMETER)].map(
    (match) => match.groups?.name ?? '',
  );
}

/** A path and its parameter schema must name the same things, or the route can't parse. */
export function defineRoute<
  Params extends RouteShape,
  Query extends RouteShape,
  Body extends z.ZodType,
  Response extends z.ZodType,
  Idempotent extends boolean = false,
>(
  route: RouteDeclaration<Params, Query, Body, Response, Idempotent>,
): RouteDeclaration<Params, Query, Body, Response, Idempotent> {
  const inPath = routePathParameters(route.path).toSorted();
  const declared = Object.keys(route.params?.shape ?? {}).toSorted();
  if (inPath.join() !== declared.join())
    throw new Error(
      `${route.operationId}: path parameters ${inPath.join()} don't match the declared ${declared.join()}`,
    );
  return route;
}

/** What a handler receives once its route's declared inputs have parsed. */
export type RouteInput<Route> =
  Route extends RouteDeclaration<
    infer Params,
    infer Query,
    infer Body,
    z.ZodType,
    infer Idempotent
  >
    ? Readonly<{
        params: z.output<Params>;
        query: z.output<Query>;
        body: z.output<Body>;
        idempotencyKey: Idempotent extends true ? string : undefined;
      }>
    : never;
