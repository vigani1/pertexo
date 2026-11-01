import { useQuery } from '@tanstack/react-query';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { SettingsSection } from '@/components/patterns/settings/section';
import { QueryView } from '@/components/patterns/states/query-view';
import type { GovernanceScope } from '../data/audit.api';
import { governanceQueryOptions } from '../data/audit.queries';
import { AUDIT_RETENTION_RANGE } from '../model/setting-edit';
import { PublicationPolicy } from './publication-policy';
import { AuditRetention } from './retention';
import { whoCan } from '@/features/workspaces/roles.public';
import { sentenceStart } from '@/lib/format/sentence';

export function GovernanceSettings({
  scope,
  workspace,
}: Readonly<{ scope: GovernanceScope; workspace: AccessibleWorkspace }>) {
  const settings = useQuery(governanceQueryOptions(scope));
  const editable =
    workspace.status === 'active' &&
    workspace.capabilities.includes('governance:manage');
  return (
    <QueryView query={settings} resource="Governance settings">
      {(snapshot) => (
        <>
          <SettingsSection
            title="Publishing approval"
            description="Require another owner or admin to review each saved draft before it becomes live."
          >
            <PublicationPolicy
              scope={scope}
              snapshot={snapshot}
              editable={editable}
            />
          </SettingsSection>
          <SettingsSection
            title="Audit retention"
            description={`${sentenceStart(whoCan('governance:manage'))} can keep events for ${AUDIT_RETENTION_RANGE}. Run data retention is separate.`}
          >
            <AuditRetention
              scope={scope}
              snapshot={snapshot}
              editable={editable}
            />
          </SettingsSection>
        </>
      )}
    </QueryView>
  );
}
