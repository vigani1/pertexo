import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeOAuth2,
  startOAuth2Harness,
  useOAuth2Timeouts,
  type OAuth2Harness,
} from '../../support/oauth2/harness.js';

useOAuth2Timeouts();

describeOAuth2('consent on an https install', () => {
  let secure: OAuth2Harness;

  beforeAll(async () => {
    secure = await startOAuth2Harness('consent-https', {
      webOrigin: 'https://pertexo.example.test',
    });
  });
  afterAll(async () => {
    await secure.close();
  });

  // S5: Secure on HTTPS.
  it.fails('S5 marks the cookie Secure', async () => {
    const owner = await secure.newOwner();
    const connection = await secure.create(owner, 'non-rotating');
    const started = await secure.start(owner.api, owner, connection.id);
    expect(
      started.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith('pertexo_oauth2_')),
    ).toMatch(/;\s*Secure/u);
  });
});
