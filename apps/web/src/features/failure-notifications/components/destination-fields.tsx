import { SystemMailFields } from './system-mail-fields';
import type { DestinationMutationScope } from '../data/failure-notifications.mutations';
import type { FailureNotificationDestinationList } from '../data/failure-notifications.api';
import type { ConnectionResponse } from '@pertexo/contracts';
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
import { Notice } from '@/components/ui/notice';
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
  system_mail: 'server mail',
};

/** Type, connection and channel or recipient — the whole destination form. */
type DestinationFieldsProps = Readonly<{
  id: string;
  workspaceId: string;
  scope: DestinationMutationScope;
  systemMail: FailureNotificationDestinationList['systemMail'];
  editing: boolean;
  disabled: boolean;
  connections: readonly ConnectionResponse[];
  /** The saved channel's name, or why it isn't shown. */
  channelHint?: string | undefined;
  form: Readonly<{
    values: DestinationValues;
    validation: FieldValidation<DestinationField>;
    errorsFor: (
      values: DestinationValues,
    ) => Readonly<Partial<Record<DestinationField, string | undefined>>>;
    onChange: (values: DestinationValues) => void;
  }>;
}>;

export function DestinationFields({
  id,
  workspaceId,
  scope,
  systemMail,
  editing,
  disabled,
  connections,
  channelHint,
  form,
}: DestinationFieldsProps) {
  const { values, validation, errorsFor, onChange } = form;

  const usable = usableConnections(connections, values.kind);
  const update = (next: DestinationValues, field?: DestinationField) => {
    onChange(next);
    if (field !== undefined) validation.change(field, errorsFor(next)[field]);
  };

  const kindField = (
    <DestinationKindField
      id={id}
      editing={editing}
      disabled={disabled}
      kind={values.kind}
      systemMail={systemMail}
      onChange={(kind) => {
        validation.reset();
        update({ kind, connectionId: null, target: '' });
      }}
    />
  );
  if (values.kind === 'system_mail')
    return (
      <>
        {kindField}
        <SystemMailFields
          scope={scope}
          id={id}
          disabled={disabled}
          memberId={values.target}
          validation={validation}
          onChange={(target) => {
            update({ ...values, target }, 'target');
          }}
        />
      </>
    );
  return (
    <>
      {kindField}
      {/* Nothing to choose yet: one way on instead of fields that can't be
          filled in. */}
      {usable.length === 0 && !editing ? (
        <MissingDestinationConnection
          workspaceId={workspaceId}
          kind={values.kind}
        />
      ) : (
        <>
          <LabelledField
            id={`${id}-connection`}
            label={
              values.kind === 'slack' ? 'Slack connection' : 'Email connection'
            }
            error={validation.error('connection')}
            // Beside the label, so the validation thread sits under the Select.
            slots={{
              labelAction: (
                <Link
                  to="/w/$workspaceId/connections"
                  params={{ workspaceId }}
                  search={{ add: values.kind }}
                  className={buttonVariants({ variant: 'link', size: 'sm' })}
                >
                  <PlusIcon data-icon="inline-start" aria-hidden="true" />
                  New {KIND_WORDS[values.kind]} connection
                </Link>
              ),
            }}
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
                <SelectTrigger
                  {...control}
                  ref={validation.register('connection')}
                >
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
          >
            {(control) => (
              <Input
                {...control}
                ref={validation.register('target')}
                name="target"
                autoComplete={values.kind === 'email' ? 'email' : 'off'}
                spellCheck={false}
                placeholder={
                  values.kind === 'slack'
                    ? 'C0123456789'
                    : 'oncall@yourdomain.com'
                }
                disabled={disabled}
                value={values.target}
                onChange={(event) => {
                  update(
                    { ...values, target: event.currentTarget.value },
                    'target',
                  );
                }}
              />
            )}
          </LabelledField>
        </>
      )}
    </>
  );
}

function MissingDestinationConnection({
  workspaceId,
  kind,
}: Readonly<{
  workspaceId: string;
  kind: Exclude<DestinationKind, 'system_mail'>;
}>) {
  return (
    <Notice
      tone="info"
      action={
        <Link
          to="/w/$workspaceId/connections"
          params={{ workspaceId }}
          search={{ add: kind }}
          className={buttonVariants({ variant: 'default', size: 'sm' })}
        >
          <PlusIcon data-icon="inline-start" aria-hidden="true" />
          Connect {KIND_WORDS[kind]}
        </Link>
      }
    >
      Alerts go through a {KIND_WORDS[kind]} connection, and there isn’t a
      working one yet. Connect {KIND_WORDS[kind]}, then come back to choose it
      here.
    </Notice>
  );
}

function DestinationKindField({
  id,
  editing,
  disabled,
  kind,
  systemMail,
  onChange,
}: Readonly<{
  id: string;
  editing: boolean;
  disabled: boolean;
  kind: DestinationKind;
  systemMail: FailureNotificationDestinationList['systemMail'];
  onChange(kind: DestinationKind): void;
}>) {
  return (
    <Field>
      <FieldLabel id={`${id}-kind-label`}>Send alerts to</FieldLabel>
      <ToggleGroup
        aria-labelledby={`${id}-kind-label`}
        className="max-w-full flex-wrap"
        value={[kind]}
        disabled={editing || disabled}
        onValueChange={(next) => {
          const [choice] = next;
          if (
            (choice === 'slack' ||
              choice === 'email' ||
              choice === 'system_mail') &&
            choice !== kind
          )
            onChange(choice);
        }}
      >
        <ToggleGroupItem value="slack">Slack channel</ToggleGroupItem>
        <ToggleGroupItem value="email">Email</ToggleGroupItem>
        <ToggleGroupItem
          value="system_mail"
          disabled={systemMail?.available !== true}
        >
          Send with this server's mail
        </ToggleGroupItem>
      </ToggleGroup>
      {systemMail?.available !== true ? (
        <FieldDescription>
          {systemMail?.reason ?? 'This server has no system mail configured.'}
        </FieldDescription>
      ) : null}
      {editing ? (
        <FieldDescription>
          To switch delivery methods, add a new destination.
        </FieldDescription>
      ) : null}
    </Field>
  );
}
