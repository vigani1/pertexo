import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';

import {
  DoubleSubmitCsrfPolicy,
  OidcLoginService,
  OpaqueSessionService,
  nodeIdentityCrypto,
} from '../identity/index.js';
import type { IdentityClock, IdentityCrypto } from '../identity/index.js';
import {
  OidcController,
  SessionController,
  WorkspaceController,
} from './controllers.js';
import { CsrfProtectionGuard, SessionAuthenticationGuard } from './guards.js';
import {
  CreateWorkspaceUseCase,
  WorkspaceLifecycleUseCase,
} from './use-cases.js';
import type {
  IdentityWorkspaceDependencies,
  SessionCookiePolicy,
} from './ports.js';
import {
  CSRF_POLICY,
  IDENTITY_CLOCK,
  IDENTITY_CRYPTO,
  IDENTITY_WORKSPACE_CONFIG,
  IDENTITY_WORKSPACE_PERSISTENCE,
  OIDC_PROVIDER,
  OIDC_TRANSACTIONS,
  WORKSPACE_AUTHORIZATION,
  SESSION_COOKIE_POLICY,
} from './tokens.js';

@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class IdentityWorkspaceModule {
  public static register(
    dependencies: IdentityWorkspaceDependencies,
  ): DynamicModule {
    const crypto: IdentityCrypto = dependencies.crypto ?? nodeIdentityCrypto;
    const clock: IdentityClock = dependencies.clock ?? {
      now: (): Date => new Date(),
    };
    const providers: Provider[] = [
      { provide: IDENTITY_WORKSPACE_CONFIG, useValue: dependencies.config },
      { provide: IDENTITY_CRYPTO, useValue: crypto },
      { provide: IDENTITY_CLOCK, useValue: clock },
      { provide: OIDC_PROVIDER, useValue: dependencies.provider },
      { provide: OIDC_TRANSACTIONS, useValue: dependencies.transactions },
      {
        provide: IDENTITY_WORKSPACE_PERSISTENCE,
        useValue: dependencies.persistence,
      },
      {
        provide: WORKSPACE_AUTHORIZATION,
        useValue: dependencies.authorization,
      },
      {
        provide: SESSION_COOKIE_POLICY,
        useValue: {
          secure: dependencies.config.session?.secureCookie ?? true,
          sameSite: dependencies.config.session?.sameSite ?? 'lax',
        },
      },
      {
        provide: OidcLoginService,
        useFactory: (
          config: IdentityWorkspaceDependencies['config'],
          transactions: IdentityWorkspaceDependencies['transactions'],
          provider: IdentityWorkspaceDependencies['provider'],
          persistence: IdentityWorkspaceDependencies['persistence'],
          crypto: IdentityCrypto,
          clock: IdentityClock,
        ): OidcLoginService =>
          new OidcLoginService(
            config.oidc,
            transactions,
            provider,
            {
              mapExternalIdentity: async (identity, profile) =>
                persistence.resolveOrCreateIdentity({
                  issuer: identity.issuer,
                  providerSubject: identity.subject,
                  email: profile.email,
                  displayName: profile.displayName,
                }),
            },
            { crypto, clock },
          ),
        inject: [
          IDENTITY_WORKSPACE_CONFIG,
          OIDC_TRANSACTIONS,
          OIDC_PROVIDER,
          IDENTITY_WORKSPACE_PERSISTENCE,
          IDENTITY_CRYPTO,
          IDENTITY_CLOCK,
        ],
      },
      {
        provide: OpaqueSessionService,
        useFactory: (
          persistence: IdentityWorkspaceDependencies['persistence'],
          config: IdentityWorkspaceDependencies['config'],
          crypto: IdentityCrypto,
          clock: IdentityClock,
        ): OpaqueSessionService =>
          new OpaqueSessionService(persistence, {
            ...config.session,
            crypto,
            clock,
          }),
        inject: [
          IDENTITY_WORKSPACE_PERSISTENCE,
          IDENTITY_WORKSPACE_CONFIG,
          IDENTITY_CRYPTO,
          IDENTITY_CLOCK,
        ],
      },
      {
        provide: CSRF_POLICY,
        useFactory: (crypto: IdentityCrypto) =>
          new DoubleSubmitCsrfPolicy(crypto),
        inject: [IDENTITY_CRYPTO],
      },
      {
        provide: DoubleSubmitCsrfPolicy,
        useExisting: CSRF_POLICY,
      },
      {
        provide: CreateWorkspaceUseCase,
        useFactory: (
          persistence: IdentityWorkspaceDependencies['persistence'],
        ) => new CreateWorkspaceUseCase(persistence),
        inject: [IDENTITY_WORKSPACE_PERSISTENCE],
      },
      {
        provide: WorkspaceLifecycleUseCase,
        useFactory: (
          persistence: IdentityWorkspaceDependencies['persistence'],
          authorization: IdentityWorkspaceDependencies['authorization'],
        ) => new WorkspaceLifecycleUseCase(persistence, authorization),
        inject: [IDENTITY_WORKSPACE_PERSISTENCE, WORKSPACE_AUTHORIZATION],
      },
      {
        provide: SessionAuthenticationGuard,
        useFactory: (sessions: OpaqueSessionService) =>
          new SessionAuthenticationGuard(sessions),
        inject: [OpaqueSessionService],
      },
      {
        provide: CsrfProtectionGuard,
        useFactory: (csrf: DoubleSubmitCsrfPolicy) =>
          new CsrfProtectionGuard(csrf),
        inject: [CSRF_POLICY],
      },
      {
        provide: SessionController,
        useFactory: (
          sessions: OpaqueSessionService,
          policy: SessionCookiePolicy,
        ) => new SessionController(sessions, policy),
        inject: [OpaqueSessionService, SESSION_COOKIE_POLICY],
      },
    ];
    return {
      module: IdentityWorkspaceModule,
      controllers: [OidcController, SessionController, WorkspaceController],
      providers,
      exports: [
        OidcLoginService,
        OpaqueSessionService,
        CSRF_POLICY,
        CreateWorkspaceUseCase,
        WorkspaceLifecycleUseCase,
        SessionAuthenticationGuard,
        CsrfProtectionGuard,
      ],
    };
  }
}
