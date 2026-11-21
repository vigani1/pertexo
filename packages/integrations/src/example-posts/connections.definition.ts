import { CONNECTION_CREDENTIALS_BOUNDS } from '@pertexo/contracts';
import { z } from 'zod';
import type { ConnectionDefinition } from '../providers/connection-definition.js';

export const DEFAULT_POST_ID = 1;
export const EXAMPLE_POSTS_ORIGIN = 'https://example-posts.provider.test';
const login = { authType: 'example_posts_api_key' } as const;

const fields = {
  apiKey: z
    .string()
    .min(1)
    .max(CONNECTION_CREDENTIALS_BOUNDS.apiKeyCharacters)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .meta({
      title: 'Example Posts API key',
      secret: true,
      inputMaxLength: CONNECTION_CREDENTIALS_BOUNDS.apiKeyCharacters,
    }),
};

export const examplePostSchema = z.object({
  id: z.number().int().positive(),
  userId: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
});

export const EXAMPLE_POSTS_CONNECTION = {
  authType: login.authType,
  presentation: {
    requirement: 'Example Posts connection',
    choice: login.authType,
    pickerOrder: 100,
    name: 'Example Posts',
    purpose: 'Read example posts',
    credential: 'API key',
    savedCredential: 'API key',
    usedBy: 'Get post steps',
    nameSuffix: 'Example Posts',
    testCopy: {
      rejectionReason: 'invalid API key',
      rejectionHelp: 'Check the Example Posts API key and test again.',
    },
  },
  schema: z
    .strictObject({ type: z.literal(login.authType), ...fields })
    .readonly(),
  fields: z.strictObject(fields),
  auth: { kind: 'named_header', name: 'X-Api-Key', field: 'apiKey' },
  test: {
    kind: 'http',
    method: 'GET',
    target: `${EXAMPLE_POSTS_ORIGIN}/posts/${String(DEFAULT_POST_ID)}`,
    headers: { accept: 'application/json' },
    success: {
      status: '2xx',
      json: {
        schema: examplePostSchema,
        equals: { pointer: '/id', value: DEFAULT_POST_ID },
      },
    },
  },
  slot: { key: login.authType, primary: true },
} as const satisfies ConnectionDefinition;
