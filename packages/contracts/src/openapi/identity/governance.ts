import { governanceRoutes } from '../../routes/identity/governance.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { auditQuerySchema } from '../../schemas/identity/governance.js';
import { projectContractSchema } from '../schema-projection.js';

const routes = Object.values(governanceRoutes);

export function governanceContractSchemas() {
  return {
    ...routeSchemas(routes),
    // The query as one object, for clients that build it before sending.
    AuditQuery: projectContractSchema('AuditQuery', auditQuerySchema, 'input'),
  };
}
export const governanceContractPaths = routePaths(routes);
