# Row security rewrite

Implement audit dm-06 and dm-08 as forward migration 0117, retaining populated
0116 data and the existing public lookup interfaces.

- Provision maintenance BYPASSRLS from shared SQL during fresh initialization
  and deployment, after writers stop and before migration. Fail closed on error.
- Run global claim/discovery and fold work through maintenance; retain scoped
  app connections for acceptance. Preserve transactions, lock order and retries.
- Compare workspace UUIDs, remove FORCE and owner/maintenance policies, retaining
  operation and actor restrictions. Validate UUIDs at the context writer;
  malformed direct SQL settings error without returning rows.
- Verify catalog-wide isolation, populated upgrades, two-workspace scanners,
  query plans, schema generation, focused tests, static checks and self-host drills.

The implementation report and evidence are maintained in the local audit brief.
Baseline squashing and the remaining SQL-rule work are separate later parts.
