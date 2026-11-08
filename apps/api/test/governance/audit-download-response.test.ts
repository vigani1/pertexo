import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerAuditDownloadResponse } from '../../src/governance/audit-download-response.js';
import { registerResponseSecurityHeaders } from '../../src/platform/http/response-security.js';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const requestId = 'support-123';

it.each([
  [
    401,
    'Sign in',
    '/login?returnTo=%2Fw%2Fbbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb%2Fsettings%2Faudit',
  ],
  [403, 'Choose a workspace', '/workspaces'],
  [404, 'Choose a workspace', '/workspaces'],
  [409, 'Return to Audit to try again', `/w/${workspaceId}/settings/audit`],
  [422, 'Return to Audit to try again', `/w/${workspaceId}/settings/audit`],
  [429, 'Return to Audit to try again', `/w/${workspaceId}/settings/audit`],
  [503, 'Return to Audit to try again', `/w/${workspaceId}/settings/audit`],
] as const)(
  'keeps a refused native export inert and recoverable (%i)',
  async (status, action, href) => {
    const app = Fastify();
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, body);
      },
    );
    registerResponseSecurityHeaders(app);
    registerAuditDownloadResponse(app);
    app.post(
      '/v1/workspaces/:workspaceId/governance/audit/export',
      (_request, reply) =>
        reply.code(status).type('application/problem+json').send({
          type: 'about:blank',
          title: '<script>unsafe problem title</script>',
          status,
          code: 'internal.unexpected',
          requestId,
          detail: '<script>unsafe problem detail</script>',
        }),
    );
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/governance/audit/export`,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'text/html',
        },
        payload: 'payload=%7B%7D',
      });
      expect(response.statusCode).toBe(status);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.headers['content-security-policy']).toBe(
        "default-src 'none'; frame-ancestors 'none'; sandbox",
      );
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.body).toContain(`<a href="${href}">${action}</a>`);
      expect(response.body).toContain('Error ID: <code>support-123</code>');
      expect(response.body).not.toContain('<img');
      expect(response.body).not.toContain('<script');
      expect(response.body).not.toContain('internal.unexpected');
    } finally {
      await app.close();
    }
  },
);
