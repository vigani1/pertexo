import { useId } from 'react';
import { federationOrganizationCreateSchema } from '@pertexo/contracts';
import { SettingsSection } from '@/components/patterns/settings-section';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ProgressButton } from '@/components/ui/progress-button';
import { useFieldValues } from '@/components/ui/use-field-validation';
import type { FederationScope } from '../../data/settings.api';
import { useFederationCommand } from '../../data/use-command';
import { CommandFeedback } from '../command-feedback';
export function CreateOrganization({
  scope,
  editable,
}: Readonly<{ scope: FederationScope; editable: boolean }>) {
  const id = useId();
  const fields = useFieldValues(
    {
      name: (value: string) =>
        federationOrganizationCreateSchema.shape.name.safeParse(value).success
          ? undefined
          : 'Enter a name of up to 128 characters.',
    },
    { name: '' },
  );
  const command = useFederationCommand(scope, () => {
    fields.reset();
  });
  const locked = !editable || command.pending || command.uncertain;
  return (
    <SettingsSection
      title="Identity organization"
      description="Group workspaces under one owner-managed sign-in policy. SSO remains optional until you require it for a verified domain."
    >
      <form
        noValidate
        className="max-w-xl space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const values = fields.validate();
          if (values !== undefined && !locked)
            void command.send({
              kind: 'createOrganization',
              input: { name: values.name.trim() },
            });
        }}
      >
        <LabelledField
          id={id}
          label="Organization name"
          {...fields.field('name')}
        >
          {(control) => (
            <Input
              {...control}
              {...fields.control('name')}
              disabled={locked}
              autoComplete="organization"
            />
          )}
        </LabelledField>
        <ProgressButton
          type="submit"
          pending={command.pending}
          pendingLabel="Creating…"
          disabled={locked}
        >
          Create organization
        </ProgressButton>
        <CommandFeedback command={command} />
      </form>
    </SettingsSection>
  );
}
