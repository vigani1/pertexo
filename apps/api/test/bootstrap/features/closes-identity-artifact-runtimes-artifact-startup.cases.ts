import { expect, it, vi } from 'vitest';
import { createApiApplication } from '../../../src/app.js';

import {
  config,
  dependencies,
  identityRuntime,
  artifactRuntime,
  applicationFixture,
} from '../fixture.js';

export function registerClosesIdentityArtifactRuntimesArtifactStartup(): void {
  it('closes identity and artifact runtimes when artifact startup readiness fails', async () => {
    const selectedIdentity = identityRuntime();
    const selectedArtifacts = artifactRuntime();
    vi.mocked(selectedArtifacts.checkReadiness).mockRejectedValue(
      new Error('artifact readiness failed'),
    );
    await expect(
      createApiApplication(config, {
        ...dependencies(),
        identityRuntime: selectedIdentity,
        artifactRuntime: selectedArtifacts,
      }),
    ).rejects.toThrow('artifact readiness failed');
    expect(selectedIdentity.close).toHaveBeenCalledOnce();
    expect(selectedArtifacts.close).toHaveBeenCalledOnce();
  });

  it('includes artifact readiness in health and closes its runtime once', async () => {
    const selectedArtifacts = artifactRuntime();
    applicationFixture.application = await createApiApplication(config, {
      ...dependencies(),
      identityRuntime: identityRuntime(),
      artifactRuntime: selectedArtifacts,
    });
    expect(selectedArtifacts.checkReadiness).toHaveBeenCalledOnce();
    vi.mocked(selectedArtifacts.checkReadiness).mockRejectedValue(
      new Error('private bucket detail'),
    );
    const response = await applicationFixture.application.inject({
      method: 'GET',
      url: '/health/ready',
    });
    expect(response.statusCode).toBe(503);
    expect(response.payload).not.toContain('private bucket detail');
    await applicationFixture.application.close();
    applicationFixture.application = undefined;
    expect(selectedArtifacts.close).toHaveBeenCalledOnce();
  });
}
