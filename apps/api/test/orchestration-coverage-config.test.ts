import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import baseConfig from '../vitest.coverage.config.js';
import config from '../vitest.orchestration-coverage.config.js';
import priorityConfig from '../vitest.priority-coverage.config.js';
import publisherConfig from '../vitest.run-event-publisher-coverage.config.js';

describe('API orchestration coverage inventory', () => {
  it('measures the orchestration implicated by the current backend audit', () => {
    expect(config.test?.coverage?.include).toEqual([
      'src/application-error-mappers.ts',
      'src/connections/connection-testing.ts',
      'src/workflow-runs/{sse-authorization-lifetime,use-cases}.ts',
    ]);
    expect(config.test?.coverage?.thresholds).toEqual({
      branches: 92,
      functions: 95,
      lines: 95,
      statements: 94,
    });
  });

  it('measures identity, webhooks, authoring, and application bootstrap separately', () => {
    expect(priorityConfig.test?.coverage?.include).toEqual([
      'src/app.ts',
      'src/identity/{csrf,oidc,session}.ts',
      'src/identity-infrastructure/{oidc-adapter,oidc-request-validation,oidc-response-cleanup,oidc-secret-encryption}.ts',
      'src/identity-workspace/{module,use-cases}.ts',
      'src/platform/identity/identity-runtime.module.ts',
      'src/webhooks/ingress.ts',
      'src/workflow-authoring/{lifecycle-use-case,module,preconditions,restore-version-use-case,use-cases}.ts',
    ]);
    expect(priorityConfig.test?.coverage?.thresholds).toEqual({
      branches: 82,
      functions: 96,
      lines: 92,
      statements: 91,
      'src/webhooks/ingress.ts': {
        branches: 86,
        functions: 91,
        lines: 88,
        statements: 87,
      },
    });
  });

  it('measures the API publisher against its canonical queue source exactly once', () => {
    const publisherTest = 'test/executions/redis-run-event-publisher.test.ts';
    const apiDirectory = resolve(import.meta.dirname, '..');
    expect(baseConfig.test?.exclude).toContain(publisherTest);
    expect(config.test?.exclude).toContain(publisherTest);
    expect(priorityConfig.test?.exclude).toContain(publisherTest);
    expect(publisherConfig.test?.include).toEqual([
      'apps/api/test/executions/redis-run-event-publisher.test.ts',
    ]);
    expect(publisherConfig.test?.coverage?.include).toEqual([
      'packages/queue/src/run-event-notifications.ts',
    ]);
    expect(publisherConfig.root).toBe(resolve(apiDirectory, '../..'));
    expect(publisherConfig.resolve?.alias).toEqual({
      '@pertexo/queue': resolve(
        apiDirectory,
        '../../packages/queue/src/index.ts',
      ),
    });
    expect(publisherConfig.test?.coverage?.reportsDirectory).toBe(
      'coverage/api-run-event-publisher',
    );
    expect(publisherConfig.test?.coverage?.thresholds).toEqual({
      branches: 81,
      functions: 100,
      lines: 98,
      statements: 98,
    });
  });
});
