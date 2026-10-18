import { useId, useState } from 'react';
import type { FederationSettings } from '@pertexo/contracts';
import { LabelledField } from '@/components/ui/field';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import { useLatestRequest } from '@/lib/hooks/use-latest-request';
import { describeCommandError } from '@/lib/api/error-copy';
import { startOrganizationProviderTest } from '../../data/sign-in.api';
import type { FederationScope } from '../../data/settings.api';
type Organization = NonNullable<FederationSettings['organization']>;
export function TestProvider({
  scope,
  organization,
  provider,
  editable,
  navigateToProvider,
}: Readonly<{
  scope: FederationScope;
  organization: Organization;
  provider: Organization['providers'][number];
  editable: boolean;
  navigateToProvider: (url: string) => void;
}>) {
  const id = useId(),
    requests = useLatestRequest();
  const [chosen, setChosen] = useState<string | null>(null),
    [error, setError] = useState<string>();
  const verified = organization.domains.filter(
      (domain) => domain.verifiedAt !== null,
    ),
    domainId = chosen ?? verified[0]?.id;
  async function test() {
    if (requests.pending || domainId === undefined) return;
    const attempt = requests.begin();
    setError(undefined);
    try {
      const url = await startOrganizationProviderTest(
        scope.apiClient,
        { workspaceId: scope.workspaceId, providerId: provider.id, domainId },
        attempt.signal,
        provider.kind,
      );
      if (attempt.isCurrent()) navigateToProvider(url);
    } catch (cause: unknown) {
      if (attempt.isCurrent()) {
        setError(describeCommandError(cause, 'starting the provider test'));
        attempt.finish();
      }
    }
  }
  return (
    <div className="max-w-xl space-y-3">
      <LabelledField
        id={id}
        label="Test domain"
        description="A test checks the real provider, keeps your current session and grants no accounts or memberships."
      >
        {(control) => (
          <Select
            items={verified.map((domain) => ({
              value: domain.id,
              label: domain.domain,
            }))}
            value={domainId ?? null}
            onValueChange={setChosen}
            disabled={!editable || requests.pending || verified.length === 0}
          >
            <SelectTrigger {...control}>
              <SelectValue placeholder="Verify a DNS domain first" />
            </SelectTrigger>
            <SelectContent>
              {verified.map((domain) => (
                <SelectItem key={domain.id} value={domain.id}>
                  {domain.domain}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </LabelledField>
      <ProgressButton
        type="button"
        variant="outline"
        pending={requests.pending}
        pendingLabel="Opening provider…"
        disabled={!editable || requests.pending || domainId === undefined}
        onClick={() => void test()}
      >
        Test sign-in
      </ProgressButton>
      {provider.enabled ? null : (
        <p className="text-xs text-muted-foreground">
          You can test sign-in while this provider is off.
        </p>
      )}
      {error === undefined ? null : <Notice tone="warning">{error}</Notice>}
    </div>
  );
}
