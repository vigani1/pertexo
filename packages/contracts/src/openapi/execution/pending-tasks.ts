import { pendingTaskRoutes } from '../../routes/execution/pending-tasks.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import {
  pendingTaskDetailSchema,
  pendingTaskSummarySchema,
} from '../../schemas/execution/pending-tasks.js';
import { jsonSchema } from '../primitives.js';

const routes = Object.values(pendingTaskRoutes);

export const pendingTaskSchemas = {
  ...routeSchemas(routes),
  // The shapes inside a list and a task, named for clients.
  PendingTaskSummary: jsonSchema(pendingTaskSummarySchema, 'output'),
  PendingTaskDetail: jsonSchema(pendingTaskDetailSchema, 'output'),
};

export const pendingTaskPaths = routePaths(routes);
