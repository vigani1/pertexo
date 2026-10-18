import type { Provider } from '@nestjs/common';
import type { WorkflowAuthoringDependencies } from '../ports.js';
import { WorkflowPromotionUseCase } from './use-case.js';
export function workflowPromotionProviders(
  dependencies: WorkflowAuthoringDependencies,
): Provider[] {
  return dependencies.promotionPersistence === undefined
    ? []
    : [
        {
          provide: WorkflowPromotionUseCase,
          useValue: new WorkflowPromotionUseCase(
            dependencies.promotionPersistence,
            dependencies.authorization,
          ),
        },
      ];
}
