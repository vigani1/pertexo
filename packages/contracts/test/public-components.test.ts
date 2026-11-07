import { expect, it } from 'vitest';

import {
  buildPublicDocument,
  publicOpenApiDocument,
} from '../src/openapi/public.js';
import { workflowPortabilityOpenApiDocument } from '../src/openapi/workflows/portability.js';

it.each(['responses', 'schemas'])(
  'refuses conflicting %s components instead of choosing document order',
  (kind) => {
    const document = (description: string) => ({
      paths: {},
      components: { [kind]: { Example: { description } } },
    });
    expect(() =>
      buildPublicDocument([document('first'), document('different')]),
    ).toThrow(`Conflicting OpenAPI component ${kind}/Example`);
    expect(() =>
      buildPublicDocument([document('different'), document('first')]),
    ).toThrow(`Conflicting OpenAPI component ${kind}/Example`);
  },
);

it.each(['schemas', 'responses'])(
  'accepts identical %s regardless of object key order',
  (kind) => {
    expect(() =>
      buildPublicDocument([
        {
          paths: {},
          components: { [kind]: { Example: { type: 'string', minLength: 1 } } },
        },
        {
          paths: {},
          components: { [kind]: { Example: { minLength: 1, type: 'string' } } },
        },
      ]),
    ).not.toThrow();
  },
);

it.each(['403', '503'] as const)(
  'keeps workflow export %s semantics in the public document',
  (status) => {
    const path = '/v1/workspaces/{workspaceId}/workflows/{workflowId}/export';
    const standalone = workflowPortabilityOpenApiDocument;
    const reference = standalone.paths[path].post.responses[status].$ref;
    const publicReference = (
      publicOpenApiDocument.paths[path]?.post as {
        responses: Record<string, { $ref: string }>;
      }
    ).responses[status]?.$ref;
    const responses = (document: unknown) =>
      (document as { components: { responses: Record<string, unknown> } })
        .components.responses;
    expect(
      responses(publicOpenApiDocument)[
        publicReference?.split('/').at(-1) ?? ''
      ],
    ).toEqual(responses(standalone)[reference.split('/').at(-1) ?? '']);
  },
);
