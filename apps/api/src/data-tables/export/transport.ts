import type { FastifyAdapter } from '@nestjs/platform-fastify';

/** Native form escaping can triple the bounded JSON request's wire size. */
export function registerDataTableExportTransport(
  adapter: FastifyAdapter,
): void {
  adapter.getInstance().addHook('onRoute', (route) => {
    if (
      route.method === 'POST' &&
      route.url === '/v1/workspaces/:workspaceId/data-tables/:tableId/export'
    )
      route.bodyLimit = 4 * 1024 * 1024;
  });
}
