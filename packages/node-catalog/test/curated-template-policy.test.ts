import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  HTTP_REQUEST_DEFINITION_REGISTRATION,
  SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION,
} from '@pertexo/integrations';
import {
  CURATED_WORKFLOW_TEMPLATES,
  validateCuratedTemplateSetupValue,
  isCuratedHttpsEndpointV1,
} from '@pertexo/workflow-model/curated-templates';
import { platformServingRegistryRelease } from '../src/registry.js';
import { platformPortableDefinitionPolicy } from '../src/portable-definition-policy.js';
import { validateRegisteredCuratedTemplateSetup } from '../src/curated-template-policy.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing reviewed test fixture');
  return value;
}

function endpointOfBytes(bytes: number): string {
  const prefix = 'https://example.test/';
  const remaining = bytes - new TextEncoder().encode(prefix).byteLength;
  return (
    prefix + 'é'.repeat(Math.floor(remaining / 2)) + 'a'.repeat(remaining % 2)
  );
}

function configuredTemplate(
  kind: 'curated_https_endpoint_v1' | 'slack_channel_id',
  value: unknown,
) {
  const descriptor = required(CURATED_WORKFLOW_TEMPLATES[2]);
  const manifest = structuredClone(descriptor.manifest);
  const origin = {
    schemaVersion: 1,
    templateId: descriptor.templateId,
    templateVersion: descriptor.templateVersion,
    baseManifestDigest: descriptor.baseManifestDigest,
  };
  if (kind === 'curated_https_endpoint_v1') {
    Object.assign(
      required(
        manifest.graph.nodes.find((node) => node.id === 'controlled-http'),
      ).config,
      { url: value },
    );
  } else {
    Object.assign(
      required(
        manifest.graph.nodes.find((node) => node.id === 'slack-notification'),
      ).inputMappings,
      { channelId: { kind: 'literal', value } },
    );
  }
  return { manifest, origin };
}

