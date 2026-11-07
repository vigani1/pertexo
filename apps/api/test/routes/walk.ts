import { usesPrivateAuthentication } from '../../src/platform/http/private-response-cache.guard.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  REDIRECT_METADATA,
} from '@nestjs/common/constants.js';
import { RequestMethod, type Type } from '@nestjs/common';

import { AutomationAuthenticationGuard } from '../../src/authentication/automation/guard.js';
import {
  RATE_LIMIT_EXEMPT,
  RATE_LIMIT_METADATA,
} from '../../src/platform/rate-limit/metadata.js';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../src/workspaces/http/guards.js';

export type WalkedRoute = Readonly<{
  method: string;
  path: string;
  status: number;
  signIn: 'session' | 'session_or_token' | 'none';
  privateCache: boolean;
  capability: string | undefined;
  csrf: boolean;
  rateClass: string | undefined;
  source: string;
}>;

const SOURCE = fileURLToPath(new URL('../../src/', import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function guardsOf(target: object): readonly Type[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as Type[];
}

function rateClass(handler: object, controller: object): string | undefined {
  const declared = (Reflect.getMetadata(RATE_LIMIT_METADATA, handler) ??
    Reflect.getMetadata(RATE_LIMIT_METADATA, controller)) as
    string | symbol | undefined;
  return declared === RATE_LIMIT_EXEMPT ? 'exempt' : (declared as string);
}

function asPaths(value: unknown): readonly string[] {
  return Array.isArray(value) ? (value as string[]) : [value as string];
}

function joined(prefix: string, suffix: string): string {
  const parts = [prefix, suffix]
    .flatMap((part) => part.split('/'))
    .filter((part) => part !== '');
  return `/${parts.join('/')}`.replaceAll(/:(\w+)/gu, '{$1}');
}

function signInOf(guards: readonly Type[]): WalkedRoute['signIn'] {
  if (guards.includes(AutomationAuthenticationGuard)) return 'session_or_token';
  return guards.includes(SessionAuthenticationGuard) ? 'session' : 'none';
}

function successStatus(handler: object, method: string): number {
  const redirect = Reflect.getMetadata(REDIRECT_METADATA, handler) as
    Readonly<{ statusCode?: number }> | undefined;
  if (redirect?.statusCode !== undefined) return redirect.statusCode;
  const declared = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as
    number | undefined;
  return declared ?? (method === 'POST' ? 201 : 200);
}

function routesOf(controller: Type, source: string): WalkedRoute[] {
  const prefixes = asPaths(Reflect.getMetadata(PATH_METADATA, controller));
  const classGuards = guardsOf(controller);
  return Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
    const handler = Reflect.get(controller.prototype, name) as object;
    if (typeof handler !== 'function') return [];
    const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as
      RequestMethod | undefined;
    if (requestMethod === undefined) return [];
    const method = RequestMethod[requestMethod];
    const guards = [...classGuards, ...guardsOf(handler)];
    const capability = guards
      .map((guard) => Reflect.get(guard, 'capability') as string | undefined)
      .find((value) => value !== undefined);
    return prefixes.flatMap((prefix) =>
      asPaths(Reflect.getMetadata(PATH_METADATA, handler)).map(
        (suffix): WalkedRoute => ({
          method,
          path: joined(prefix, suffix),
          status: successStatus(handler, method),
          signIn: signInOf(guards),
          privateCache: usesPrivateAuthentication(controller, handler),
          capability,
          csrf: guards.includes(CsrfProtectionGuard),
          rateClass: rateClass(handler, controller),
          source,
        }),
      ),
    );
  });
}

/** Every Nest route, read from the decorators on every controller in the source. */
export async function walkRoutes(): Promise<readonly WalkedRoute[]> {
  // A feature that's off answers its routes with a stub, which has no route facts.
  const files = sourceFiles(SOURCE).filter(
    (file) =>
      !file.includes('unavailable') &&
      readFileSync(file, 'utf8').includes('@Controller('),
  );
  const routes: WalkedRoute[] = [];
  for (const file of files) {
    const exports = (await import(file)) as Readonly<Record<string, unknown>>;
    for (const value of Object.values(exports))
      if (
        typeof value === 'function' &&
        !value.name.startsWith('Unconfigured') &&
        Reflect.hasMetadata(PATH_METADATA, value)
      )
        routes.push(...routesOf(value as Type, relative(SOURCE, file)));
  }
  return routes.toSorted(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.method.localeCompare(right.method),
  );
}
