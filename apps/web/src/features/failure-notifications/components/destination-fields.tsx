import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import { Link } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  Field,
  FieldDescription,
  FieldLabel,
  LabelledField,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { FieldValidation } from '@/components/ui/use-field-validation';
import {
  usableConnections,
  type DestinationField,
  type DestinationKind,
} from '../model/destination-copy';

export type DestinationValues = Readonly<{
  kind: DestinationKind;
  connectionId: string | null;
  target: string;
}>;

const KIND_WORDS: Readonly<Record<DestinationKind, string>> = {
  slack: 'Slack',
  email: 'email',
};

/** Type, connection and channel or recipient — the whole destination form. */
export function DestinationFields({
  id,
  workspaceId,
  values,
  editing,
  disabled,
  connections,
  channelHint,
  validation,
  errorsFor,
  onChange,
}: Readonly<{
  id: string;
  workspaceId: string;
  values: DestinationValues;
  editing: boolean;
  disabled: boolean;
  connections: readonly ConnectionResponse[];
  /** The saved channel's name, or why it isn't shown. */
  channelHint?: string | undefined;
  validation: FieldValidation<DestinationField>;
  errorsFor: (
    values: DestinationValues,
  ) => Readonly<Partial<Record<DestinationField, string | undefined>>>;
  onChange: (values: DestinationValues) => void;
}>) {
  const usable = usableConnections(connections, values.kind);
  const update = (next: DestinationValues, field?: DestinationField) => {
    onChange(next);
    if (field !== undefined) validation.change(field, errorsFor(next)[field]);
  };
  const blurTarget = () => {
    validation.blur('target', errorsFor(values).target);
  };

  return (
    <>
      <Field>
        <FieldLabel id={`${id}-kind-label`}>Send alerts to</FieldLabel>
        <ToggleGroup
          aria-labelledby={`${id}-kind-label`}
          value={[values.kind]}
          disabled={editing || disabled}
          onValueChange={(next) => {
            const [kind] = next;
            if (
              (kind === 'slack' || kind === 'email') &&
              kind !== values.kind
            ) {
              validation.reset();
              update({ kind, connectionId: null, target: '' });
            }
          }}
        >
          <ToggleGroupItem value="slack">Slack channel</ToggleGroupItem>
          <ToggleGroupItem value="email">Email</ToggleGroupItem>
        </ToggleGroup>
        {editing ? (
          <FieldDescription>
            To switch between Slack and email, add a new destination.
          </FieldDescription>
        ) : null}
      </Field>
      <LabelledField
        id={`${id}-connection`}
        label={
          values.kind === 'slack' ? 'Slack connection' : 'Email connection'
        }
        description={
          usable.length === 0
            ? `There’s no working ${KIND_WORDS[values.kind]} connection yet. Add one first.`
            : undefined
        }
        error={validation.error('connection')}
        thread={validation.thread('connection')}
        // Beside the label, so the validation thread sits under the Select.
        labelAction={
          <Link
            to="/w/$workspaceId/connections"
            params={{ workspaceId }}
            search={{ add: values.kind }}
            className={buttonVariants({ variant: 'link', size: 'sm' })}
          >
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            New {KIND_WORDS[values.kind]} connection
          </Link>
        }
      >
        {(control) => (
          <Select
            value={values.connectionId}
            disabled={disabled}
            items={usable.map((connection) => ({
              value: connection.id,
              label: connection.name,
            }))}
            onValueChange={(connectionId: string | null) => {
              update({ ...values, connectionId }, 'connection');
            }}
          >
            <SelectTrigger {...control} ref={validation.register('connection')}>
              <SelectValue placeholder="Choose a connection" />
            </SelectTrigger>
            <SelectContent>
              {usable.map((connection) => (
                <SelectItem key={connection.id} value={connection.id}>
                  {connection.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </LabelledField>
      <LabelledField
        id={`${id}-target`}
        label={values.kind === 'slack' ? 'Channel ID' : 'Recipient email'}
        description={
          values.kind === 'slack'
            ? `${channelHint === undefined ? '' : `${channelHint} `}In Slack, open the channel’s details: the ID starting with C is at the bottom. Invite the bot to the channel too.`
            : 'Pertexo emails this address whenever a run fails.'
        }
        error={validation.error('target')}
        thread={validation.thread('target')}
      >
        {(control) => (
          <Input
            {...control}
            ref={validation.register('target')}
            name="target"
            autoComplete={values.kind === 'email' ? 'email' : 'off'}
            spellCheck={false}
            placeholder={
              values.kind === 'slack' ? 'C0123456789' : 'oncall@yourdomain.com'
            }
            disabled={disabled}
            value={values.target}
            onChange={(event) => {
              update(
                { ...values, target: event.currentTarget.value },
                'target',
              );
            }}
            onBlur={blurTarget}
          />
        )}
      </LabelledField>
    </>
  );
}
