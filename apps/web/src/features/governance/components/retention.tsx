import { useId } from 'react';
import {
  auditRetentionSchema,
  AUDIT_RETENTION_MAX_DAYS,
  AUDIT_RETENTION_MIN_DAYS,
  type GovernanceSettings,
} from '@pertexo/contracts';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import { useFieldValues } from '@/components/ui/use-field-validation';
import type { GovernanceScope } from '../data/audit.api';
import { useSettingForm } from '../hooks/use-setting-form';
import { AUDIT_RETENTION_RANGE } from '../model/setting-edit';
export function AuditRetention({
  scope,
  snapshot,
  editable,
}: Readonly<{
  scope: GovernanceScope;
  snapshot: GovernanceSettings;
  editable: boolean;
}>) {
  const id = useId();
  const fields = useFieldValues(
    {
      days: (value: string) =>
        auditRetentionSchema.safeParse(Number(value)).success
          ? undefined
          : `Choose ${AUDIT_RETENTION_RANGE}.`,
    },
    { days: String(snapshot.auditRetentionDays) },
  );
  const { base, command, stale, expectedRevision, adoptSnapshot } =
    useSettingForm(scope, snapshot, 'auditRetentionDays', {
      action: 'saving audit retention',
    });
  const locked = !editable || command.pending || command.uncertain;
  return (
    <form
      className="flex max-w-lg flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = fields.validate();
        if (parsed !== undefined && !locked && !stale)
          void command.send({
            expectedRevision,
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
            min={AUDIT_RETENTION_MIN_DAYS}
            max={AUDIT_RETENTION_MAX_DAYS}
            step={1}
            disabled={locked}
          />
        )}
      </LabelledField>
      {stale ? (
        <Notice tone="warning">
          Someone else changed this setting. Your edit is kept.{' '}
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              adoptSnapshot();
              fields.reset({ days: String(snapshot.auditRetentionDays) });
            }}
          >
            Reload setting
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
