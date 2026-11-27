import { useQuery } from '@tanstack/react-query';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { SettingRow } from '@/components/patterns/settings/row';
import { QueryView } from '@/components/patterns/states/query-view';
import type { GovernanceScope } from '../data/audit.api';
import { governanceQueryOptions } from '../data/audit.queries';
import { AUDIT_RETENTION_RANGE } from '../model/governance-setting-edit';
import { PublicationPolicy } from './publication-policy';
import { AuditRetention } from './audit-retention';
import { ANY_ADMINISTRATOR, whoCan } from '@/features/workspaces/public';
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
          <SettingRow
            layout="section"
            title="Publishing approval"
            description={`Require another ${ANY_ADMINISTRATOR} to review each saved draft before it becomes live.`}
          >
            <PublicationPolicy
              scope={scope}
              snapshot={snapshot}
              editable={editable}
            />
          </SettingRow>
          <SettingRow
            layout="section"
            title="Audit retention"
            description={`${sentenceStart(whoCan('governance:manage'))} can keep events for ${AUDIT_RETENTION_RANGE}. Run data retention is separate.`}
          >
            <AuditRetention
              scope={scope}
              snapshot={snapshot}
              editable={editable}
            />
          </SettingRow>
        </>
      )}
    </QueryView>
  );
}
