import { useId, useState } from 'react';
import { connectionTestRequestSchema } from '@pertexo/contracts/schemas/connections';
import type { ConnectionTestRequest } from '@pertexo/contracts/schemas/connections';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldError,
  LabelledField,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Notice } from '@/components/ui/notice';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { describeTestOutcome } from '../../model/connection-health';
import type { ProviderKey } from '../../model/connection-providers';
import type { ConnectionTest } from '../../use-connection-test';
import { TestThread } from './test-thread';

type TestField = 'url' | 'acknowledged';

const INTRO: Readonly<Record<ProviderKey, string>> = {
  slack: 'Pertexo asks Slack whether the token works. Nothing is posted.',
  http: 'Pertexo calls an address with these headers to see whether they work.',
  email:
    'Pertexo sends one real email through Resend to see whether the key works.',
};

const RUN_LABEL: Readonly<Record<ProviderKey, string>> = {
  slack: 'Test connection',
  http: 'Call this address',
  email: 'Send test email',
};

function urlError(url: string): string | undefined {
  const value = url.trim();
  if (value === '') return 'Enter the https address to call.';
  return connectionTestRequestSchema.safeParse({ url: value }).success
    ? undefined
    : 'Use a full https:// address, without a username or #section.';
}

function TestOutcome({
  provider,
  test,
}: Readonly<{
  provider: ProviderKey;
  test: Pick<ConnectionTest, 'phase' | 'result' | 'error'>;
}>) {
  if (test.phase === 'running')
    return <p className="text-sm text-muted-foreground">Testing…</p>;
  if (test.result !== undefined && test.phase !== 'unsure') {
    const copy = describeTestOutcome(provider, test.result.outcome);
    return (
      <Notice
        tone={test.result.outcome.ok ? 'success' : 'destructive'}
        title={copy.title}
      >
        {copy.detail}
      </Notice>
    );
  }
  if (test.error !== undefined)
    return (
      <Notice tone={test.phase === 'unsure' ? 'warning' : 'destructive'}>
        {test.error}
      </Notice>
    );
  return <p className="text-sm text-muted-foreground">{INTRO[provider]}</p>;
}

/**
 * Runs a connection test and draws it. HTTP asks for an address to call and
 * email asks people to accept that a real message is sent first.
 */
export function ConnectionTestPanel({
  provider,
  test,
  onRun,
  disabled = false,
}: Readonly<{
  provider: ProviderKey;
  test: Pick<ConnectionTest, 'phase' | 'result' | 'error'>;
  onRun: (request: ConnectionTestRequest) => void;
  disabled?: boolean;
}>) {
  const id = useId();
  const [url, setUrl] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const validation = useFieldValidation<TestField>();
  const running = test.phase === 'running';

  function request(): ConnectionTestRequest | undefined {
    if (provider === 'slack') return { providerKey: 'slack' };
    if (provider === 'http')
      return validation.submit({ url: urlError(url) })
        ? { url: url.trim() }
        : undefined;
    return validation.submit({
      acknowledged: acknowledged
        ? undefined
        : 'Tick this to allow the test email.',
    })
      ? { providerKey: 'email', sideEffectDisclosureAccepted: true }
      : undefined;
  }

  const acknowledgementError = validation.error('acknowledged');

  return (
    <div className="flex flex-col gap-4">
      <TestThread provider={provider} phase={test.phase} />
      <div role="status" aria-live="polite">
        <TestOutcome provider={provider} test={test} />
      </div>
      {provider === 'http' ? (
        <LabelledField
          id={`${id}-url`}
          label="Address to call"
          description="Pertexo sends a GET request with your headers, like https://api.example.com/me."
          error={validation.error('url')}
          thread={validation.thread('url')}
        >
          {(control) => (
            <Input
              {...control}
              ref={validation.register('url')}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://"
              maxLength={2_048}
              disabled={disabled || running}
              value={url}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setUrl(next);
                validation.change('url', urlError(next));
              }}
              onBlur={() => {
                validation.blur('url', urlError(url));
              }}
            />
          )}
        </LabelledField>
      ) : null}
      {provider === 'email' ? (
        <Field
          data-invalid={acknowledgementError === undefined ? undefined : true}
        >
          <label
            htmlFor={`${id}-ack`}
            className="flex items-start gap-2.5 text-sm font-medium"
          >
            <Checkbox
              id={`${id}-ack`}
              ref={validation.register('acknowledged')}
              className="mt-0.5"
              checked={acknowledged}
              disabled={disabled || running}
              aria-invalid={acknowledgementError !== undefined}
              aria-describedby={`${id}-ack-description${acknowledgementError === undefined ? '' : ` ${id}-ack-error`}`}
              onCheckedChange={(checked) => {
                setAcknowledged(checked);
                validation.change(
                  'acknowledged',
                  checked ? undefined : 'Tick this to allow the test email.',
                );
              }}
            />
            Send a real test email
          </label>
          <FieldDescription id={`${id}-ack-description`}>
            Resend delivers it to its own test inbox and counts it toward your
            Resend usage.
          </FieldDescription>
          {acknowledgementError === undefined ? null : (
            <FieldError id={`${id}-ack-error`}>
              {acknowledgementError}
            </FieldError>
          )}
        </Field>
      ) : null}
      <Button
        type="button"
        variant="default"
        className="self-start"
        disabled={disabled || running}
        onClick={() => {
          const next = request();
          if (next !== undefined) onRun(next);
        }}
      >
        {running ? <LoadingOrb data-icon="inline-start" /> : null}
        {running
          ? 'Testing…'
          : test.phase === 'idle'
            ? RUN_LABEL[provider]
            : 'Test again'}
      </Button>
    </div>
  );
}
