import { useState } from 'react';
import { samlServiceProviderUrls } from '@pertexo/contracts';
import { CopyButton } from '@/components/ui/copy-button';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import { useLatestRequest } from '@/lib/hooks/use-latest-request';
import { describeCommandError } from '@/lib/api/error-copy';
import {
  readSamlMetadata,
  type FederationScope,
} from '../../data/settings.api';
import { downloadSamlMetadata } from '../../model/download-metadata';
function MetadataValue({
  label,
  value,
}: Readonly<{ label: string; value: string }>) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex min-w-0 items-start gap-2">
        <code className="min-w-0 break-all text-xs">{value}</code>
        <CopyButton value={value} label={`Copy ${label}`} />
      </div>
    </div>
  );
}
export function SamlMetadata({
  scope,
  organizationId,
}: Readonly<{ scope: FederationScope; organizationId: string }>) {
  const request = useLatestRequest(),
    [error, setError] = useState<string>();
  if (window.location.protocol !== 'https:')
    return (
      <p className="text-xs text-muted-foreground">
        SAML requires an HTTPS public app address and secure session cookies.
        OIDC remains available on the existing development path.
      </p>
    );
  const locations = samlServiceProviderUrls(
    window.location.origin,
    organizationId,
  );
  async function download() {
    if (request.pending) return;
    const attempt = request.begin();
    setError(undefined);
    try {
      const metadata = await readSamlMetadata(scope, attempt.signal);
      if (attempt.isCurrent()) downloadSamlMetadata(metadata.xml);
    } catch (cause) {
      if (attempt.isCurrent())
        setError(describeCommandError(cause, 'downloading SAML metadata'));
    } finally {
      attempt.finish();
    }
  }
  return (
    <details>
      <summary className="cursor-pointer text-sm font-semibold">
        SAML setup and metadata
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">
          Configure your IdP with these values before adding a SAML provider.
          The organization has one SP identity; each provider keeps separate
          certificates and sign-in checks.
        </p>
        <MetadataValue label="SAML entity ID" value={locations.entityId} />
        <MetadataValue
          label="SAML callback URL"
          value={locations.redirectUri}
        />
        <ProgressButton
          type="button"
          variant="outline"
          pending={request.pending}
          pendingLabel="Downloading…"
          onClick={() => void download()}
        >
          Download SP metadata
        </ProgressButton>
        {error === undefined ? null : <Notice tone="warning">{error}</Notice>}
      </div>
    </details>
  );
}
