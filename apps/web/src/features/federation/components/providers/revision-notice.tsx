import { ReadRecovery } from '@/components/patterns/states/read-recovery';
import type { SnapshotRead } from '@/lib/api/query-snapshot';
import type { FederationSettings } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
export function ProviderRevisionNotice({
  organization,
  locked,
  canReview,
  onKeepEdits,
  onReload,
  revisionRead,
  onRetry,
}: Readonly<{
  organization: NonNullable<FederationSettings['organization']>;
  locked: boolean;
  canReview: boolean;
  onKeepEdits: () => void;
  onReload: () => void;
  revisionRead: SnapshotRead<FederationSettings> | undefined;
  onRetry: () => void;
}>) {
  return (
    <Notice
      tone="warning"
      action={
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={locked || !canReview}
            onClick={onKeepEdits}
          >
            Keep edits and use latest revision
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={locked}
            onClick={onReload}
          >
            Reload provider
          </Button>
        </div>
      }
    >
      Organization settings changed. Your edits are kept. Reloading replaces
      this form with the current settings.
      {revisionRead?.kind === 'read-failed' ? (
        <ReadRecovery
          error={revisionRead.error}
          resource="current provider settings"
          retrying={locked}
          retry={onRetry}
        />
      ) : null}
      <details className="mt-2 min-w-0">
        <summary className="focus-ring cursor-pointer rounded-sm">
          Review current provider settings
        </summary>
        <section
          aria-label="Current saved provider settings"
          className="mt-2 max-h-64 overflow-y-auto break-words"
        >
          <p>{organization.name}</p>
          <ul>
            {organization.providers.map((provider) => (
              <li key={provider.id} className="mt-2">
                <CurrentProviderSettings provider={provider} />
              </li>
            ))}
          </ul>
        </section>
      </details>
    </Notice>
  );
}

type Provider = NonNullable<
  FederationSettings['organization']
>['providers'][number];
function CurrentProviderSettings({
  provider,
}: Readonly<{ provider: Provider }>) {
  const protocolFields: readonly (readonly [string, string])[] =
    provider.kind === 'oidc'
      ? [
          ['Client ID', provider.configuration.clientId],
          [
            'Client secret',
            provider.secretConfigured ? 'Configured' : 'Not configured',
          ],
          ['Email claim', provider.configuration.emailClaim],
          ['Name claim', provider.configuration.nameClaim],
        ]
      : [
          ['SSO sign-in URL', provider.configuration.signInUrl],
          ['Email attribute', provider.configuration.emailAttribute],
          ['Name attribute', provider.configuration.nameAttribute],
          [
            'Signing certificates',
            provider.configuration.certificates.join('\n'),
          ],
        ];
  const fields: readonly (readonly [string, string])[] = [
    ['Provider', provider.name],
    ['Issuer', provider.issuer],
    ['Sign-in', provider.enabled ? 'Allowed' : 'Blocked'],
    ['New accounts', provider.configuration.jitEnabled ? 'Allowed' : 'Blocked'],
    ...protocolFields,
  ];
  return (
    <dl className="grid gap-1 text-xs">
      {fields.map(([label, value]) => (
        <div key={label}>
          <dt className="font-medium">{label}</dt>
          <dd className="whitespace-pre-wrap break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
