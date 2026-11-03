import { notificationPreferenceRoutes } from '../../routes/identity/notification-preferences.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';

const routes = Object.values(notificationPreferenceRoutes);

export const notificationPreferenceSchemas = routeSchemas(routes);
export const notificationPreferencePaths = routePaths(routes);
