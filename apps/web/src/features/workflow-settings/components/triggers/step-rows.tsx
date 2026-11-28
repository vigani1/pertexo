import type { WorkflowVersionResponse } from '@pertexo/contracts';
import { buttonVariants } from '@/components/ui/button-variants';
import { CopyButton } from '@/components/ui/copy-button';
import { Link, useRouter } from '@tanstack/react-router';
import { StepTile } from '@/features/catalog/catalog-views.public';
import { describeStep } from '@/features/catalog/public';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { publishedStepNames } from '../../model/triggers/steps';
import { TriggerRow } from './trigger-row';

/**
 * The ways in the server keeps no trigger record of: each form step, each
 * failure trigger, and starting a run by hand, which is always on.
 */
export function StepTriggerRows({
  versions,
  publishedVersionId,
  form,
  formsPaused,
  formLink,
  onFailure,
}: Readonly<{
  versions: readonly WorkflowVersionResponse[] | undefined;
  publishedVersionId: string | null | undefined;
  form: boolean;
  formsPaused: boolean;
  formLink?: Readonly<{ workspaceId: string; workflowId: string }>;
  onFailure: boolean;
}>) {
  const router = useRouter();
  const formHref =
    formLink === undefined
      ? undefined
      : router.buildLocation({
          to: '/w/$workspaceId/forms/$workflowId',
          params: formLink,
        }).href;
  const steps = (key: string) =>
    publishedStepNames(versions, publishedVersionId, key);
  return (
    <>
      {form
        ? steps('core.form').map((step) => (
            <TriggerRow
              key={step.nodeId}
              label={`Form: ${step.name}`}
              icon={<StepTile step={describeStep('core.form')} />}
              name={step.name}
              kind="Form · starts a run on submission"
              extra={
                formLink === undefined || formHref === undefined ? null : (
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to="/w/$workspaceId/forms/$workflowId"
                      params={formLink}
                      className={buttonVariants({
                        variant: 'link',
                        size: 'sm',
                      })}
                    >
                      Open form
                    </Link>
                    <CopyButton
                      label="Copy form link"
                      value={new URL(formHref, window.location.origin).href}
                    />
                  </div>
                )
              }
              state={
                formsPaused ? (
                  <StatusMark tone="off">Paused</StatusMark>
                ) : (
                  <StatusMark tone="success">On</StatusMark>
                )
              }
            />
          ))
        : null}
      {onFailure
        ? steps('core.workflow_error').map((step) => (
            <TriggerRow
              key={step.nodeId}
              label={`On failure: ${step.name}`}
              icon={<StepTile step={describeStep('core.workflow_error')} />}
              name={step.name}
              kind="When a workflow fails · each workflow chooses its error workflow in its own Settings"
              state={<StatusMark tone="success">On</StatusMark>}
            />
          ))
        : null}
      <TriggerRow
        label="By hand"
        icon={<StepTile step={describeStep('core.manual')} />}
        name="By hand"
        kind="Manual · anyone who can run this workflow fills its inputs, then starts it"
        state={
          <span className="text-meta text-subtle-foreground">Always on</span>
        }
      />
    </>
  );
}

/** Where to stop every trigger at once, and where new ones come from. */
export function TriggerFootnotes({
  workspaceId,
  workflowId,
  editable,
  readers,
}: Readonly<{
  workspaceId: string;
  workflowId: string;
  editable: boolean;
  /** Who sees webhooks, for people who don't. */
  readers: string;
}>) {
  return (
    <div className="mt-3 flex flex-col gap-1.5 text-meta text-subtle-foreground">
      {editable ? null : (
        <p>Webhook addresses and deliveries are shown to {readers}.</p>
      )}
      <p>
        Schedules can be switched off one by one. To stop webhooks and forms
        too,{' '}
        <Link
          to="/w/$workspaceId/workflows/$workflowId/settings"
          params={{ workspaceId, workflowId }}
          className="inline-link"
        >
          archive the workflow in Settings
        </Link>
        .
      </p>
      {editable ? (
        <p>
          Polling and “When a workflow fails” can start runs too. Add that
          trigger step in{' '}
          <Link
            to="/w/$workspaceId/workflows/$workflowId"
            params={{ workspaceId, workflowId }}
            className="inline-link"
          >
            Build
          </Link>
          , then publish.
        </p>
      ) : null}
    </div>
  );
}
