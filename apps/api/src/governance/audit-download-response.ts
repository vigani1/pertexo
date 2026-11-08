import type { FastifyInstance } from 'fastify';
import { apiProblemSchema } from '@pertexo/contracts';
import { governanceRoutes } from '@pertexo/contracts/server';

const routePath = governanceRoutes.export.path.replace(
  '{workspaceId}',
  ':workspaceId',
);

/** A refused native download needs a page; JSON callers retain RFC 9457 responses. */
export function registerAuditDownloadResponse(instance: FastifyInstance): void {
  instance.addHook('onSend', (request, reply, payload, done) => {
    const native =
      request.method === 'POST' &&
      request.routeOptions.url === routePath &&
      request.headers['content-type']?.split(';', 1)[0] ===
        'application/x-www-form-urlencoded' &&
      request.headers.accept?.includes('text/html');
    if (!native || reply.statusCode < 400 || typeof payload !== 'string') {
      done(null, payload);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      done(null, payload);
      return;
    }
    const parsed = apiProblemSchema.safeParse(value);
    if (!parsed.success) {
      done(null, payload);
      return;
    }
    const params = governanceRoutes.export.params.safeParse(request.params);
    const auditPath = params.success
      ? `/w/${encodeURIComponent(params.data.workspaceId)}/settings/audit`
      : '/workspaces';
    const problem = parsed.data;
    let message =
      'The download could not be completed. Return to Audit and try exporting again. If it keeps failing, share the error ID with support.';
    let href = auditPath;
    let action = 'Return to Audit to try again';
    if (problem.status === 401) {
      message =
        'Your session ended. Sign in again before exporting the audit log.';
      href = `/login?returnTo=${encodeURIComponent(auditPath)}`;
      action = 'Sign in';
    } else if (problem.status === 403 || problem.status === 404) {
      message =
        'This export is no longer available to your account. Choose a workspace you can access, or ask its owner.';
      href = '/workspaces';
      action = 'Choose a workspace';
    } else if (problem.status === 429) {
      message =
        'Too many export requests. Wait a moment, then return to Audit and try again.';
    }
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'private, no-store');
    reply.header('referrer-policy', 'no-referrer');
    done(
      null,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Audit export couldn’t be downloaded · Pertexo</title></head><body><main><h1>Audit export couldn’t be downloaded</h1><p>${escapeHtml(message)}</p><p>Error ID: <code>${escapeHtml(problem.requestId)}</code></p><p><a href="${escapeHtml(href)}">${action}</a></p></main></body></html>`,
    );
  });
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ] ?? character,
  );
}
