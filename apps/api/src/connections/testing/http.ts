import { HttpStatus } from '@nestjs/common';
import type {
  ConnectionTestRequest,
  ParsedConnectionCredential,
} from '@pertexo/contracts';
import { ConnectionSecretEncryptionError } from '@pertexo/secrets/server';
import { isRecord, type ConnectionTestOutcome } from '@pertexo/workflow-model';
import { connectionTestProviderKey } from '../management/connection-serialization.js';
import type { ConnectionHttpClient } from '../ports.js';
import type { decodeCredential } from './credentials.js';
import { responseOutcome } from './outcomes.js';
import type { TestConnectionCommand } from './test-connection.js';

type DecodedCredential = ReturnType<typeof decodeCredential>;
type HttpRecipe = Extract<DecodedCredential['recipe'], { kind: 'http' }>;
type HttpResponse = Awaited<ReturnType<ConnectionHttpClient['execute']>>;

export async function testHttpConnection(
  client: ConnectionHttpClient,
  input: Readonly<{
    request: ConnectionTestRequest;
    credential: ParsedConnectionCredential;
    recipe: HttpRecipe;
    auth: DecodedCredential['auth'];
    command: Pick<TestConnectionCommand, 'connectionId' | 'idempotencyKey'>;
    timeoutMillis: number;
    maxRedirects: number;
    maxResponseBytes: number;
    signal: AbortSignal;
    beforeDispatch(): Promise<void>;
  }>,
): Promise<ConnectionTestOutcome> {
  const {
    request,
    credential,
    recipe,
    auth,
    command,
    maxRedirects,
    ...limits
  } = input;
  const url =
    recipe.target === 'entered_url' && 'url' in request
      ? request.url
      : recipe.target;
  if (url === 'entered_url') throw new ConnectionSecretEncryptionError();
  const applied = applyAuth(url, auth, credential);
  const headers = { ...recipe.headers, ...applied.headers };
  const body = recipe.body;
  if (body !== undefined)
    headers[body.idempotencyHeader] = connectionTestProviderKey(
      command.connectionId,
      command.idempotencyKey,
    );
  const bytes =
    body === undefined
      ? undefined
      : new TextEncoder().encode(
          JSON.stringify({
            ...body.fields,
            ...Object.fromEntries(
              Object.entries(body.credentialFields).map(([key, field]) => [
                key,
                credentialText(credential, field),
              ]),
            ),
          }),
        );
  try {
    const response = await client.execute({
      ...limits,
      ...applied,
      headers,
      method: recipe.method,
      maxRedirects:
        recipe.target === 'entered_url' && auth.kind !== 'query'
          ? maxRedirects
          : 0,
      ...(bytes === undefined ? {} : { body: bytes }),
    });
    try {
      return httpTestOutcome(recipe, response);
    } finally {
      response.body.fill(0);
    }
  } finally {
    bytes?.fill(0);
  }
}

function applyAuth(
  url: string,
  auth: DecodedCredential['auth'],
  credential: ParsedConnectionCredential,
): Pick<
  Parameters<ConnectionHttpClient['execute']>[0],
  'url' | 'headers' | 'sensitiveValues'
> {
  switch (auth.kind) {
    case 'header_map': {
      const fields: Readonly<Record<string, unknown>> = credential;
      const headers = fields[auth.field];
      if (!isRecord(headers)) throw new ConnectionSecretEncryptionError();
      const entries = Object.entries(headers).map(([key, value]) => {
        if (typeof value !== 'string')
          throw new ConnectionSecretEncryptionError();
        return [key, value] as const;
      });
      return {
        url,
        headers: Object.fromEntries(entries),
        sensitiveValues: entries.map(([, value]) => value),
      };
    }
    case 'named_header': {
      const value = credentialText(credential, auth.field);
      return { url, headers: { [auth.name]: value }, sensitiveValues: [value] };
    }
    case 'query': {
      const value = credentialText(credential, auth.field);
      const target = new URL(url);
      target.searchParams.set(auth.name, value);
      return { url: target.href, sensitiveValues: [value] };
    }
    case 'basic': {
      const username = credentialText(credential, auth.username);
      const password = credentialText(credential, auth.password);
      const bytes = Buffer.from(`${username}:${password}`);
      const encoded = bytes.toString('base64');
      bytes.fill(0);
      return {
        url,
        headers: { authorization: `Basic ${encoded}` },
        sensitiveValues: [username, password, encoded],
      };
    }
    case 'bearer': {
      const token = credentialText(credential, auth.field);
      return {
        url,
        headers: { authorization: `Bearer ${token}` },
        sensitiveValues: [token],
      };
    }
    case 'oauth2':
    case 'postgres':
    case 'signing':
    case 'smtp':
      throw new ConnectionSecretEncryptionError();
  }
}

function credentialText(
  credential: ParsedConnectionCredential,
  key: string,
): string {
  const fields: Readonly<Record<string, unknown>> = credential;
  const value = fields[key];
  if (typeof value !== 'string') throw new ConnectionSecretEncryptionError();
  return value;
}

function httpTestOutcome(
  recipe: HttpRecipe,
  response: HttpResponse,
): ConnectionTestOutcome {
  const outcome = responseOutcome(
    response.status,
    recipe.credentialRejection !== false,
  );
  if (!outcome.ok) return outcome;
  const { json, reportStatus } = recipe.success;
  const success = {
    ok: true,
    httpStatus: reportStatus ?? response.status,
  } as const;
  if (json === undefined) return success;

  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(response.body),
    );
  } catch {
    return INVALID_RESPONSE;
  }
  if (json.schema?.safeParse(value).success === false) return INVALID_RESPONSE;
  if (json.equals === undefined) return success;
  const actual = readJsonPointer(value, json.equals.pointer);
  if (actual === undefined) return INVALID_RESPONSE;
  if (actual === json.equals.value) return success;
  return rejectedJsonOutcome(value, success.httpStatus, json.rejection);
}

const INVALID_RESPONSE = Object.freeze({
  ok: false,
  httpStatus: null,
  errorCode: 'connection.provider_invalid_response',
  reauthorizationRequired: false,
} as const);

function rejectedJsonOutcome(
  value: unknown,
  httpStatus: number,
  rule: NonNullable<HttpRecipe['success']['json']>['rejection'],
): ConnectionTestOutcome {
  let errorCode = 'connection.provider_rejected';
  let reauthorizationRequired = false;
  if (rule !== undefined) {
    const code = readJsonPointer(value, rule.pointer);
    if (typeof code !== 'string') return INVALID_RESPONSE;
    if (code === rule.rateLimited)
      return responseOutcome(HttpStatus.TOO_MANY_REQUESTS);
    if (Object.hasOwn(rule.reauthorization, code)) {
      errorCode = rule.reauthorization[code] ?? errorCode;
      reauthorizationRequired = true;
    }
  }
  return { ok: false, httpStatus, errorCode, reauthorizationRequired };
}

function readJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  if (!pointer.startsWith('/')) return undefined;
  let current = value;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return undefined;
      const items: readonly unknown[] = current;
      current = items[Number(key)];
    } else if (isRecord(current) && Object.hasOwn(current, key)) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}
