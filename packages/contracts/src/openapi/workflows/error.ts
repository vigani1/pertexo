import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { workflowSettingsRoutes as settings } from '../../routes/workflows/settings.js';

const routes = [
  settings.errorTargets,
  settings.errorWorkflow,
  settings.updateErrorWorkflow,
];

export function workflowErrorContractSchemas() {
  return routeSchemas(routes);
}
export const workflowErrorContractPaths = routePaths(routes);
