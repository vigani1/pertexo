import type { WorkflowPortableManifest } from './portability-contract.js';
import { WEBHOOK_VALIDATION_ROUTING_MANIFEST } from './curated-template-assets/webhook-validation-routing.js';
import { SCHEDULE_BOUNDED_BATCH_MANIFEST } from './curated-template-assets/schedule-bounded-batch.js';
import { CONTROLLED_HTTP_NOTIFICATION_MANIFEST } from './curated-template-assets/controlled-http-notification.js';

export const CURATED_TEMPLATE_MANIFESTS: readonly WorkflowPortableManifest[] = [
  WEBHOOK_VALIDATION_ROUTING_MANIFEST,
  SCHEDULE_BOUNDED_BATCH_MANIFEST,
  CONTROLLED_HTTP_NOTIFICATION_MANIFEST,
];
