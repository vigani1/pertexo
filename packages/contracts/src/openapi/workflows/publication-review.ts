import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { publicationReviewRoutes } from '../../routes/workflows/reviews.js';

const routes = Object.values(publicationReviewRoutes);

export function publicationReviewContractSchemas() {
  return routeSchemas(routes);
}
export const publicationReviewContractPaths = routePaths(routes);
