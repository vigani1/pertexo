import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { collaborationRoutes } from '../../routes/workflows/collaboration.js';
const routes = Object.values(collaborationRoutes);
export function collaborationContractSchemas() {
  return routeSchemas(routes);
}
export const collaborationContractPaths = routePaths(routes);
