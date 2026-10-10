import type { WorkflowPortableManifest } from '@pertexo/workflow-model';

import { CONTROLLED_HTTP_NOTIFICATION_MANIFEST } from './manifests/controlled-http-notification.js';
import { SCHEDULE_BOUNDED_BATCH_MANIFEST } from './manifests/schedule-bounded-batch.js';
import { WEBHOOK_VALIDATION_ROUTING_MANIFEST } from './manifests/webhook-validation-routing.js';

export type CuratedTemplateSetupValueKind =
  'https_endpoint' | 'slack_channel_id';
export interface CuratedTemplateSetupTarget {
  readonly nodeId: string;
  readonly location: 'config' | 'literalInput';
  readonly key: string;
  readonly valueKind: CuratedTemplateSetupValueKind;
}
export interface CuratedWorkflowTemplate {
  readonly templateId: string;
  readonly templateVersion: number;
  readonly baseManifestDigest: string;
  readonly title: string;
  readonly description: string;
  readonly inputSummary: string;
  readonly effectsSummary: string;
  readonly boundsSummary: string;
  readonly manifest: WorkflowPortableManifest;
  readonly setupTargets: readonly CuratedTemplateSetupTarget[];
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

const templates: CuratedWorkflowTemplate[] = [
  {
    templateId: 'webhook-validation-routing',
    templateVersion: 1,
    baseManifestDigest:
      '96ff14b3d2c702b8917787616d0899ca55f815cfbdc6507d27245be4659e10cf',
    title: 'Validate and route a webhook',
    description:
      'Check a request type and route valid and invalid inputs to explicit outcomes.',
    inputSummary:
      'Webhook request JSON: {"type":"notification"}; missing or other types take the rejected branch.',
    effectsSummary:
      'Only validation and routing. No external provider effects. Publishing and webhook activation are separate.',
    boundsSummary:
      'Five worst-case expanded invocations; no loop; five-minute run limit.',
    manifest: WEBHOOK_VALIDATION_ROUTING_MANIFEST,
    setupTargets: [],
  },
  {
    templateId: 'schedule-bounded-batch',
    templateVersion: 1,
    baseManifestDigest:
      '1a6afcae87a3f5060809111ad204b6ab5e9262537023a2c6efb80dfdf459f8c3',
    title: 'Schedule a bounded example batch',
    description: 'Process two fixed instructional items in a sequential loop.',
    inputSummary:
      'A registered hourly interval schedule envelope; batch items are fixed alpha/beta literals, not trigger data.',
    effectsSummary:
      'Local Set results only; no provider effects. Publishing and schedule activation are separate.',
    boundsSummary:
      'At most three iterations, concurrency one, six expanded invocations; five-minute run limit.',
    manifest: SCHEDULE_BOUNDED_BATCH_MANIFEST,
    setupTargets: [],
  },
  {
    templateId: 'controlled-http-notification',
    templateVersion: 1,
    baseManifestDigest:
      'ec1d7ba93f3f2b2af9931fa59299088539655ab9619f5a37e3c7020ecf128ef3',
    title: 'Check an endpoint and notify Slack',
    description:
      'Request an explicitly configured HTTPS endpoint and notify an explicitly configured channel only for status 200.',
    inputSummary:
      'Webhook trigger; configure your endpoint and channel and explicitly bind HTTP and Slack connections before creation.',
    effectsSummary:
      'When separately published and run, performs HTTP GET and may send one Slack message. Other 2xx statuses skip Slack; non-2xx may fail or have unknown outcome. Placeholder values are not runnable setup.',
    boundsSummary:
      'No redirects or loop; one-second provider timeouts, 1,024-byte response limits, six expanded invocations; five-minute run limit.',
    manifest: CONTROLLED_HTTP_NOTIFICATION_MANIFEST,
    setupTargets: [
      {
        nodeId: 'controlled-http',
        location: 'config',
        key: 'url',
        valueKind: 'https_endpoint',
      },
      {
        nodeId: 'slack-notification',
        location: 'literalInput',
        key: 'channelId',
        valueKind: 'slack_channel_id',
      },
    ],
  },
];

/** Public instructional assets, not capability/selection authority or a safety assertion. */
export const CURATED_WORKFLOW_TEMPLATES: readonly CuratedWorkflowTemplate[] =
  freezeJson(templates);
