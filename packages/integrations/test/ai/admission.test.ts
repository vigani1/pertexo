import type { SchemaDocument } from '@pertexo/node-sdk';
import { compileModelOutputSchema } from '../../src/ai/model/output-schema.js';
import { describe, expect, it } from 'vitest';
import {
  MODEL_CONNECTION,
  modelEndpoint,
} from '../../src/ai/connections.definition.js';
import { MODEL_REGISTRATION } from '../../src/ai/model/model.definition.js';

const key = 'synthetic-key';
const { schema: credential, auth } = MODEL_CONNECTION;

describe('model connection admission', () => {
  it.each([
    ['openai', 'https://api.openai.com/v1/models'],
    ['openrouter', 'https://openrouter.ai/api/v1/models'],
    ['anthropic', 'https://api.anthropic.com/v1/models'],
    ['ollama', undefined],
    ['vllm', undefined],
  ])(
    'admits %s and preserves the configured API base path',
    (endpoint, cloudModelsUrl) => {
      const fields = { type: 'model_api_key', apiKey: key, endpoint };
      const defaultBase = credential.safeParse(fields);
      if (cloudModelsUrl === undefined) expect(defaultBase.success).toBe(false);
      else
        expect(modelEndpoint(credential.parse(fields), 'models')).toBe(
          cloudModelsUrl,
        );

      const custom = credential.parse({
        ...fields,
        baseUrl: 'http://model.example.test/local/v1/',
      });
      expect(modelEndpoint(custom, 'models')).toBe(
        'http://model.example.test/local/v1/models',
      );
      expect(auth.resolve(custom).kind).toBe(
        endpoint === 'anthropic' ? 'named_header' : 'bearer',
      );
      for (const baseUrl of [
        'ftp://model.example.test',
        'https://user:password@model.example.test',
        'https://@model.example.test',
        'https://model.example.test/?',
        'https://model.example.test/#',
      ])
        expect(credential.safeParse({ ...fields, baseUrl }).success).toBe(
          false,
        );
      expect(
        credential.safeParse({
          ...fields,
          baseUrl: custom.baseUrl,
          apiKey: { value: key },
        }).success,
      ).toBe(false);
      expect(
        credential.safeParse({
          ...fields,
          baseUrl: custom.baseUrl,
          apiKey: 'invalid\nkey',
        }).success,
      ).toBe(false);
    },
  );
});

describe('model catalog admission', () => {
  const { configSchema, inputSchema, outputSchema, manifest } =
    MODEL_REGISTRATION;
  const model = 'fake-model';
  const structure = { model, mode: 'structured' };

  it('admits both modes with a mapped prompt and distinct output envelopes', () => {
    expect(configSchema.safeParse({ model, mode: 'text' }).success).toBe(true);
    expect(
      configSchema.safeParse({ model, mode: 'text', prompt: 'misplaced' })
        .success,
    ).toBe(false);
    expect(configSchema.safeParse(structure).success).toBe(false);
    expect(
      configSchema.safeParse({ ...structure, outputSchema: { type: 'object' } })
        .success,
    ).toBe(true);
    expect(
      configSchema.safeParse({ model, mode: 'text', timeoutMillis: 60_001 })
        .success,
    ).toBe(false);
    expect(
      configSchema.safeParse({ model, mode: 'text', maxOutputTokens: 4_097 })
        .success,
    ).toBe(false);
    expect(inputSchema.safeParse({ prompt: 'mapped' }).success).toBe(true);
    expect(outputSchema.safeParse({ text: 'result' }).success).toBe(true);
    expect(outputSchema.safeParse({ data: { nested: true } }).success).toBe(
      true,
    );
    expect(outputSchema.safeParse({ data: [] }).success).toBe(false);
    expect(
      outputSchema.safeParse({ data: {}, text: 'ambiguous' }).success,
    ).toBe(false);
    expect(manifest).toMatchObject({
      definition: { key: 'ai.model', version: 1 },
      retryClass: 'safe',
      executorAbi: 2,
      connectionRequirements: ['model_api_key'],
    });
  });

  it('validates explicitly declared JSON keys even when the compiler treats them specially', () => {
    const schema: SchemaDocument = {
      type: 'object',
      properties: { ['__proto__']: { type: 'integer' } },
      required: ['__proto__'],
      additionalProperties: false,
    };
    const validate = compileModelOutputSchema(schema);
    expect(validate?.(JSON.parse('{"__proto__":1}'))).toBe(true);
    expect(validate?.(JSON.parse('{"__proto__":"1"}'))).toBe(false);
  });

  it('retains JSON object keys unchanged in the data envelope', () => {
    const data: unknown = JSON.parse('{"__proto__":{"count":1}}');
    expect(outputSchema.parse({ data })).toEqual({ data });
  });

  it('admits nested objects, arrays, required properties, primitives and enums', () => {
    expect(
      configSchema.safeParse({
        ...structure,
        outputSchema: {
          type: 'object',
          required: ['items'],
          additionalProperties: false,
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', enum: ['good', 'bad'] },
                  price: { type: 'number' },
                  count: { type: 'integer' },
                  active: { type: 'boolean' },
                  empty: { type: 'null' },
                },
              },
            },
          },
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    { type: 'array', items: { type: 'string' } },
    { type: 'object', properties: { value: { $ref: '#' } } },
    {
      type: 'object',
      properties: { value: { type: 'string', pattern: '.*' } },
    },
    { type: 'object', patternProperties: { '.*': { type: 'string' } } },
    { type: 'object', unevaluatedProperties: false },
    { type: 'object', properties: { value: { type: 'integer', default: 1 } } },
    { type: 'object', additionalProperties: { type: 'string' } },
    { type: 'object', properties: { value: { type: 'array' } } },
    { type: 'object', required: ['x', 'x'] },
    { type: 'object', enum: [{ value: 'é'.repeat(4_096) }] },
    {
      type: 'object',
      properties: {
        value: Array.from({ length: 16 }).reduce<unknown>(
          (items) => ({ type: 'array', items }),
          { type: 'number' },
        ),
      },
    },
  ])('rejects malformed, unsupported or oversized schema %j', (schema) => {
    expect(
      configSchema.safeParse({
        ...structure,
        outputSchema: schema,
      }).success,
    ).toBe(false);
  });
});
