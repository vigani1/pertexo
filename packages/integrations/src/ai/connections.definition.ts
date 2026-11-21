import { CONNECTION_CREDENTIALS_BOUNDS } from '@pertexo/contracts';
import { labelledChoice } from '@pertexo/node-sdk';
import { z } from 'zod';
import type { ConnectionDefinition } from '../providers/connection-definition.js';

export const MODEL_PROVIDER_KEY = 'ai';
export const MODEL_AUTH_TYPE = 'model_api_key';

const endpoint = labelledChoice({
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  vllm: 'vLLM',
}).meta({ title: 'Endpoint' });

const MODEL_BASE_URL_CHARACTERS = 2_048;
const baseUrl = z
  .url({ protocol: /^https?$/u })
  .max(MODEL_BASE_URL_CHARACTERS)
  .refine((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      url.username === '' &&
      url.password === '' &&
      /^https?:\/\//iu.test(value) &&
      !/[?#\\]/u.test(value) &&
      !/^https?:\/\/[^/]*@/iu.test(value)
    );
  }, 'Use an HTTP(S) API base URL without credentials, query or fragment')
  .meta({ title: 'API base URL' });

const apiKey = z
  .string()
  .min(1)
  .max(CONNECTION_CREDENTIALS_BOUNDS.apiKeyCharacters)
  .regex(/^[!-~]+$/u)
  .meta({ title: 'API key', secret: true });

const cloudBases = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com/v1',
} as const;

const credentialFields = { apiKey, type: z.literal(MODEL_AUTH_TYPE) };

export const modelCredentialSchema = z
  .discriminatedUnion('endpoint', [
    z.strictObject({
      ...credentialFields,
      endpoint: endpoint.extract(['openai', 'openrouter', 'anthropic']),
      baseUrl: baseUrl.optional(),
    }),
    z.strictObject({
      ...credentialFields,
      endpoint: endpoint.extract(['ollama', 'vllm']),
      baseUrl,
    }),
  ])
  .readonly();

export type ModelCredential = z.output<typeof modelCredentialSchema>;

export function modelEndpoint(
  credential: ModelCredential,
  path: 'models' | 'messages' | 'chat/completions',
) {
  const base =
    credential.endpoint === 'ollama' || credential.endpoint === 'vllm'
      ? credential.baseUrl
      : (credential.baseUrl ?? cloudBases[credential.endpoint]);
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/${path}`;
  return url.href;
}

const anthropicHeaders = { 'anthropic-version': '2023-06-01' } as const;

function modelAuth(credential: ModelCredential) {
  return credential.endpoint === 'anthropic'
    ? ({ kind: 'named_header', name: 'x-api-key', field: 'apiKey' } as const)
    : ({ kind: 'bearer', field: 'apiKey' } as const);
}

export function modelHeaders(
  credential: ModelCredential,
): Readonly<Record<string, string>> {
  const auth = modelAuth(credential);
  return auth.kind === 'named_header'
    ? { ...anthropicHeaders, [auth.name]: credential[auth.field] }
    : { authorization: `Bearer ${credential[auth.field]}` };
}

export const MODEL_CONNECTION = {
  authType: MODEL_AUTH_TYPE,
  presentation: {
    requirement: 'AI model connection',
    choice: MODEL_PROVIDER_KEY,
    pickerOrder: 20,
    name: 'AI',
    purpose: 'Run inference with a model API',
    credential: 'API key',
    savedCredential: 'API key',
    usedBy: 'AI Model steps',
    nameSuffix: 'AI',
  },
  schema: modelCredentialSchema,
  fields: z.strictObject({
    endpoint,
    apiKey,
    baseUrl: baseUrl
      .optional()
      .meta({ title: 'API base URL', omitEmpty: true }),
  }),
  auth: { resolve: modelAuth },
  test: {
    kind: 'http',
    method: 'GET',
    target: {
      resolve: (credential: ModelCredential) => ({
        url: modelEndpoint(credential, 'models'),
        headers: credential.endpoint === 'anthropic' ? anthropicHeaders : {},
      }),
    },
    success: {
      status: '2xx',
      json: {
        schema: z.object({ data: z.array(z.object({ id: z.string() })) }),
      },
    },
  },
  slot: { key: MODEL_AUTH_TYPE, primary: true },
} as const satisfies ConnectionDefinition<ModelCredential>;
