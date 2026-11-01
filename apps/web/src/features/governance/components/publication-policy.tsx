import { useId, useState } from 'react';
import type { GovernanceSettings } from '@pertexo/contracts';
import { LabelledField, FieldGroup } from '@/components/ui/field';
import { Checkbox } from '@/components/ui/checkbox';
import { ProgressButton } from '@/components/ui/progress-button';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { isApiError } from '@/lib/api/error';
import type { GovernanceScope } from '../data/audit.api';
import { useSettingForm } from '../hooks/use-setting-form';
export function PublicationPolicy({
  scope,
  snapshot,
  editable,
}: Readonly<{
  scope: GovernanceScope;
  snapshot: GovernanceSettings;
  editable: boolean;
}>) {
  const id = useId();
  const [required, setRequired] = useState(snapshot.requirePublishApproval);
  const { base, command, stale, expectedRevision, adoptSnapshot } =
    useSettingForm(scope, snapshot, 'requirePublishApproval', {
      action: 'changing publication approval',
    });
  const failureMessage =
    !command.uncertain &&
    isApiError(command.cause) &&
    command.cause.problem?.code === 'request.invalid'
      ? (command.cause.problem.detail ?? command.error)
      : command.error;
  const locked = !editable || command.pending || command.uncertain;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!locked && !stale)
          void command.send({
            expectedRevision,
            requirePublishApproval: required,
          });
      }}
    >
      <FieldGroup>
        <LabelledField
          id={id}
          label="Require approval to publish"
          description="Every publisher, including an owner, needs a different owner or admin to approve the exact saved draft. If you are the only eligible reviewer, add another admin before enabling this. Turning it off is audited and invalidates pending requests."
        >
          {(control) => (
            <Checkbox
              {...control}
              checked={required}
              disabled={locked}
              onCheckedChange={setRequired}
            />
          )}
        </LabelledField>
        {stale ? (
          <Notice
            tone="warning"
            action={
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  adoptSnapshot();
                  setRequired(snapshot.requirePublishApproval);
                }}
              >
                Reload setting
              </Button>
            }
          >
            Someone else changed this setting. Your choice is kept; reload
            before saving.
          </Notice>
        ) : null}
        <div>
          <ProgressButton
            type="submit"
            variant="outline"
            pending={command.pending}
            pendingLabel="Saving…"
            disabled={
              locked || stale || required === base.requirePublishApproval
            }
          >
            Save publishing policy
          </ProgressButton>
        </div>
        {failureMessage === undefined ? null : (
          <Notice
            tone="warning"
            action={
              command.uncertain ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={command.retry}
                  disabled={command.pending || command.expired}
                >
                  Retry same change
                </Button>
              ) : undefined
            }
          >
            {failureMessage}
          </Notice>
        )}
        {command.data === undefined ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            Publishing policy saved.
          </p>
        )}
      </FieldGroup>
    </form>
  );
}
