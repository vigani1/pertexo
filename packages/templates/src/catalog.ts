import type { WorkflowPortableManifest } from '@pertexo/workflow-model/portability-contract';

import { CONTROLLED_HTTP_NOTIFICATION_MANIFEST } from './manifests/controlled-http-notification.js';
import { SCHEDULE_BOUNDED_BATCH_MANIFEST } from './manifests/schedule-bounded-batch.js';
import { WEBHOOK_VALIDATION_ROUTING_MANIFEST } from './manifests/webhook-validation-routing.js';

const CURATED_TEMPLATE_MANIFESTS: readonly WorkflowPortableManifest[] = [
  WEBHOOK_VALIDATION_ROUTING_MANIFEST,
  SCHEDULE_BOUNDED_BATCH_MANIFEST,
  CONTROLLED_HTTP_NOTIFICATION_MANIFEST,
];

export type CuratedTemplateSetupValueKind =
  'curated_https_endpoint_v1' | 'slack_channel_id';
export interface CuratedTemplateSetupTarget {
  readonly nodeId: string;
  readonly location: 'config' | 'literalInput';
  readonly key: string;
  readonly valueKind: CuratedTemplateSetupValueKind;
}
export interface CuratedWorkflowTemplate {
  readonly schemaVersion: 1;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly baseManifestDigest: string;
  readonly title: string;
  readonly description: string;
  readonly inputSummary: string;
  readonly effectsSummary: string;
  readonly boundsSummary: string;
  readonly supportedProfile: 'validate_activation';
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

const descriptorDetails = [
  {
    templateId: 'webhook-validation-routing',
    baseManifestDigest:
      '054903475c92270db247af785f4be6ba806e68023c167770cb9f767c77bb5239',
    title: 'Validate and route a webhook',
    description:
      'Check a request type and route valid and invalid inputs to explicit outcomes.',
    inputSummary:
      'Webhook request JSON: {"type":"notification"}; missing or other types take the rejected branch.',
    effectsSummary:
      'Only validation and routing. No external provider effects. Publishing and webhook activation are separate.',
    boundsSummary:
      'Five worst-case expanded invocations; no loop; five-minute run limit.',
    setupTargets: [],
  },
  {
    templateId: 'schedule-bounded-batch',
    baseManifestDigest:
      '1ecab1f1b462fca2ad6542178952067eff50311e637caed1342d727fe2817a5d',
    title: 'Schedule a bounded example batch',
    description: 'Process two fixed instructional items in a sequential loop.',
    inputSummary:
      'A registered hourly interval schedule envelope; batch items are fixed alpha/beta literals, not trigger data.',
    effectsSummary:
      'Local Set results only; no provider effects. Publishing and schedule activation are separate.',
    boundsSummary:
      'At most three iterations, concurrency one, six expanded invocations; five-minute run limit.',
    setupTargets: [],
  },
  {
    templateId: 'controlled-http-notification',
    baseManifestDigest:
      'be2a8daaa8d220abf8be00c936df2cc3198cf8e64b88f0713baff8e3cebfdd46',
    title: 'Check an endpoint and notify Slack',
    description:
      'Request an explicitly configured HTTPS endpoint and notify an explicitly configured channel only for status 200.',
    inputSummary:
      'Webhook trigger; configure your endpoint and channel and explicitly bind HTTP and Slack connections before creation.',
    effectsSummary:
      'When separately published and run, performs HTTP GET and may send one Slack message. Other 2xx statuses skip Slack; non-2xx may fail or have unknown outcome. Placeholder values are not runnable setup.',
    boundsSummary:
      'No redirects or loop; one-second provider timeouts, 1,024-byte response limits, six expanded invocations; five-minute run limit.',
    setupTargets: [
      {
        nodeId: 'controlled-http',
        location: 'config',
        key: 'url',
        valueKind: 'curated_https_endpoint_v1',
      },
      {
        nodeId: 'slack-notification',
        location: 'literalInput',
        key: 'channelId',
        valueKind: 'slack_channel_id',
      },
    ],
  },
] as const;

/** Public instructional assets, not capability/selection authority or a safety assertion. */
export const CURATED_WORKFLOW_TEMPLATES: readonly CuratedWorkflowTemplate[] =
  freezeJson(
    descriptorDetails.map((details, index) => {
      const manifest = CURATED_TEMPLATE_MANIFESTS[index];
      if (manifest === undefined)
        throw new Error('Missing reviewed curated template asset');
      return {
        ...details,
        schemaVersion: 1 as const,
        templateVersion: 1,
        supportedProfile: 'validate_activation' as const,
        manifest,
      };
    }),
  );
