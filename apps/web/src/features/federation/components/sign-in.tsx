import { useId, useState } from 'react';
import {
  federationDomainNameSchema,
  type FederationDiscovery,
  type FederationProtocol,
} from '@pertexo/contracts';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import { useFieldValues } from '@/components/ui/use-field-validation';
import { useLatestRequest } from '@/lib/hooks/use-latest-request';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import {
  discoverOrganizationSignIn,
  startOrganizationSignIn,
} from '../data/sign-in.api';
export function OrganizationSignInForm({
  apiClient,
  returnTo,
  navigateToProvider,
}: Readonly<{
  apiClient: ApiClient;
  returnTo?: string | undefined;
  navigateToProvider: (url: string) => void;
}>) {
  const id = useId(),
    request = useLatestRequest();
  const [failure, setFailure] = useState<string>(),
    [found, setFound] =
      useState<Readonly<{ domain: string; discovery: FederationDiscovery }>>();
  const fields = useFieldValues(
    {
      domain: (value: string) =>
        federationDomainNameSchema.safeParse(value).success
          ? undefined
          : 'Enter your organization domain, such as example.com.',
    },
    { domain: '' },
    () => {
      setFound(undefined);
      setFailure(undefined);
    },
  );
  async function discover() {
    if (request.pending) return;
    const values = fields.validate();
    if (values === undefined) return;
    const attempt = request.begin();
    setFailure(undefined);
    try {
      const domain = federationDomainNameSchema.parse(values.domain),
        discovery = await discoverOrganizationSignIn(
          apiClient,
          domain,
          attempt.signal,
        );
      if (attempt.isCurrent()) {
        setFound({ domain, discovery });
        if (discovery.providers.length === 0)
          setFailure(
            'Organization sign-in is not configured for this domain. Check the domain or contact your workspace owner.',
          );
      }
    } catch (cause: unknown) {
      if (attempt.isCurrent())
        setFailure(
          isApiError(cause) && cause.status === 429
            ? 'Too many attempts. Wait a moment and try again.'
            : 'Organization sign-in could not be checked. Try again in a moment.',
        );
    } finally {
      attempt.finish();
    }
  }
  async function start(providerId: string, protocol: FederationProtocol) {
    if (found === undefined || request.pending) return;
    const attempt = request.begin();
    setFailure(undefined);
    try {
      const url = await startOrganizationSignIn(
        apiClient,
        {
          providerId,
          domain: found.domain,
          ...(returnTo === undefined ? {} : { returnPath: returnTo }),
        },
        attempt.signal,
        protocol,
      );
      if (attempt.isCurrent()) navigateToProvider(url);
    } catch {
      if (attempt.isCurrent()) {
        setFailure(
          'Organization sign-in could not start. Try again, or contact your workspace owner.',
        );
        attempt.finish();
      }
    }
  }
  return (
    <div className="mt-6 space-y-4">
      <form
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void discover();
        }}
      >
        <LabelledField
          id={id}
          label="Organization domain"
          {...fields.field('domain')}
          description="Use the domain after @ in your work email."
        >
          {(control) => (
            <Input
              {...control}
              {...fields.control('domain')}
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="example.com"
              disabled={request.pending}
            />
          )}
        </LabelledField>
        <ProgressButton
          type="submit"
          variant="primary"
          className="w-full"
          pending={request.pending}
          pendingLabel="Checking…"
        >
          Find sign-in
        </ProgressButton>
      </form>
      {found?.discovery.required ? (
        <p className="text-sm text-muted-foreground">
          Your organization requires SSO for this domain.
        </p>
      ) : null}
      {found?.discovery.providers.map((provider) => (
        <Button
          key={provider.id}
          type="button"
          variant="outline"
          className="w-full"
          disabled={request.pending}
          onClick={() => void start(provider.id, provider.kind)}
        >
          Continue with {provider.name}
        </Button>
      ))}
      {failure === undefined ? null : <Notice tone="warning">{failure}</Notice>}
    </div>
  );
}
