import { useConnectionDefinitions } from '@/features/catalog/public';
import {
  connectionDefinition,
  providerTestRequest,
} from '../../model/connection-providers';
import { Button } from '@/components/ui/button';
import { useId, useState } from 'react';
import { connectionTestRequestSchema } from '@pertexo/contracts';
import type {
  ConnectionFormDefinition,
  ConnectionResponse,
  ConnectionTestRequest,
} from '@pertexo/contracts';
import { ProgressButton } from '@/components/ui/progress-button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldError,
  LabelledField,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { describeTestOutcome, testNouns } from '../../model/connection-health';
import type { ProviderKey } from '../../model/connection-providers';
import type { ConnectionTest } from '../../data/connection-test.mutations';
import { TestThread } from './thread';

type TestField = 'url' | 'acknowledged';

const INTRO = {
  postgres: 'Pertexo connects and runs a simple read-only query.',
  signing:
    'Pertexo checks it can open this key locally. Nothing is sent to another service.',
  http: 'Pertexo calls an address with these headers to see whether they work.',
  smtp: 'Pertexo connects, upgrades TLS when required, authenticates and quits. No email is sent.',
  oauth2:
    'Pertexo gets a token and calls an address with it to see whether it works.',
} as const;

function testIntro(definition: ConnectionFormDefinition): string {
  const { test, testInput } = definition;
  if (test !== 'http' || testInput === 'url') return INTRO[test];
  const { name, credential } = testNouns(definition);
  return testInput === 'consent'
    ? `Pertexo sends one real email through ${name} to see whether the ${credential} works.`
    : `Pertexo asks ${name} whether the ${credential} works.${definition.presentation.testCopy?.introNote ?? ''}`;
}

function runLabel(definition: ConnectionFormDefinition): string {
  if (definition.test === 'signing') return 'Check key access';
  if (definition.testInput === 'url') return 'Call this address';
  if (definition.testInput === 'consent') return 'Send test email';
  return 'Test connection';
}

function urlError(url: string): string | undefined {
  const value = url.trim();
  if (value === '') return 'Enter the https address to call.';
  return connectionTestRequestSchema.safeParse({ url: value }).success
    ? undefined
    : 'Use a full https:// address, without a username or #section.';
}

function TestOutcome({
  definition,
  test,
}: Readonly<{
  definition: ConnectionFormDefinition;
  test: Pick<ConnectionTest, 'phase' | 'result' | 'error'>;
}>) {
  if (test.phase === 'running')
    return <p className="text-sm text-muted-foreground">Testing…</p>;
  if (test.result !== undefined && test.phase !== 'unsure') {
    const copy = describeTestOutcome(definition, test.result.outcome);
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
  return (
    <p className="text-sm text-muted-foreground">{testIntro(definition)}</p>
  );
}

/**
 * Runs a connection test and draws it. HTTP asks for an address to call and
 * email asks people to accept that a real message is sent first.
 */
export function ConnectionTestPanel({
  provider,
  authType,
  test,
  onRun,
  disabled = false,
}: Readonly<{
  provider: ProviderKey;
  authType?: ConnectionResponse['authType'];
  test: Pick<
    ConnectionTest,
    'phase' | 'result' | 'error' | 'expired' | 'startNewAttempt'
  >;
  onRun: (request: ConnectionTestRequest) => void;
  disabled?: boolean;
}>) {
  const definitions = useConnectionDefinitions();
  const definition = connectionDefinition(definitions, provider, authType);
  const usesUrl = definition?.testInput === 'url';
  const id = useId();
  const [url, setUrl] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const validation = useFieldValidation<TestField>();
  const running = test.phase === 'running';

  function request(): ConnectionTestRequest | undefined {
    if (definition === undefined) return undefined;
    if (usesUrl)
      return validation.submit({ url: urlError(url) })
        ? { url: url.trim() }
        : undefined;
    if (
      definition.testInput === 'consent' &&
      !validation.submit({
        acknowledged: acknowledged
          ? undefined
          : 'Tick this to allow the test email.',
      })
    )
      return undefined;
    return providerTestRequest(definition);
  }

  if (definition === undefined) return null;
  const acknowledgementError = validation.error('acknowledged');

  return (
    <div className="flex flex-col gap-4">
      <TestThread provider={provider} phase={test.phase} />
      <div role="status" aria-live="polite">
        <TestOutcome definition={definition} test={test} />
      </div>
      {usesUrl ? (
        <LabelledField
          id={`${id}-url`}
          label="Address to call"
          description={`Pertexo sends a GET request with your ${definition.test === 'oauth2' ? 'token' : 'headers'}, like https://api.example.com/me.`}
          error={validation.error('url')}
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
            />
          )}
        </LabelledField>
      ) : null}
      {definition.testInput === 'consent' ? (
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
            {definition.presentation.testCopy?.consentDetail}
          </FieldDescription>
          {acknowledgementError === undefined ? null : (
            <FieldError id={`${id}-ack-error`}>
              {acknowledgementError}
            </FieldError>
          )}
        </Field>
      ) : null}
      {test.expired ? (
        <Button
          type="button"
          onClick={() => {
            setAcknowledged(false);
            test.startNewAttempt();
          }}
        >
          Start a new attempt
        </Button>
      ) : null}
      <ProgressButton
        type="button"
        variant="default"
        className="self-start"
        pending={running}
        pendingLabel="Testing…"
        disabled={disabled || test.expired}
        onClick={() => {
          const next = request();
          if (next !== undefined) onRun(next);
        }}
      >
        {test.phase === 'idle' ? runLabel(definition) : 'Test again'}
      </ProgressButton>
    </div>
  );
}
