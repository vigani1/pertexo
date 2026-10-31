import { HttpResponse, http } from 'msw';
import { mockServer } from '../../../support/mock-server';
export function installAcceptanceHandlers() {
  mockServer.use(
    http.post(
      'http://pertexo.test/v1/invitation-acceptance/session',
      () => new HttpResponse(null, { status: 401 }),
    ),
    http.get('http://pertexo.test/v1/auth/capabilities', () =>
      HttpResponse.json({
        password: {
          enabled: false,
          minimumLength: 12,
          verificationRequired: true,
        },
        socialProviders: [],
        signUp: 'open',
      }),
    ),
  );
}
