import { formUploadRoutes } from '../../routes/forms/uploads.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';

const routes = Object.values(formUploadRoutes);

export const formUploadSchemas = routeSchemas(routes);
export const formUploadPaths = routePaths(routes);
