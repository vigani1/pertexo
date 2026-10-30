import 'reflect-metadata';

import { RequestMethod } from '@nestjs/common';
import {
  CONTROLLER_WATERMARK,
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants.js';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../../src/workspaces/index.js';

const sourceRoot = fileURLToPath(new URL('../../../src/', import.meta.url));

// Every source module that declares a controller, found by walking src, so a
// new controller cannot escape the rule below.
let sourceModules: readonly Record<string, unknown>[] = [];
beforeAll(async () => {
  sourceModules = await Promise.all(
    sourceFiles(sourceRoot)
      .filter((file) => readFileSync(file, 'utf8').includes('@Controller('))
      .map(
        (file) =>
          import(pathToFileURL(file).href) as Promise<Record<string, unknown>>,
      ),
  );
});

const READ_METHODS = new Set<RequestMethod>([
  RequestMethod.GET,
  RequestMethod.HEAD,
  RequestMethod.OPTIONS,
]);

// CSV downloads are plain form posts: the controller reads the CSRF token from
// the form body and checks it itself, before any work.
const BODY_TOKEN_ROUTES = new Set([
  'DataTablesController.exportCsv',
  'GovernanceController.exportCsv',
]);

type Route = Readonly<{
  name: string;
  guards: readonly unknown[];
  method: RequestMethod;
}>;

describe('session mutations', () => {
  it('finds the controllers it checks', () => {
    // A broken glob would make the rule below pass vacuously.
    expect(controllers().length).toBeGreaterThan(40);
    expect(sessionMutations().length).toBeGreaterThan(100);
  });

  it('require CSRF protection on every non-read route behind a browser session', () => {
    const unprotected = sessionMutations()
      .filter(
        (route) =>
          !route.guards.includes(CsrfProtectionGuard) &&
          !BODY_TOKEN_ROUTES.has(route.name),
      )
      .map((route) => route.name);

    expect(unprotected).toEqual([]);
  });
});

function sessionMutations(): readonly Route[] {
  return controllers()
    .flatMap(routesOf)
    .filter(
      (route) =>
        !READ_METHODS.has(route.method) &&
        route.guards.includes(SessionAuthenticationGuard),
    );
}

function controllers(): readonly (abstract new (...args: never) => unknown)[] {
  const found = new Set<abstract new (...args: never) => unknown>();
  for (const exports of sourceModules)
    for (const value of Object.values(exports))
      if (
        typeof value === 'function' &&
        Reflect.hasOwnMetadata(PATH_METADATA, value) &&
        Reflect.hasOwnMetadata(CONTROLLER_WATERMARK, value)
      )
        found.add(value as abstract new (...args: never) => unknown);
  return [...found];
}

function routesOf(
  controller: abstract new (...args: never) => unknown,
): readonly Route[] {
  const classGuards = guardsOf(controller);
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype).flatMap((property) => {
    const handler = prototype[property];
    if (typeof handler !== 'function') return [];
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as
      RequestMethod | undefined;
    if (method === undefined) return [];
    return [
      {
        name: `${controller.name}.${property}`,
        guards: [...classGuards, ...guardsOf(handler)],
        method,
      },
    ];
  });
}

function guardsOf(target: object): readonly unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as unknown[];
}

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && extname(entry.name) === '.ts' ? [path] : [];
  });
}
