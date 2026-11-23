import type { ParsedConnectionCredential } from '@pertexo/contracts';
import { isRecord } from '@pertexo/workflow-model';
import type { ConnectionDefinition } from './connection-definition.js';
import type { ProviderHttpRequest } from './http-client.js';

export function applyHttpAuth(
  url: string,
  auth: Exclude<ConnectionDefinition['auth'], { resolve: unknown }>,
  credential: ParsedConnectionCredential,
  invalidCredential: () => Error,
): Pick<ProviderHttpRequest, 'url' | 'headers'> &
  Readonly<{ sensitiveValues: readonly string[] }> {
  switch (auth.kind) {
    case 'header_map': {
      const fields: Readonly<Record<string, unknown>> = credential;
      const headers = fields[auth.field];
      if (!isRecord(headers)) throw invalidCredential();
      const entries = Object.entries(headers).map(([key, value]) => {
        if (typeof value !== 'string') throw invalidCredential();
        return [key, value] as const;
      });
      return {
        url,
        headers: Object.fromEntries(entries),
        sensitiveValues: entries.map(([, value]) => value),
      };
    }
    case 'named_header': {
      const value = credentialText(credential, auth.field, invalidCredential);
      return { url, headers: { [auth.name]: value }, sensitiveValues: [value] };
    }
    case 'query': {
      const value = credentialText(credential, auth.field, invalidCredential);
      const target = new URL(url);
      target.searchParams.set(auth.name, value);
      return { url: target.href, sensitiveValues: [value] };
    }
    case 'basic': {
      const username = credentialText(
        credential,
        auth.username,
        invalidCredential,
      );
      const password = credentialText(
        credential,
        auth.password,
        invalidCredential,
      );
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
      const token = credentialText(credential, auth.field, invalidCredential);
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
      throw invalidCredential();
  }
}

export function credentialText(
  credential: ParsedConnectionCredential,
  key: string,
  invalidCredential: () => Error,
): string {
  const fields: Readonly<Record<string, unknown>> = credential;
  const value = fields[key];
  if (typeof value !== 'string') throw invalidCredential();
  return value;
}
