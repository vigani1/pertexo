import { useQuery } from '@tanstack/react-query';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { SettingsSection } from '@/components/patterns/settings/section';
import { ReadFailure } from '@/components/patterns/states/read-failure';
import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
import type { GovernanceScope } from '../data/audit.api';
import { governanceQueryOptions } from '../data/audit.queries';
import { PublicationPolicy } from './publication-policy';
import { AuditRetention } from './retention';

export function GovernanceSettings({
  scope,
  workspace,
}: Readonly<{ scope: GovernanceScope; workspace: AccessibleWorkspace }>) {
  const settings = useQuery(governanceQueryOptions(scope));
  if (settings.isError && settings.data === undefined)
    return (
      <SettingsSection
        title="Governance settings"
        description="Publishing approval and audit retention."
      >
        <Notice
          tone="warning"
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => void settings.refetch()}
            >
              Retry settings
            </Button>
          }
        >
          Governance settings could not be loaded.
        </Notice>
      </SettingsSection>
    );
  if (settings.data === undefined)
    return <p role="status">Loading governance settings…</p>;
  const editable =
    workspace.status === 'active' &&
    workspace.capabilities.includes('governance:manage');
  return (
    <>
      {settings.isError ? (
        <ReadFailure
          resource="Governance settings"
          error={settings.error}
          showing
          retrying={settings.isFetching}
          updatedAt={settings.dataUpdatedAt}
          onRetry={() => void settings.refetch()}
        />
      ) : null}
      <SettingsSection
        title="Publishing approval"
        description="Require another owner or admin to review each saved draft before it becomes live."
      >
        <PublicationPolicy
          scope={scope}
          snapshot={settings.data}
          editable={editable}
        />
      </SettingsSection>
      <SettingsSection
        title="Audit retention"
        description="Owners and admins can keep events for 30 to 2,555 days. Run data retention is separate."
      >
        <AuditRetention
          scope={scope}
          snapshot={settings.data}
          editable={editable}
        />
      </SettingsSection>
    </>
  );
}
