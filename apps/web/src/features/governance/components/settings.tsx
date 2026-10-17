import { useQuery } from '@tanstack/react-query';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { SettingsSection } from '@/components/patterns/settings-section';
import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
import type { GovernanceScope } from '../data/audit.api';
import { governanceQueryOptions } from '../data/audit.queries';
import { AuditRetention } from './retention';
export function GovernanceSettings({
  scope,
  workspace,
}: Readonly<{ scope: GovernanceScope; workspace: AccessibleWorkspace }>) {
  const settings = useQuery(governanceQueryOptions(scope));
  return (
    <SettingsSection
      title="Audit retention"
      description="Owners and admins can keep events for 30 to 2,555 days. Run data retention is separate."
    >
      {settings.isError ? (
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
          Retention settings could not be loaded.
        </Notice>
      ) : settings.data === undefined ? (
        <p role="status">Loading retention…</p>
      ) : (
        <AuditRetention
          scope={scope}
          snapshot={settings.data}
          editable={
            workspace.status === 'active' &&
            workspace.capabilities.includes('governance:manage')
          }
        />
      )}
    </SettingsSection>
  );
}
