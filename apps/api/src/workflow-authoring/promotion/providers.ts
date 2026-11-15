import type { Provider } from '@nestjs/common';
import type { WorkflowAuthoringDependencies } from '../ports.js';
import { WorkflowPromotionService } from './workflow-promotion.service.js';
export function workflowPromotionProviders(
  dependencies: WorkflowAuthoringDependencies,
): Provider[] {
  return dependencies.promotionPersistence === undefined
    ? []
    : [
        {
          provide: WorkflowPromotionService,
          useValue: new WorkflowPromotionService(
            dependencies.promotionPersistence,
            dependencies.authorization,
          ),
        },
      ];
}
