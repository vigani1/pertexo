import { expect, it } from 'vitest';
import { createTestApiApplication } from '../../support/api-application.js';
import { config, dependencies, applicationFixture } from '../fixture.js';

export function registerAcceptsBothEmptyPopulatedTrustedProxy(): void {
  it('accepts both empty and populated trusted-proxy CIDR configuration', async () => {
    applicationFixture.application = await createTestApiApplication(
      { ...config, trustedProxyCidrs: [] },
      dependencies(),
    );
    await applicationFixture.application.close();
    applicationFixture.application = await createTestApiApplication(
      { ...config, trustedProxyCidrs: ['127.0.0.1/32'] },
      dependencies(),
    );
    expect(
      (
        await applicationFixture.application.inject({
          method: 'GET',
          url: '/health/live',
        })
      ).statusCode,
    ).toBe(200);
  });

  it.each([
    '/v1/workspaces/nonexistent',
    '/v1/workspaces/workspace-a/workflows/nonexistent/nested',
  ])('keeps an unknown feature-family route at 404: %s', async (url) => {
    applicationFixture.application = await createTestApiApplication(
      config,
      dependencies(),
    );
    await applicationFixture.application.init();

    const response = await applicationFixture.application.inject({
      method: 'GET',
      url,
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.json()).toMatchObject({
      status: 404,
      code: 'resource.not_found',
    });
  });
}
