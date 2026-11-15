import type { FastifyAdapter } from '@nestjs/platform-fastify';

/** The largest export request: its filters and column choices, not the data. */
const EXPORT_REQUEST_MAX_BYTES = 4 * 1_024 * 1_024;

/** Native form escaping can triple the bounded JSON request's wire size. */
export function registerDataTableExportTransport(
  adapter: FastifyAdapter,
): void {
  adapter.getInstance().addHook('onRoute', (route) => {
    if (
      route.method === 'POST' &&
      route.url === '/v1/workspaces/:workspaceId/data-tables/:tableId/export'
    )
      route.bodyLimit = EXPORT_REQUEST_MAX_BYTES;
  });
}
