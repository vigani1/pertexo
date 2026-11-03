import type {
  AuthorizationCapability,
  WorkspaceStatusList,
} from '@pertexo/policy';
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
      /** Each is checked in order; most routes have one. */
      capabilities?: readonly RouteCapability[];
      /**
       * A native form POST can't set a header, so its token comes in the body and the
       * handler checks it. Anything else takes CSRF in the header, from the guard.
       */
      csrf?: 'header_or_body';
    }>;

/** A schema with the name its OpenAPI component takes. */
export type NamedSchema<Schema extends z.ZodType = z.ZodType> = Readonly<{
  name: string;
  schema: Schema;
  /** Recursive JSON values need the shared projection to stay readable. */
  projected?: true;
}>;

export function named<Schema extends z.ZodType>(
  name: string,
  schema: Schema,
  options: Readonly<{ projected?: true }> = {},
): NamedSchema<Schema> {
  return { name, schema, ...options };
}

/** A JSON answer, checked against its schema before it leaves. */
type JsonSuccess<Response extends z.ZodType> = Readonly<{
  status: number;
  description: string;
  body: NamedSchema<Response>;
  /** Documented response headers, by name. */
  headers?: Readonly<Record<string, unknown>>;
}>;
/** Anything else, such as a CSV stream, which the handler writes itself. */
type DocumentedSuccess = Readonly<{
  status: number;
  response: Readonly<Record<string, unknown>>;
  /** The handler returns `{ url }` and the answer is a redirect there. */
  redirect?: true;
}>;

type RouteSuccess = JsonSuccess<z.ZodType> | DocumentedSuccess;

/**
 * `true` makes the key required and parsed before the handler. `when` is for a key
 * only some requests need: it's documented as optional, and the handler reads it.
 */
export type RouteIdempotency = boolean | Readonly<{ when: string }>;

type RouteShape = z.ZodObject;

export type RouteDeclaration<
  Params extends RouteShape = RouteShape,
  Query extends RouteShape = RouteShape,
  Body extends z.ZodType = z.ZodType,
  Response extends z.ZodType = z.ZodType,
  Idempotent extends RouteIdempotency = RouteIdempotency,
> = Readonly<{
  operationId: string;
  method: RouteMethod;
  /** OpenAPI form: `/v1/workspaces/{workspaceId}/variables`. */
  path: `/${string}`;
  access: RouteAccess;
  rateLimit: RouteRateClass;
  params?: Params;
  query?: Query;
  /** Request headers a route reads as input, by lower-case name. */
  headers?: z.ZodObject;
  /** Fixed response headers, such as a Referrer-Policy. */
  responseHeaders?: Readonly<Record<string, string>>;
  body?: NamedSchema<Body>;
  idempotent?: Idempotent;
  cacheControl?: string;
  description?: string;
  /**
   * Replaces the JSON request body in the document, for a route that takes more than
   * JSON. Its handler parses the body, so `@In` leaves it alone.
   */
  requestDocument?: Readonly<Record<string, unknown>>;
  success: JsonSuccess<Response> | DocumentedSuccess;
  /**
   * Answers the handler may choose instead, by setting the status, such as 202 when
   * it queued the work. The answer is checked against whichever status it sent.
   */
  otherSuccesses?: readonly RouteSuccess[];
  /** OpenAPI responses by status, from `problemResponse` or `responseReference`. */
  problems: Readonly<Record<string, unknown>>;
}>;

export type AnyRoute = RouteDeclaration;

const PATH_PARAMETER = /\{(?<name>[^{}]+)\}/gu;

export function routePathParameters(path: string): readonly string[] {
  return [...path.matchAll(PATH_PARAMETER)].map(
    (match) => match.groups?.name ?? '',
  );
}

/** A path and its parameter schema must name the same things, or the route can't parse. */
export function defineRoute<const Route extends AnyRoute>(route: Route): Route {
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
        headers: Route extends Readonly<{ headers: infer Headers }>
          ? Headers extends z.ZodType
            ? z.output<Headers>
            : undefined
          : undefined;
      }>
    : never;
