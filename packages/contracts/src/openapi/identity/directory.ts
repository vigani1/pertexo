import { directoryRoutes } from '../../routes/identity/directory.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
const routes = Object.values(directoryRoutes);
export const directoryContractSchemas = routeSchemas(routes);
export const directoryContractPaths = routePaths(routes);
