import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { promotionRoutes } from '../../routes/workflows/promotions.js';

const routes = Object.values(promotionRoutes);

export function workflowPromotionContractSchemas() {
  return routeSchemas(routes);
}
export const workflowPromotionContractPaths = routePaths(routes);
