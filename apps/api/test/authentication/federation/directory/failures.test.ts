import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { DirectoryError } from '@pertexo/core/tenant-access';
import { directoryFailure } from '../../../../src/authentication/federation/provisioning/transport/errors.js';

it.each([
  {
    error: { code: 'FST_ERR_CTP_BODY_TOO_LARGE' },
    status: 413,
    type: 'tooMany',
  },
  {
    error: Object.assign(new SyntaxError('private'), {
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    }),
    status: 413,
    type: 'tooMany',
  },
  {
    error: { code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' },
    status: 415,
    type: undefined,
  },
  {
    error: Object.assign(new SyntaxError('private'), {
      code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE',
    }),
    status: 415,
    type: undefined,
  },
  {
    error: { code: 'FST_ERR_CTP_EMPTY_JSON_BODY' },
    status: 400,
    type: 'invalidSyntax',
  },
  {
    error: { code: 'FST_ERR_CTP_INVALID_JSON_BODY' },
    status: 400,
    type: 'invalidSyntax',
  },
  { error: new SyntaxError('private'), status: 400, type: 'invalidSyntax' },
  {
    error: Object.assign(new SyntaxError('private'), { code: 'unknown' }),
    status: 400,
    type: 'invalidSyntax',
  },
  {
    error: { code: 'unknown', message: 'private' },
    status: 500,
    type: undefined,
  },
  { error: null, status: 500, type: undefined },
  { error: 'private', status: 500, type: undefined },
  {
    error: Object.assign(new DirectoryError('unauthorized'), {
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    }),
    status: 401,
    type: undefined,
  },
])(
  'keeps directory failure priority and privacy: $status/$type',
  async ({ error, status, type }) => {
    const app = Fastify();
    app.get('/failure', (_request, reply) => {
      directoryFailure(reply, error);
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/failure' });
      expect(response.statusCode).toBe(status);
      expect(response.headers['content-type']).toContain(
        'application/scim+json',
      );
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json<{ scimType?: string }>().scimType).toBe(type);
      expect(response.body).not.toContain('private');
      if (status === 401)
        expect(response.headers['www-authenticate']).toBe('Bearer');
    } finally {
      await app.close();
    }
  },
);
