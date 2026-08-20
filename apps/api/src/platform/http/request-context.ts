import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const actorKindSchema = z.enum([
  'user',
  'service_account',
  'api_key',
  'system',
]);
const actorContextSchema = z
  .object({
    actorId: z.string().min(1).max(200),
    kind: actorKindSchema,
    credentialId: z.string().min(1).max(200).optional(),
  })
  .strict();
const workspaceIdSchema = z.uuid();

export type RequestId = string;
export type WorkspaceId = string;

export type ActorContext = Readonly<z.output<typeof actorContextSchema>>;

export type RequestContext = Readonly<{
  requestId: RequestId;
  actor?: ActorContext;
  workspaceId?: WorkspaceId;
}>;

interface RequestState {
  context: RequestContext;
}

export class RequestContextUnavailableError extends Error {
  public constructor() {
    super('request context is unavailable outside an active request scope');
    this.name = 'RequestContextUnavailableError';
  }
}

export function parseRequestId(value: unknown): RequestId | undefined {
  if (typeof value !== 'string' || !requestIdPattern.test(value)) {
    return undefined;
  }

  return value;
}

export function createRequestContext(value?: unknown): RequestContext {
  const requestId = parseRequestId(value) ?? randomUUID();
  return Object.freeze({ requestId });
}

function parseWorkspaceId(value: unknown): WorkspaceId {
  return workspaceIdSchema.parse(value);
}

function parseActor(value: unknown): ActorContext {
  const actor = actorContextSchema.parse(value);

  return Object.freeze({
    actorId: actor.actorId,
    kind: actor.kind,
    ...(actor.credentialId === undefined
      ? {}
      : { credentialId: actor.credentialId }),
  });
}

function headerValue(
  headers:
    | Readonly<Record<string, string | readonly string[] | undefined>>
    | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) {
    return undefined;
  }

  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name,
  );
  const value = key === undefined ? undefined : headers[key];
  return typeof value === 'string' ? value : value?.[0];
}

export interface HttpRequestLike {
  headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** Validated server request ID for downstream guards/controllers. */
  requestId?: RequestId;
  url?: string;
}

export interface HttpResponseLike {
  header?: (name: string, value: string) => unknown;
  setHeader?: (name: string, value: string) => unknown;
  raw?: { setHeader?: (name: string, value: string) => unknown };
}

export function setResponseHeader(
  response: HttpResponseLike,
  name: string,
  value: string,
): void {
  if (typeof response.header === 'function') {
    response.header(name, value);
    return;
  }
  if (typeof response.setHeader === 'function') {
    response.setHeader(name, value);
    return;
  }
  response.raw?.setHeader?.(name, value);
}

@Injectable()
export class RequestContextStore {
  private readonly storage = new AsyncLocalStorage<RequestState>();

  public run<T>(
    contextOrRequestId: RequestContext | string | undefined,
    operation: () => T,
  ): T {
    const context =
      typeof contextOrRequestId === 'object'
        ? Object.freeze({
            requestId:
              parseRequestId(contextOrRequestId.requestId) ?? randomUUID(),
            ...(contextOrRequestId.actor !== undefined
              ? {
                  actor: parseActor(contextOrRequestId.actor),
                }
              : {}),
            ...(contextOrRequestId.workspaceId !== undefined
              ? {
                  workspaceId: parseWorkspaceId(contextOrRequestId.workspaceId),
                }
              : {}),
          })
        : createRequestContext(contextOrRequestId);

    return this.storage.run({ context }, operation);
  }

  public get(): RequestContext {
    const state = this.storage.getStore();
    if (state === undefined) {
      throw new RequestContextUnavailableError();
    }
    return state.context;
  }

  public setActor(actor: ActorContext): RequestContext {
    const state = this.state();
    state.context = Object.freeze({
      ...state.context,
      actor: parseActor(actor),
    });
    return state.context;
  }

  public setWorkspace(workspaceId: unknown): RequestContext {
    const state = this.state();
    state.context = Object.freeze({
      ...state.context,
      workspaceId: parseWorkspaceId(workspaceId),
    });
    return state.context;
  }

  private state(): RequestState {
    const state = this.storage.getStore();
    if (state === undefined) {
      throw new RequestContextUnavailableError();
    }
    return state;
  }
}

export type RequestContextNext = () => void | Promise<void>;

@Injectable()
export class RequestContextMiddleware {
  public constructor(private readonly contexts: RequestContextStore) {}

  public use(
    request: HttpRequestLike,
    response: HttpResponseLike,
    next: RequestContextNext,
  ): void | Promise<void> {
    const requestId = headerValue(request.headers, 'x-request-id');
    const context = createRequestContext(requestId);
    request.requestId = context.requestId;
    setResponseHeader(response, 'x-request-id', context.requestId);
    return this.contexts.run(context, next);
  }
}
