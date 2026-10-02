import type { PoolClient } from 'pg';
import { expect } from 'vitest';

/** Read the live wrappers and prove every delegation before legacy body checks. */
export async function assertWorkspaceTenantPurgeChain(
  client: Pick<PoolClient, 'query'>,
): Promise<string> {
  const names = [
    'app.execute_workspace_tenant_rows_page',
    'app.execute_workspace_tenant_rows_page_before_folders',
    'app.execute_workspace_tenant_rows_page_before_organization',
    'app.execute_workspace_tenant_rows_page_before_input_cases',
  ];
  const result = await client.query<{ name: string; definition: string }>(
    `select name,pg_get_functiondef((name||$2)::regprocedure) definition
     from unnest($1::text[]) with ordinality as functions(name,position)
     order by position`,
    [names, '(uuid,uuid,bigint,integer,bigint,character)'],
  );
  expect(result.rows.map(({ name }) => name)).toEqual(names);
  for (const [index, row] of result.rows.entries()) {
    const next = names[index + 1];
    if (next !== undefined)
      expect(row.definition).toContain(`RETURN QUERY SELECT * FROM ${next}`);
  }
  return result.rows.map(({ definition }) => definition).join('\n');
}
