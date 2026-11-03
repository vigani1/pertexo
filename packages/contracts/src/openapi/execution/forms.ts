import { formRoutes } from '../../routes/forms/forms.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';

const routes = Object.values(formRoutes);

export const formSchemas = routeSchemas(routes);
export const formPaths = routePaths(routes);
