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
import { Notice } from '@/components/patterns/notices/inline-notice';
import { useFieldValues } from '@/components/ui/use-field-validation';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { retryAfterSeconds } from '@/lib/api/error-copy';
import { signInsLimitedFromNetwork } from '@/features/auth/public';
import {
  useDomainDiscovery,
  useOrganizationSignInStart,
} from '../data/sign-in-journeys';
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
    discovery = useDomainDiscovery(apiClient),
    starting = useOrganizationSignInStart(apiClient),
    request = { pending: discovery.pending || starting.pending };
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
    setFailure(undefined);
    const domain = federationDomainNameSchema.parse(values.domain);
    const outcome = await discovery.run(domain);
    if (outcome.kind === 'done') {
      setFound({ domain, discovery: outcome.value });
      if (outcome.value.providers.length === 0)
        setFailure(
          'Organization sign-in is not configured for this domain. Check the domain or contact your workspace owner.',
        );
    } else if (outcome.kind === 'failed')
      setFailure(
        isLimited(outcome.cause)
          ? signInsLimitedFromNetwork(retryAfterSeconds(outcome.cause))
          : 'Organization sign-in could not be checked. Try again in a moment.',
      );
  }
  async function start(providerId: string, protocol: FederationProtocol) {
    if (found === undefined || request.pending) return;
    setFailure(undefined);
    const outcome = await starting.run({
      providerId,
      domain: found.domain,
      protocol,
      returnTo,
    });
    if (outcome.kind === 'done') navigateToProvider(outcome.value);
    else if (outcome.kind === 'failed')
      setFailure(
        isLimited(outcome.cause)
          ? signInsLimitedFromNetwork(retryAfterSeconds(outcome.cause))
          : 'Organization sign-in could not start. Try again, or contact your workspace owner.',
      );
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

function isLimited(cause: unknown): boolean {
  return isApiError(cause) && cause.status === 429;
}
