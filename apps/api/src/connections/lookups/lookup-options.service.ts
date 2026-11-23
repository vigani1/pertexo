import {
  CONNECTION_LOOKUP_LIMITS,
  connectionLookupResponseSchema,
  type ConnectionLookupRequest,
} from '@pertexo/contracts';
import {
  ProviderCredentialRejectedError,
  ProviderHttpError,
  type ConnectionLookup,
} from '@pertexo/integrations/server';
import { findConnectionLookup } from '@pertexo/node-catalog';
import {
  ConnectionNotFoundError,
  ConnectionUnavailableError,
  type ApiConnectionStore,
  type ResolvedConnectionSecretRecord,
} from '@pertexo/core/connections';
import { ConnectionSecretEncryptionError } from '@pertexo/secrets/server';
import { utf8ByteLength } from '@pertexo/workflow-model';
import { requestInputError } from '../../platform/http/request-input.js';
import {
  applicationError,
  throwApplicationError,
} from '../../platform/http/application-error.js';
import {
  encryptionSignal,
  type ConnectionCommandInput,
} from '../management/connection-serialization.js';
import type { ConnectionSecretEncryptionPort } from '../ports.js';
import { boundedLookupHttp, type LookupHttp } from './bounded-http.js';

export type ConnectionLookupDependencies = Readonly<{
  persistence: Pick<
    ApiConnectionStore,
    | 'resolveConnectionLookupSecret'
    | 'assertConnectionLookupAccess'
    | 'assertConnectionLookupSecretCurrent'
  >;
  encryption: Pick<ConnectionSecretEncryptionPort, 'open'>;
  http: LookupHttp;
}>;

type LookupCommand = ConnectionCommandInput &
  Readonly<{
    connectionId: string;
    request: ConnectionLookupRequest;
  }>;

type ConnectionTest = Readonly<{
  resolved: ResolvedConnectionSecretRecord;
  beforeDispatch(): Promise<void>;
}>;

export class LookupConnectionOptionsService {
  public constructor(
    private readonly dependencies: ConnectionLookupDependencies,
  ) {}

  public async execute(input: LookupCommand, test?: ConnectionTest) {
    const { lookup: key, providerKey } = input.request;
    const lookup = findConnectionLookup(providerKey, key);
    if (lookup === undefined)
      throw requestInputError(['lookup'], 'Unknown connection lookup');
    const prepared = lookup.prepare(input.request.input);
    if (prepared === undefined)
      throw requestInputError(['input'], 'Invalid lookup input');
    const callerSignal = encryptionSignal(input);
    callerSignal.throwIfAborted();
    const local: unknown = prepared.local();
    if (local !== undefined) {
      await this.dependencies.persistence.assertConnectionLookupAccess({
        workspaceId: input.routeWorkspaceId,
        actorId: input.actor.actorId,
        connectionId: input.connectionId,
        expectedProviderKey: providerKey,
        signal: callerSignal,
      });
      callerSignal.throwIfAborted();
      return checkedResponse(local);
    }

    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort(
        new DOMException('Connection lookup timed out', 'TimeoutError'),
      );
    }, CONNECTION_LOOKUP_LIMITS.timeoutMillis);
    const signal = AbortSignal.any([callerSignal, deadline.signal]);
    try {
      const result = await this.run(input, prepared.run, signal, test);
      callerSignal.throwIfAborted();
      // Lookups that report unavailable items can retain results read before expiry.
      if (prepared.recover === undefined) signal.throwIfAborted();
      return checkedResponse(result);
    } catch (error: unknown) {
      callerSignal.throwIfAborted();
      if (error instanceof ConnectionNotFoundError) throw error;
      if (deadline.signal.aborted) {
        if (prepared.recover !== undefined)
          return checkedResponse(prepared.recover('provider_unavailable'));
        return throwApplicationError(applicationError('provider.unavailable'));
      }
      if (
        error instanceof ConnectionUnavailableError &&
        prepared.recover !== undefined
      )
        return checkedResponse(prepared.recover('connection_unavailable'));
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(
    input: LookupCommand,
    run: NonNullable<ReturnType<ConnectionLookup['prepare']>>['run'],
    signal: AbortSignal,
    test: ConnectionTest | undefined,
  ) {
    const { providerKey, lookup: key } = input.request;
    const { persistence, encryption, http } = this.dependencies;
    const access = {
      workspaceId: input.routeWorkspaceId,
      actorId: input.actor.actorId,
      connectionId: input.connectionId,
      signal,
    };
    const resolved =
      test?.resolved ??
      (await persistence.resolveConnectionLookupSecret({
        ...access,
        expectedProviderKey: providerKey,
        purpose: `${providerKey}.${key}.lookup`,
        ...(input.requestId === undefined
          ? {}
          : { requestId: input.requestId }),
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      }));
    const authType = resolved.connection.authType;
    const { secretVersionId } = resolved;
    let markTestDispatched = test?.beforeDispatch;
    const beforeDispatch = async () => {
      if (markTestDispatched !== undefined) {
        await markTestDispatched();
        markTestDispatched = undefined;
        return;
      }
      await persistence.assertConnectionLookupSecretCurrent({
        ...access,
        providerKey,
        authType,
        secretVersionId,
      });
    };
    signal.throwIfAborted();
    const secret = await encryption.open(
      resolved.sealed,
      {
        workspaceId: access.workspaceId,
        connectionId: access.connectionId,
        secretVersionId,
      },
      signal,
    );
    try {
      return await run({
        connection: {
          connectionId: access.connectionId,
          providerKey,
          authType,
          secret,
        },
        connectionId: access.connectionId,
        providerKey,
        signal,
        http: boundedLookupHttp(http, signal, beforeDispatch),
        refuse: () => new ConnectionSecretEncryptionError(),
      });
    } catch (error: unknown) {
      if (
        error instanceof ConnectionNotFoundError ||
        error instanceof ConnectionUnavailableError ||
        error instanceof ConnectionSecretEncryptionError ||
        (test !== undefined &&
          (error instanceof ProviderHttpError ||
            error instanceof ProviderCredentialRejectedError))
      )
        throw error;
      return throwApplicationError(applicationError('provider.unavailable'));
    }
  }
}

function checkedResponse(result: unknown) {
  const checked = connectionLookupResponseSchema.safeParse(result);
  if (
    !checked.success ||
    utf8ByteLength(JSON.stringify(checked.data)) >
      CONNECTION_LOOKUP_LIMITS.bytes ||
    new Set(checked.data.items.map(({ value }) => value)).size !==
      checked.data.items.length
  )
    return throwApplicationError(applicationError('provider.unavailable'));
  return checked.data;
}
