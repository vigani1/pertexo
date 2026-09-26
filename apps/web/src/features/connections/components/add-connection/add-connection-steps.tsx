import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import type { FieldValidation } from '@/components/ui/use-field-validation';
import { cn } from '@/lib/utils';
import {
  connectionNameError,
  describeConnectionKind,
  PROVIDERS,
  type ProviderKey,
} from '../../model/connection-providers';
import type { SavedCredential } from '../../model/credential-draft';
import type { ConnectionTest } from '../../use-connection-test';
import { ConnectionTestPanel } from '../connection-test/connection-test-panel';

export type AddStep = 'provider' | 'credential' | 'name' | 'test';

const STEP_WORDS: Readonly<Record<Exclude<AddStep, 'provider'>, string>> = {
  credential: 'Credential',
  name: 'Name',
  test: 'Test',
};
const NUMBERED_STEPS = ['credential', 'name', 'test'] as const;

/** Three short bars: done steps dimmed, the current one lit, one colour. */
export function StepIndicator({ step }: Readonly<{ step: AddStep }>) {
  if (step === 'provider') return null;
  const current = NUMBERED_STEPS.indexOf(step);
  return (
    <div className="flex flex-col gap-2">
      <div aria-hidden="true" className="flex gap-1.5">
        {NUMBERED_STEPS.map((candidate, index) => (
          <span
            key={candidate}
            className={cn(
              'h-0.75 flex-1 rounded-full bg-white/10 transition-colors',
              index < current && 'bg-action/40',
              index === current && 'bg-action',
            )}
          />
        ))}
      </div>
      <p className="font-mono text-[0.72rem] text-subtle-foreground">
        Step {current + 1} of 3 · {STEP_WORDS[step]}
      </p>
    </div>
  );
}

export function NameStep({
  id,
  provider,
  name,
  disabled,
  validation,
  onNameChange,
  commandError,
  uncertain,
}: Readonly<{
  id: string;
  provider: ProviderKey;
  name: string;
  disabled: boolean;
  validation: FieldValidation<'name'>;
  onNameChange: (name: string) => void;
  /** The failed save in words; unconfirmed saves read as "check", not "failed". */
  commandError: string | undefined;
  uncertain: boolean;
}>) {
  return (
    <div className="flex flex-col gap-5">
      <LabelledField
        id={`${id}-name`}
        label="Connection name"
        description="People pick connections by this name in steps and alerts."
        error={validation.error('name')}
      >
        {(control) => (
          <Input
            {...control}
            ref={validation.register('name')}
            name="name"
            autoComplete="off"
            maxLength={128}
            disabled={disabled}
            value={name}
            onChange={(event) => {
              const next = event.currentTarget.value;
              onNameChange(next);
              validation.change('name', connectionNameError(next));
            }}
          />
        )}
      </LabelledField>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-subtle-foreground">Saves</dt>
        <dd>{describeConnectionKind(provider)}, stored encrypted</dd>
        <dt className="text-subtle-foreground">Works with</dt>
        <dd>{PROVIDERS[provider].usedBy}</dd>
      </dl>
      {commandError === undefined ? null : (
        <Notice role="alert" tone={uncertain ? 'warning' : 'destructive'}>
          {commandError}
        </Notice>
      )}
    </div>
  );
}

/**
 * The saved connection, tested straight away where nothing else is needed,
 * with a summary of what was stored: its name and the credential, masked.
 */
export function TestStep({
  connection,
  saved,
  test,
}: Readonly<{
  connection: ConnectionResponse;
  saved: SavedCredential | undefined;
  test: ConnectionTest;
}>) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">{connection.name}</span>{' '}
        is saved. {PROVIDERS[connection.providerKey].usedBy} can use it.
      </p>
      <ConnectionTestPanel
        provider={connection.providerKey}
        test={test}
        onRun={(request) => {
          test.run(connection, request);
        }}
      />
      <section
        aria-labelledby="add-connection-summary"
        className="rounded-lg border border-white/6 bg-black/20 p-3.5"
      >
        <h3
          id="add-connection-summary"
          className="font-sans text-xs font-semibold text-subtle-foreground"
        >
          Summary
        </h3>
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-subtle-foreground">Name</dt>
          <dd className="min-w-0 truncate">{connection.name}</dd>
          {saved === undefined ? null : (
            <>
              <dt className="text-subtle-foreground">{saved.term}</dt>
              <dd className="min-w-0">
                <span className="font-mono text-[0.8rem] break-all">
                  {saved.value}
                </span>
                <span className="block text-xs text-muted-foreground">
                  Stored encrypted, never shown again.
                </span>
              </dd>
            </>
          )}
        </dl>
      </section>
    </div>
  );
}
