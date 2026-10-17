import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  auditRetentionSchema,
  type GovernanceSettings,
} from '@pertexo/contracts';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import { useFieldValues } from '@/components/ui/use-field-validation';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { saveSettings, type GovernanceScope } from '../data/audit.api';
import { governanceKeys, governanceQueryOptions } from '../data/audit.queries';
export function AuditRetention({
  scope,
  snapshot,
  editable,
}: Readonly<{
  scope: GovernanceScope;
  snapshot: GovernanceSettings;
  editable: boolean;
}>) {
  const id = useId(),
    cache = useQueryClient();
  const [base, setBase] = useState(snapshot);
  const fields = useFieldValues(
    {
      days: (value: string) =>
        auditRetentionSchema.safeParse(Number(value)).success
          ? undefined
          : 'Choose 30 to 2,555 days.',
    },
    { days: String(snapshot.auditRetentionDays) },
  );
  const command = useRetainedCommand(
    (
      body: { expectedRevision: number; auditRetentionDays: number },
      key: string,
    ) => saveSettings(scope, body, key),
    async (result) => {
      setBase(result);
      cache.setQueryData(governanceQueryOptions(scope).queryKey, result);
      await cache.invalidateQueries({ queryKey: governanceKeys.scope(scope) });
    },
    { action: 'saving audit retention' },
  );
  const stale = snapshot.revision !== base.revision;
  const locked = !editable || command.pending || command.uncertain;
  return (
    <form
      className="flex max-w-lg flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = fields.validate();
        if (parsed !== undefined && !locked && !stale)
          void command.send({
            expectedRevision: base.revision,
            auditRetentionDays: Number(parsed.days),
          });
      }}
    >
      <LabelledField
        id={id}
        label="Keep audit events (days)"
        error={fields.error('days')}
        description="Default 365 days. Reducing retention permanently deletes older audit events during cleanup."
      >
        {(control) => (
          <Input
            {...control}
            {...fields.control('days')}
            type="number"
            min={30}
            max={2555}
            step={1}
            disabled={locked}
          />
        )}
      </LabelledField>
      {stale ? (
        <Notice tone="warning">
          Settings changed. Your edit is kept.{' '}
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setBase(snapshot);
              fields.reset({ days: String(snapshot.auditRetentionDays) });
              command.reset();
            }}
          >
            Reload settings
          </Button>
        </Notice>
      ) : null}
      <div>
        <ProgressButton
          type="submit"
          variant="outline"
          pending={command.pending}
          pendingLabel="Saving…"
          disabled={
            locked ||
            stale ||
            Number(fields.values.days) === base.auditRetentionDays
          }
        >
          Save retention
        </ProgressButton>
      </div>
      {command.error === undefined ? null : (
        <Notice tone="warning">
          {command.error}
          {command.uncertain ? (
            <Button
              type="button"
              variant="outline"
              onClick={command.retry}
              disabled={command.pending || command.expired}
            >
              Retry same save
            </Button>
          ) : null}
        </Notice>
      )}
      {command.data === undefined ? null : (
        <p role="status" className="text-sm text-muted-foreground">
          Retention saved.
        </p>
      )}
    </form>
  );
}
