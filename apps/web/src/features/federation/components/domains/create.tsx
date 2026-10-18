import { useId } from 'react';
import { federationDomainNameSchema } from '@pertexo/contracts';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ProgressButton } from '@/components/ui/progress-button';
import { useFieldValues } from '@/components/ui/use-field-validation';
import type { FederationScope } from '../../data/settings.api';
import { useFederationCommand } from '../../data/use-command';
import { CommandFeedback } from '../command-feedback';
export function CreateDomain({
  scope,
  revision,
  editable,
}: Readonly<{ scope: FederationScope; revision: number; editable: boolean }>) {
  const id = useId();
  const fields = useFieldValues(
    {
      domain: (value: string) =>
        federationDomainNameSchema.safeParse(value).success
          ? undefined
          : 'Enter an exact DNS domain, without a scheme or path.',
    },
    { domain: '' },
  );
  const command = useFederationCommand(scope, () => {
    fields.reset();
  });
  const locked = !editable || command.pending || command.uncertain;
  return (
    <form
      noValidate
      className="max-w-xl space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const values = fields.validate();
        if (values !== undefined && !locked)
          void command.send({
            kind: 'createDomain',
            input: {
              domain: federationDomainNameSchema.parse(values.domain),
              expectedRevision: revision,
            },
          });
      }}
    >
      <LabelledField
        id={id}
        label="Add domain"
        {...fields.field('domain')}
        description="Prove each exact domain with DNS. A parent domain does not claim its subdomains."
      >
        {(control) => (
          <Input
            {...control}
            {...fields.control('domain')}
            placeholder="example.com"
            autoCapitalize="none"
            autoCorrect="off"
            disabled={locked}
          />
        )}
      </LabelledField>
      <ProgressButton
        type="submit"
        variant="outline"
        pending={command.pending}
        pendingLabel="Creating challenge…"
        disabled={locked}
      >
        Create DNS challenge
      </ProgressButton>
      <CommandFeedback command={command} />
    </form>
  );
}