interface CorpusCase {
  readonly name: string;
  readonly value: unknown;
  readonly accepted: boolean;
}
const corpus = JSON.parse(
  await readFile(
    new URL(
      '../../workflow-model/test/fixtures/curated-https-endpoint-v1-corpus.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as readonly CorpusCase[];

describe('browser template setup versus registered server policy', () => {
  const release = platformServingRegistryRelease('validate_activation');
  const policy = platformPortableDefinitionPolicy(release);
  const http = required(
    policy.definitions.find(({ key }) => key === 'http.request'),
  );
  const slack = required(
    policy.definitions.find(({ key }) => key === 'slack.send_message'),
  );
  const httpConfig = required(
    required(CURATED_WORKFLOW_TEMPLATES[2]).manifest.graph.nodes.find(
      (node) => node.id === 'controlled-http',
    ),
  ).config;

  it.each([
    ['https://é.example.test/path', true],
    ['https:example.test', true],
    ['https://@example.test', true],
    ['https://example.test#', true],
    ['https://\u200D.example', false],
    ['https://example.test?%FF=value', true],
    ['https://example.test?%00=value', true],
    ['https://example.test?%C5%BFecret=value', false],
    ['https://example.test?api-Key=value', false],
  ] as const)(
    'preserves historical broad registered oracle while curated v1 intentionally rejects %s',
    (value, accepted) => {
      expect(
        HTTP_REQUEST_DEFINITION_REGISTRATION.configSchema.safeParse({
          ...httpConfig,
          url: value,
        }).success,
      ).toBe(accepted);
      expect(
        validateCuratedTemplateSetupValue('curated_https_endpoint_v1', value)
          .ok,
      ).toBe(false);
    },
  );

  it('keeps the ordinary IDNA oracle runtime-owned while curated v1 rejects punycode', () => {
    const value = 'https://xn--a.example';
    // Node 24.15 rejects this IDNA input; 24.21 accepts it. The existing
    // registered policy delegates URL syntax to WHATWG, not curated grammar.
    let accepted = false;
    try {
      accepted = new URL(value).protocol === 'https:';
    } catch {
      // Invalid WHATWG input remains invalid for the registered node.
    }
    expect(
      HTTP_REQUEST_DEFINITION_REGISTRATION.configSchema.safeParse({
        ...httpConfig,
        url: value,
      }).success,
    ).toBe(accepted);
    expect(
      validateCuratedTemplateSetupValue('curated_https_endpoint_v1', value).ok,
    ).toBe(false);
  });

  it.each([
    'https://example.test',
    'https://example.test?q=value',
    'https://example.test/?key=value',
    endpointOfBytes(2048),
    endpointOfBytes(2049),
    'https://example.test/' + 'a'.repeat(2049),
    'https://é.example.test/path',
    // WHATWG/IDNA boundary evidence for the independent SQL guard decision.
    'https://faß.example',
    'https://\u200D.example',
    'https://xn--a.example',
    'https:example.test',
    'https:/example.test',
    'https://@example.test',
    'https://example.test#',
    'https://example.test:#',
    'https://127.1',
    'https://0xffffffff',
    'https://09',
    'https://[::1]',
    'https://[::1%25eth0]',
    'https://example.test:65536',
    'https://example.test?%FF=value',
    'https://example.test?%00=value',
    'https://example.test?ſecret=value',
    'https://example.test?%C5%BFecret=value',
    'https://example.test?api-Key=value',
    'HTTPS://example.test/path',
    'http://example.test',
    'ftp://example.test',
    '//example.test',
    'invalid',
    '',
    ' https://example.test ',
    'https://user@example.test',
    'https://user:password@example.test',
    'https://example.test#fragment',
    'https://example.test?Token=value',
    'https://example.test?%74oken=value',
    'https://example.test?Api_Key=value',
    'https://example.test?api-key=value',
    'https://example.test?AUTH=value',
    'https://example.test?credential=value',
    'https://example.test?Secret=value',
    'https://example.test?prefix_auth_suffix=value',
    'https://example.test?%61pi%5Fkey=value',
  ])(
    'retains ordinary HTTP admission and intersects curated grammar for %s',
    (value) => {
      const candidate = { ...httpConfig, url: value };
      const registered =
        HTTP_REQUEST_DEFINITION_REGISTRATION.configSchema.safeParse(candidate);
      const ordinaryMatches =
        registered.success && http.validateConfig(candidate);
      const matches = ordinaryMatches && isCuratedHttpsEndpointV1(value);
      expect(
        validateCuratedTemplateSetupValue('curated_https_endpoint_v1', value)
          .ok,
      ).toBe(matches);
      const configured = configuredTemplate('curated_https_endpoint_v1', value);
      expect(
        policy.validateTemplateSetup(configured.manifest, configured.origin),
      ).toBe(matches);
    },
  );

  it('retains ordinary multibyte byte boundaries but curated v1 rejects raw Unicode', () => {
    expect(new TextEncoder().encode(endpointOfBytes(2048)).byteLength).toBe(
      2048,
    );
    expect(new TextEncoder().encode(endpointOfBytes(2049)).byteLength).toBe(
      2049,
    );
    expect(endpointOfBytes(2049).length).toBeLessThan(2048);
    expect(
      validateCuratedTemplateSetupValue(
        'curated_https_endpoint_v1',
        endpointOfBytes(2048),
      ).ok,
    ).toBe(false);
    expect(
      http.validateConfig({ ...httpConfig, url: endpointOfBytes(2048) }),
    ).toBe(true);
    expect(
      http.validateConfig({ ...httpConfig, url: endpointOfBytes(2049) }),
    ).toBe(false);
    expect(
      validateCuratedTemplateSetupValue(
        'curated_https_endpoint_v1',
        endpointOfBytes(2049),
      ).ok,
    ).toBe(false);
  });

  it.each(corpus)(
    'shared curated HTTPS corpus in model and registered server: $name',
    ({ value, accepted }) => {
      expect(
        validateCuratedTemplateSetupValue('curated_https_endpoint_v1', value)
          .ok,
      ).toBe(accepted);
      const configured = configuredTemplate('curated_https_endpoint_v1', value);
      expect(
        policy.validateTemplateSetup(configured.manifest, configured.origin),
      ).toBe(accepted);
      if (accepted) {
        expect(http.validateConfig({ ...httpConfig, url: value })).toBe(true);
        expect(
          configured.manifest.graph.nodes.find(
            (node) => node.id === 'controlled-http',
          )?.config.url,
        ).toBe(value);
      }
    },
  );

  it.each([
    'C',
    'C1',
    'D1',
    'G1',
    'U1',
    'c1',
    'A1',
    'Cé',
    'C_',
    'C-1',
    ' C1',
    'C1 ',
    'C' + 'A'.repeat(127),
    'C' + 'A'.repeat(128),
    'C' + 'A'.repeat(254),
    'C' + 'A'.repeat(255),
  ])(
    'matches registered Slack INPUT intersected with 128-character bound for %s',
    (value) => {
      const input = { channelId: value, text: 'Instructional notification' };
      const registered =
        SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION.inputSchema.safeParse(input);
      expect(
        validateCuratedTemplateSetupValue('slack_channel_id', value).ok,
      ).toBe(registered.success && value.length <= 128);
      const configured = configuredTemplate('slack_channel_id', value);
      expect(
        policy.validateTemplateSetup(configured.manifest, configured.origin),
      ).toBe(registered.success && value.length <= 128);
    },
  );

  it('does not mistake F05 config policy for Slack literal input validation', () => {
    expect(slack.validateConfig({ timeoutMillis: 1000 })).toBe(true);
    expect(
      SLACK_SEND_MESSAGE_DEFINITION_REGISTRATION.inputSchema.safeParse({
        channelId: 'invalid-channel',
        text: 'demo',
      }).success,
    ).toBe(false);
    expect(
      validateCuratedTemplateSetupValue('slack_channel_id', 'invalid-channel')
        .ok,
    ).toBe(false);
  });

  it('binds production template setup validation to the selected registered release', () => {
    const descriptor = required(CURATED_WORKFLOW_TEMPLATES[2]);
    const origin = {
      schemaVersion: 1,
      templateId: descriptor.templateId,
      templateVersion: descriptor.templateVersion,
      baseManifestDigest: descriptor.baseManifestDigest,
    };
    expect(
      validateRegisteredCuratedTemplateSetup(
        release,
        descriptor.manifest,
        origin,
      ),
    ).toBe(true);
    expect(policy.validateTemplateSetup(descriptor.manifest, origin)).toBe(
      true,
    );
    expect(
      validateRegisteredCuratedTemplateSetup(
        platformServingRegistryRelease('core'),
        descriptor.manifest,
        origin,
      ),
    ).toBe(false);
    expect(
      validateRegisteredCuratedTemplateSetup({}, descriptor.manifest, origin),
    ).toBe(false);
    const invalid = structuredClone(descriptor.manifest);
    Object.assign(
      required(
        invalid.graph.nodes.find((node) => node.id === 'slack-notification'),
      ).inputMappings,
      { channelId: { kind: 'literal', value: 'invalid' } },
    );
    expect(policy.validateTemplateSetup(invalid, origin)).toBe(false);
    expect(
      validateRegisteredCuratedTemplateSetup(release, descriptor.manifest, {
        ...origin,
        templateVersion: 2,
      }),
    ).toBe(false);
  });
});
