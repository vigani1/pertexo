import { CONTRACT_ARTIFACTS } from '@pertexo/contracts/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { walkRoutes, type WalkedRoute } from './walk.js';

// Each list has a reason, and growing one is a decision a reviewer sees.
const PUBLIC_ROUTES = new Set([
  // Probes and browser preflight.
  'GET /health/live',
  'GET /health/ready',
  'OPTIONS /hooks/{endpointKey}',
  'OPTIONS /hooks/{endpointKey}/test',
  // The provider returns here; the state in the query is the credential.
  'GET /v1/connections/oauth2/callback',
  // A public form's capability is its authority.
  'GET /v1/forms/{publicId}',
  'POST /v1/forms/{publicId}/submit',
  'POST /v1/forms/{publicId}/uploads',
  'POST /v1/forms/{publicId}/uploads/{uploadId}/finalize',
  // The person accepting may not have an account yet; a bound cookie carries it.
  'DELETE /v1/invitation-acceptance',
  'GET /v1/invitation-acceptance',
  'POST /v1/invitation-acceptance/resolve',
  // A link in an email, which a mail client may follow signed out.
  'POST /v1/notifications/unsubscribe',
  'GET /v1/notifications/unsubscribe/one-click',
  'POST /v1/notifications/unsubscribe/one-click',
]);
const UNDOCUMENTED = new Set([
  'GET /health/live',
  'GET /health/ready',
  'OPTIONS /hooks/{endpointKey}',
  'OPTIONS /hooks/{endpointKey}/test',
]);
// A native form POST carries its token in the body, so the handler checks it.
const CSRF_IN_THE_HANDLER = new Set([
  'POST /v1/workspaces/{workspaceId}/data-tables/{tableId}/export',
  'POST /v1/workspaces/{workspaceId}/governance/audit/export',
]);
// Raw bytes or someone else's protocol: Fastify routes, documented by hand.
const OUTSIDE_NEST = /^[A-Z]+ \/(?:hooks\/|v1\/auth\/)/u;

const key = ({ method, path }: WalkedRoute) => `${method} ${path}`;

function documentedOperations(): ReadonlyMap<string, readonly string[]> {
  const operations = new Map<string, readonly string[]>();
  for (const { fileName, content } of CONTRACT_ARTIFACTS) {
    if (!fileName.endsWith('.openapi.json')) continue;
    const { paths } = JSON.parse(content) as Readonly<{
      paths: Readonly<
        Record<
          string,
          Readonly<Record<string, Readonly<{ responses: object }>>>
        >
      >;
    }>;
    for (const [path, methods] of Object.entries(paths))
      for (const [method, { responses }] of Object.entries(methods))
        operations.set(
          `${method.toUpperCase()} ${path}`,
          Object.keys(responses),
        );
  }
  return operations;
}

describe('every API route against its rules and its document', () => {
  let routes: readonly WalkedRoute[];
  const documented = documentedOperations();

  beforeAll(async () => {
    routes = await walkRoutes();
  }, 120_000);

  it('finds the routes', () => {
    expect(routes.length).toBeGreaterThan(200);
  });

  it('gives each a rate class', () => {
    expect(
      routes.filter(({ rateClass }) => rateClass === undefined).map(key),
    ).toEqual([]);
  });

  it('asks for sign-in unless it is listed as public', () => {
    expect(
      routes
        .filter(({ signIn }) => signIn === 'none')
        .map(key)
        .filter((route) => !PUBLIC_ROUTES.has(route)),
    ).toEqual([]);
  });

  it('has CSRF on a signed-in route that changes something', () => {
    expect(
      routes
        .filter(
          ({ method, signIn, csrf }) =>
            method !== 'GET' && signIn !== 'none' && !csrf,
        )
        .map(key)
        .filter((route) => !CSRF_IN_THE_HANDLER.has(route)),
    ).toEqual([]);
  });

  it('has a capability check on a signed-in workspace route', () => {
    expect(
      routes
        .filter(
          ({ path, signIn, capability }) =>
            path.includes('{workspaceId}') &&
            signIn !== 'none' &&
            capability === undefined,
        )
        .map(key),
    ).toEqual([]);
  });

  it('documents each route, with the status it answers', () => {
    expect(
      routes
        .filter((route) => !UNDOCUMENTED.has(key(route)))
        .filter(
          (route) =>
            documented.get(key(route))?.includes(String(route.status)) !== true,
        )
        .map((route) => `${key(route)} ${String(route.status)}`),
    ).toEqual([]);
  });

  it('has a handler for each documented operation', () => {
    const served = new Set(routes.map(key));
    expect(
      [...documented.keys()].filter(
        (operation) => !served.has(operation) && !OUTSIDE_NEST.test(operation),
      ),
    ).toEqual([]);
  });

  // The diff a reviewer reads: 73,000 lines of OpenAPI can't show a route losing a guard.
  it('matches the committed route table', async () => {
    const table = routes.map((route) =>
      [
        route.method,
        route.path,
        route.status,
        route.signIn,
        route.capability ?? '-',
        route.csrf ? 'csrf' : '-',
        route.rateClass ?? '-',
      ].join(' '),
    );
    await expect(`${table.join('\n')}\n`).toMatchFileSnapshot(
      './route-table.txt',
    );
  });
});
