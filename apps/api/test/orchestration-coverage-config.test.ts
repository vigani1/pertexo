import { describe, expect, it } from 'vitest';

import config from '../vitest.orchestration-coverage.config.js';
import priorityConfig from '../vitest.priority-coverage.config.js';

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

  it('measures identity, OIDC, authoring, and application bootstrap separately', () => {
    expect(priorityConfig.test?.coverage?.include).toEqual([
      'src/app.ts',
      'src/identity/{csrf,oidc,session}.ts',
      'src/identity-infrastructure/{oidc-adapter,oidc-request-validation,oidc-response-cleanup,oidc-secret-encryption}.ts',
      'src/identity-workspace/{module,use-cases}.ts',
      'src/platform/identity/identity-runtime.module.ts',
      'src/workflow-authoring/{lifecycle-use-case,module,preconditions,restore-version-use-case,use-cases}.ts',
    ]);
    expect(priorityConfig.test?.coverage?.thresholds).toEqual({
      branches: 82,
      functions: 96,
      lines: 92,
      statements: 91,
    });
  });
});
