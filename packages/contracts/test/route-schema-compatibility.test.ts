import { expect, it } from 'vitest';
import { z } from 'zod';
import * as routes from '../src/server.js';
import * as contracts from '../src/index.js';
import type { AnyRoute } from '../src/routes/define.js';

const futureKey = '__future_contract_metadata__';

// MCP owns this envelope and clients can send additive metadata such as
// _meta keys and clientInfo fields. Keep only the fields Pertexo reads.
// https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
const mcpEnvelope = contracts.mcpRpcRequestSchema;

const declaredRoutes = Object.values(routes).flatMap((group) =>
  typeof group === 'object' ? Object.values(group).filter(isRoute) : [],
);

it('covers the exported route catalog', () => {
  expect(declaredRoutes.length).toBeGreaterThan(200);
  expect(
    declaredRoutes.some((route) => route.operationId === 'renameWorkflow'),
  ).toBe(true);
});

for (const route of declaredRoutes) {
  for (const success of [route.success, ...(route.otherSuccesses ?? [])]) {
    if ('body' in success)
      it(`${route.operationId} ${String(success.status)} strips additive response members at every object level`, () => {
        expect(policyViolations(success.body.schema, 'strip')).toEqual([]);
      });
  }
  for (const [name, schema] of Object.entries({
    params: route.params,
    query: route.query,
    headers: route.headers,
    body: route.body?.schema,
  })) {
    if (schema !== undefined)
      it(`${route.operationId} ${name} follows the request member policy at every object level`, () => {
        expect(
          policyViolations(schema, schema === mcpEnvelope ? 'strip' : 'reject'),
        ).toEqual([]);
      });
  }
}

for (const [name, schema] of Object.entries(contracts)) {
  if (name === 'mcpRpcRequestSchema') continue;
  let direction: 'response' | 'request' | undefined;
  if (/(Response|Summary|Problem)Schema$/u.test(name)) direction = 'response';
  else if (name.endsWith('RequestSchema')) direction = 'request';
  if (direction !== undefined && schema instanceof z.ZodType)
    it(`${name} follows the public ${direction} member policy recursively`, () => {
      expect(
        policyViolations(schema, direction === 'request' ? 'reject' : 'strip'),
      ).toEqual([]);
    });
}

it('mcpRpcRequestSchema strips additive MCP envelope members recursively', () => {
  expect(policyViolations(mcpEnvelope, 'strip')).toEqual([]);
});

function policyViolations(root: z.ZodType, policy: 'reject' | 'strip') {
  const violations: string[] = [];
  const seen = new Set<z.ZodType>();
  const containers = new WeakSet<object>();
  const visit = (schema: z.ZodType, path: string) => {
    if (seen.has(schema)) return;
    seen.add(schema);
    if (schema instanceof z.ZodObject) {
      // Isolate the declared object's unknown-member policy from required fields,
      // domain refinements and transforms needing a complete valid payload.
      const probe = z.core.clone(schema, {
        ...schema._zod.def,
        shape: {},
        checks: [],
      });
      const result = probe.safeParse({ [futureKey]: true });
      const unknownIssue = result.success
        ? undefined
        : result.error.issues.find(
            (issue) =>
              issue.code === 'unrecognized_keys' &&
              issue.keys.includes(futureKey),
          );
      if (policy === 'reject') {
        if (unknownIssue === undefined)
          violations.push(`${path}: unknown request member was not rejected`);
      } else {
        if (unknownIssue !== undefined)
          violations.push(`${path}: unknown member was rejected`);
        if (result.success && Object.hasOwn(result.data, futureKey))
          violations.push(`${path}: unknown member was retained`);
      }
    }
    const def = schema._zod.def;
    if (schema instanceof z.ZodLazy)
      visitValue(schema.unwrap(), `${path}.lazy`);
    for (const [key, value] of Object.entries(def)) {
      if (key !== 'getter') visitValue(value, `${path}.${key}`);
    }
  };
  const visitValue = (value: unknown, path: string) => {
    if (value instanceof z.ZodType) visit(value, path);
    else if (Array.isArray(value))
      value.forEach((item: unknown, index) => {
        visitValue(item, `${path}.${String(index)}`);
      });
    else if (
      value !== null &&
      typeof value === 'object' &&
      !containers.has(value)
    ) {
      containers.add(value);
      for (const [key, child] of Object.entries(value))
        visitValue(child, `${path}.${key}`);
    }
  };
  visit(root, 'schema');
  return violations;
}

function isRoute(value: unknown): value is AnyRoute {
  return (
    value !== null &&
    typeof value === 'object' &&
    'operationId' in value &&
    'success' in value
  );
}

it('strips additive metadata from the temporarily-unavailable 503 problem', () => {
  const code = 'request.temporarily_unavailable';
  const entry = contracts.API_PROBLEM_MANIFEST[code];
  const problem = {
    type: entry.type,
    title: entry.title,
    status: 503,
    code,
    requestId: 'main-replay',
    errors: [{ path: '$', code: 'busy', message: 'Try again' }],
  };
  expect(entry.status).toBe(503);
  expect(
    contracts.apiProblemSchema.parse({
      ...problem,
      futureMetadata: true,
      errors: problem.errors.map((error) => ({
        ...error,
        futureMetadata: true,
      })),
    }),
  ).toEqual(problem);
});
