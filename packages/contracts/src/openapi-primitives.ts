import { z } from 'zod';

import { API_PROBLEM_MANIFEST } from './errors/api-problem.js';
import type { ApiProblemCode } from './errors/api-problem.js';

export function jsonSchema(schema: z.ZodType, io: 'input' | 'output') {
  return z.toJSONSchema(schema, { io, target: 'draft-2020-12' });
}

function schemaReference<Name extends string>(name: Name) {
  return { $ref: `#/components/schemas/${name}` as const };
}

export function responseReference<Name extends string>(name: Name) {
  return { $ref: `#/components/responses/${name}` as const };
}

export function jsonRequest<Name extends string>(name: Name) {
  return {
    required: true,
    content: { 'application/json': { schema: schemaReference(name) } },
  } as const;
}

export function jsonResponse<Name extends string>(
  description: string,
  name: Name,
) {
  return {
    description,
    content: { 'application/json': { schema: schemaReference(name) } },
  } as const;
}

export function problemResponse(description: string) {
  return {
    description,
    content: {
      'application/problem+json': { schema: schemaReference('ApiProblem') },
    },
  } as const;
}

export function manifestProblemResponse(status: number, code: ApiProblemCode) {
  const definition = API_PROBLEM_MANIFEST[code];
  if (definition.status !== status)
    throw new Error('Problem status does not match its manifest');
  return {
    description: definition.title,
    content: { 'application/problem+json': { schema: { type: 'object' } } },
    'x-pertexo-code': code,
    'x-pertexo-status': definition.status,
    'x-pertexo-type': definition.type,
  } as const;
}

export function uuidPathParameter(name: string, description?: string) {
  return pathParameter(name, jsonSchema(z.uuid(), 'input'), description);
}

export function simpleUuidPathParameter(name: string, description?: string) {
  return pathParameter(name, { type: 'string', format: 'uuid' }, description);
}

export function pathParameter(
  name: string,
  schema: Readonly<Record<string, unknown>>,
  description?: string,
) {
  return {
    name,
    in: 'path',
    required: true,
    ...(description === undefined ? {} : { description }),
    schema,
  } as const;
}

export function authenticatedComponents<
  Schemas extends Readonly<Record<string, unknown>>,
  Responses extends Readonly<Record<string, unknown>>,
>(schemas: Schemas, responses: Responses) {
  return {
    schemas,
    responses,
    securitySchemes: {
      cookieSession: {
        type: 'apiKey',
        in: 'cookie',
        name: 'pertexo_session',
      },
    },
  } as const;
}
