import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { browserFrom, setCookie } from './api/cookies.js';

describe('browser cookies from authentication responses', () => {
  it('applies same-name replacements in header order for session and CSRF cookies', async () => {
    const app = Fastify();
    app.get('/', (_request, reply) =>
      reply
        .header('set-cookie', [
          'pertexo_session=revoked; Path=/; HttpOnly',
          'pertexo_csrf=old-proof; Path=/',
          'pertexo_session=successor; Path=/; HttpOnly',
          'pertexo_csrf=final%2Fproof; Path=/',
        ])
        .send(),
    );
    try {
      expect(browserFrom(await app.inject('/'))).toEqual({
        session: 'successor',
        csrf: 'final/proof',
        cookie: 'pertexo_session=successor; pertexo_csrf=final%2Fproof',
      });
    } finally {
      await app.close();
    }
  });

  it('does not resurrect a cookie cleared by a later header', async () => {
    const app = Fastify();
    app.get('/', (_request, reply) =>
      reply
        .header('set-cookie', [
          'pertexo_session=revoked; Path=/; HttpOnly',
          'pertexo_session=; Path=/; Max-Age=0; HttpOnly',
        ])
        .send(),
    );
    try {
      const response = await app.inject('/');
      expect(() => setCookie(response, 'pertexo_session')).toThrow(
        'pertexo_session cookie was not returned',
      );
    } finally {
      await app.close();
    }
  });
});
