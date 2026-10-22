import { describe, expect, it } from 'vitest';
import {
  fillHttpTemplate,
  httpPlaceholders,
  httpTemplateProblem,
} from '../src/http-request/placeholders.js';
import { httpRequestConfigSchema } from '../src/http-request/validation.js';

const base = {
  method: 'GET',
  headers: {},
  timeoutMillis: 10_000,
  maxRedirects: 2,
  maxResponseBytes: 1_048_576,
  inlineResponseBytes: 65_536,
} as const;

describe('HTTP request placeholders', () => {
  it('finds each {name} after the origin and in header values, once', () => {
    expect(
      httpPlaceholders({
        url: 'https://api.example.test/orders/{orderId}/items?page={page}&again={orderId}',
        headers: { 'x-customer': 'id {customer}' },
      }),
    ).toEqual(['orderId', 'page', 'customer']);
  });

  it('percent-encodes values so they cannot add path segments or parameters', () => {
    expect(
      fillHttpTemplate(
        {
          url: 'https://api.example.test/orders/{orderId}?q={term}',
          headers: { 'x-customer': 'id {customer}' },
        },
        { orderId: '../admin/1 2', term: 'a&b=c', customer: 7 },
      ),
    ).toEqual({
      url: 'https://api.example.test/orders/..%2Fadmin%2F1%202?q=a%26b%3Dc',
      headers: { 'x-customer': 'id 7' },
    });
  });

  it('says which value is missing and refuses line breaks in headers', () => {
    const template = {
      url: 'https://api.example.test/orders/{orderId}',
      headers: { 'x-note': '{note}' },
    };
    expect(() => fillHttpTemplate(template, { note: 'x' })).toThrow(
      'Map a value for {orderId}.',
    );
    expect(() =>
      fillHttpTemplate(template, { orderId: 1, note: 'a\r\nInjected: 1' }),
    ).toThrow(/header x-note/u);
  });

  it('keeps the origin fixed in settings', () => {
    expect(
      httpTemplateProblem({
        url: 'https://{tenant}.example.test/orders',
        headers: {},
      }),
    ).toMatch(/origin stays fixed/u);
    expect(
      httpRequestConfigSchema.safeParse({
        ...base,
        url: 'https://{tenant}.example.test/orders',
      }).success,
    ).toBe(false);
    expect(
      httpRequestConfigSchema.safeParse({
        ...base,
        url: 'https://api.example.test/orders/{orderId}?page={page}',
        headers: { 'x-customer': '{customer}' },
      }).success,
    ).toBe(true);
  });
});

it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty'])(
  'requires an own placeholder value for %s',
  (name) => {
    const template = {
      url: `https://api.example.test/{${name}}`,
      headers: { 'x-value': `{${name}}` },
    };
    expect(() => fillHttpTemplate(template, {})).toThrow(
      `Map a value for {${name}}.`,
    );
    expect(fillHttpTemplate(template, { [name]: 'supplied value' })).toEqual({
      url: 'https://api.example.test/supplied%20value',
      headers: { 'x-value': 'supplied value' },
    });
  },
);
