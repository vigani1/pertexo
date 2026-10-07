# Database Function Readiness

## Registered inline JSON Call boundary

ADR065 Phase 1 adds the catalog-only startup inventory in
`packages/database/src/platform/readiness-workflow-call.sql.ts`. Candidate head 0141 pins
three private relations, 60 function ABIs and bodies/security/ACL contracts,
12 writer/settlement triggers, the native initiation and published-format
constraints, and the online-built node/attempt scope constraints. The normalized
catalog SHA-256 is
`f6e3b94dbc46059b931ae93defcfc003434e9db247450b6b2f1481d1a2ff5d1a`.

Unreleased main-candidate 0140 authenticates parent controls but emits only
strict schema1 identifier-only child advance intents. It never locks or updates
child control/audit rows in the parent transaction. Read-only canonical child
lineage validation refuses a poisoned sealed root/depth without destination
locks or mutations. The UUIDv5 namespace is the actual parent delivery UUID;
the name is the UTF-8 JSON tuple
`["pertexo.workflow-call-control.v1", expectedRevision, canonicalChildUuid, reason]`
as name; reason is `cancel_requested` or `deadline_expired`. Replay compares
complete immutable outbox identity/payload/checksum and refuses conflicts.
Before the native child snapshot, worker-only child apply authenticates the
actual carrier and sealed lineage, locks workspace/ancestors/own run/checkpoint,
and records own cancellation plus exactly one audit in a short transaction.
It does not complete the coordinator receipt; audit failure rolls back control,
and replay after a committed apply is unchanged. Deadline-only wakes do not
manufacture cancellation. Original compact-branch 0140 evidence remains historical;
the repaired candidate requires fresh source and real-PostgreSQL review.

The independent database rollout flag starts OFF. Startup readiness never
requires it ON: accepted families must remain readable and drain while OFF.
Only fresh Call-capable publication and root admission consult the flag. An
operator-only command controls it; runtime roles cannot update it. This inventory
does not qualify signed dispatch proofs, artifact storage, retention/purge
mutation, notification rewrites, or production activation.

| Function | Expected MD5 | Security and execution roles |
| --- | --- | --- |
| `app.apply_workflow_call_control(uuid,jsonb)` | `03388ccb0f5bf29b59d5122a6ec0712a` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.propagate_workflow_call_control(uuid,integer,uuid,text,jsonb)` | `6034670c2e0c760d279ccffa7d04c731` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.assert_native_advance_delivery(uuid,uuid,text)` | `9efbc0147b28f67e222c1d2940571ff8` | invoker; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.assert_native_callable_value(jsonb,jsonb)` | `48cdbfe0f13ebe9e53c369ae8572463c` | invoker; `search_path=pg_catalog, app, pg_temp`; owner |
| `app.assert_native_call_detail_live(uuid)` | `a62ef936e998537c4249181b1e6609de` | invoker; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.assert_native_inline_execution_value_bytes(jsonb,text,integer,text)` | `f919e300ebcbd460ad53d14fa16c0d77` | invoker; `search_path=pg_catalog, app, pg_temp`; owner |
| `app.assert_workflow_call_result_output(uuid,text,uuid,boolean)` | `1790cef7c5270f5e332fbda89325ebda` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.assert_workflow_calls_enabled()` | `75306f56afcf009e038ac3091b347da7` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, api |
| `app.capture_native_run_initiation()` | `c5b84b003a7ae8b6e8001d7e20bf243c` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.check_native_call_completion_clock()` | `ac4694b410cce0ca4d2d703976e005ba` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.check_native_child_acceptance_commit()` | `5856ffbfb86a83064cde999bd5784dc1` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.check_native_execution_value_commit_obligations()` | `8c0363116cb44864646c993a27c65a47` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.check_native_node_logical_projection()` | `92611bd82366a64e43c4551f7f666a82` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.check_native_terminal_result_commit()` | `b95510f7223ab22cb50efa10f2357f29` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.executable_has_workflow_call(jsonb)` | `f1ba367f3002b0c4738225c40203b35c` | invoker; `search_path=pg_catalog, app, pg_temp`; owner |
| `app.guard_native_call_node_input()` | `f84eb05dbb5e569f09a1acfa69a38386` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.guard_native_execution_value_mutation()` | `e9f958d70d35e319dcc5a2b282950790` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.guard_native_run_result_projection()` | `364e2763b80c2042050bd1733f4ff060` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.guard_workflow_call_publication()` | `5f728af90fe98b4a301dd6155d2d595f` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.inspect_native_coordinator_value_owner(jsonb)` | `0dcdf90505527bbfe6ed1596a530bf2b` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.load_native_coordinator_control_sources(jsonb,integer)` | `e8778ceb31ea7615bf8c4ce5a8f406ac` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.load_native_coordinator_value_sources(jsonb,jsonb)` | `b512a2890b44c468ea2faaf9cce354b1` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.lock_native_attempt_value_owner(jsonb)` | `54fe1b15d99d5d3dd86bd5e955223ea3` | invoker; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.lock_native_call_input_owner(jsonb)` | `c90186db5fe6ee66f91f10c4cd91910b` | invoker; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.lock_native_coordinator_control_sources(jsonb,integer,jsonb)` | `a655639891559cd5ea049767c014b98b` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.lock_workflow_call_admission(uuid,integer,text,uuid,uuid,text)` | `23aed012eaea5daafa7f904501e87d9c` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.native_attempt_value_owner(jsonb)` | `4d29c9ee3798c0b36d0ba0576cfd463b` | invoker; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.native_call_admission_scope(uuid,integer,text,uuid,text)` | `01e99d5fb976410091b4337a70fa5b77` | invoker; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.native_call_lineage(uuid)` | `95d96ecc9b212d70b867161ed94fc8d7` | invoker; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.native_coordinator_control_inventory(jsonb,integer)` | `0c1eef8ede41bdbb2f1d6c71c39a20da` | invoker; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.native_coordinator_value_inventory(jsonb,jsonb)` | `199270edc2c8e58890ad96e7a17815b3` | invoker; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.native_execution_value_binary64_leaf(text)` | `2cd979c5128a671477f648e442ca3b86` | immutable strict invoker; `search_path=pg_catalog, app, pg_temp`; owner |
| `app.native_node_accepted_output(uuid,uuid,uuid,character varying,uuid,jsonb)` | `34ce86d2c799e180c729b5fadc509510` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.native_workflow_call_result_provenance(uuid,text,uuid)` | `f21999685f76372ab902e81af8848bb9` | invoker; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.prelock_native_attempt_value_owner(jsonb)` | `02a38128cf73b8465e0dedaef96984d9` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.prelock_native_coordinator_lineage(uuid,uuid,text)` | `c9a01dba54e786a04df2ede10d701377` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.prelock_workflow_call_parent(uuid,integer,jsonb,uuid,text)` | `9664ce573ba4ebddfe2ae5e6486b3709` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.read_native_attempt_value_source(jsonb,jsonb)` | `51a977b1cafe6e98a9c39657c831d6dc` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.read_native_coordinator_control_source(jsonb,jsonb)` | `b512445476069dceaf3c1a5c02759874` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.read_native_coordinator_value_source(jsonb,jsonb)` | `872be94f718f4d814f74d0d1f89c4f81` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.read_workflow_call_declaration_input(jsonb)` | `48296879e2534b9a4da36f790e1e1c34` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.read_workflow_call_declaration_materials(uuid,text[],jsonb)` | `ad11812167b775405c700608ea3bd675` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.read_workflow_call_facts(uuid)` | `9a7f7d39a95e30d4859e6678b1132ff8` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.read_workflow_call_result_reference(uuid,text,uuid,jsonb)` | `db298db72297b8eba93fd55d3b83407b` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.read_workflow_call_run_family(uuid)` | `f85d259038e00a83fe6f192136d7cf9b` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, api |
| `app.record_native_root_execution_input(uuid,uuid,text)` | `80cc4eef491fb676fdf0a063686dcabd` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, api, worker |
| `app.record_native_workflow_attempt_output(jsonb,jsonb,text,integer,text)` | `e10b144e7aeace7e50ed3827e515a22e` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.record_workflow_call_declaration_input(jsonb,jsonb,text,integer,text)` | `3dce54c2af3b0beed996e2b7f051c143` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.record_workflow_call_outcome(uuid,integer,text,jsonb,uuid,text)` | `f0f82c04efc804896dd7a12bd2785613` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.record_workflow_call_run_result(uuid,integer,jsonb,jsonb,text,integer,text,jsonb,text)` | `6e3218edc7b50c6675eda418a46d36d9` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.reserve_workflow_call_active_admission(uuid,integer,text,uuid,uuid,uuid,text)` | `fdeabd13ed2decb91fba12b307a029b2` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.seal_workflow_call_parent(uuid,integer,uuid,uuid,text)` | `a97375074000509551b9fe8da3332905` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.set_workflow_calls_enabled(boolean)` | `75d4b23ef297ea6e294c70ed42d431bb` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, operator |
| `app.wake_native_call_parent_on_terminal()` | `ec6d808f2698baf084106feadb085346` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.workflow_call_declaration_completion_reference(jsonb)` | `8da75b354b233cc1fdc937ca4722f84b` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, worker |
| `app.workflow_call_family_members(uuid)` | `aee5b0504b453e56c7d6a911366537c8` | invoker; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.workflow_concurrency_admissible(uuid,uuid,boolean)` | `4f2b5fe534190e0d4af122280a636775` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.workflow_concurrency_candidate_admissible(uuid,uuid,uuid,boolean)` | `e274cc6d78199156c1fda38fe6d70609` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |
| `app.workflow_run_active_admission_eligible(uuid,uuid,uuid)` | `02b0d390926624f0ea6d41ffe8ed92a5` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner, dispatcher |
| `app.workflow_run_new_active_admission_eligible(uuid,uuid,uuid,integer)` | `0984d1fbc2e722b09b9fc4fa4a6a50e0` | definer; `search_path=pg_catalog, app, pg_temp`, `row_security=on`; owner |


Startup compatibility deliberately verifies the exact PostgreSQL function body
stored in `pg_proc.prosrc` for security- and compatibility-critical functions.
The recurring readiness probe does not run these catalog checks. For these
interpreted/string-body functions, `prosrc` is PostgreSQL's stored source text,
not a formatting-normalized representation. Formatting-only edits can therefore
change `md5(prosrc)` and remain operational changes that block startup.

## Hashed function inventory

| Function | Expected MD5 | Security mode | Owning migration |
| --- | --- | --- | --- |
| `app.reject_preview_run_pin_change()` | `e3e80198979101aabfc681553bcdbedf` | invoker, `pg_catalog, pg_temp` | `0070_preview_execution_deadline.sql` |
| `app.enforce_phase3_core_executor_non_removal()` | `338c35d21e71957aed153ac764b2e450` | invoker, `pg_catalog, app` | `0018_phase3_core_executor_non_removal.sql` |
| `app.prepare_node_compatibility_release(integer,character varying,jsonb,integer,character varying,character varying,character varying,character varying)` | `cdc8c35b360133824aa9f2722c240934` | definer, `pg_catalog, app` | `0019_node_compatibility_preactivation.sql` |
| `app.lock_node_compatibility_current_supported(jsonb)` | `f76fa13098d07326e52621ae076882d6` | definer, `pg_catalog, app` | `0019_node_compatibility_preactivation.sql` |
| `app.record_node_compatibility_preactivation(uuid,character varying,integer,character varying,character varying,character varying,jsonb)` | `1cd8c85bfd2342dd954686fffc341238` | definer, `pg_catalog, app` | `0019_node_compatibility_preactivation.sql` |
| `app.approve_node_compatibility_activation(uuid,character varying,integer,character varying,jsonb,jsonb,character varying,character varying)` | `07e8e75948b469026b72060a33810e65` | definer, `pg_catalog, app` | `0019_node_compatibility_preactivation.sql` |
| `app.activate_node_compatibility_release(uuid,integer,character varying,uuid,character varying,character varying,character varying)` | `bc6581fed30a75832fdf7133613f355e` | definer, `pg_catalog, app` | `0019_node_compatibility_preactivation.sql` |
| `app.node_compatibility_artifact_set_valid(jsonb)` | `1ee6b6a001eb02b6b5a95f671240ae69` | invoker, `pg_catalog, app` | `0019_node_compatibility_preactivation.sql` |
| `app.compatibility_preactivation_cohort_complete(character varying,integer,character varying,character varying,jsonb)` | `4bd8e8a005eebc013d41ae6b6a55b976` | invoker, `pg_catalog, app` | `0019_node_compatibility_preactivation.sql` |
| `app.fold_workspace_inbox_events(integer)` | `899c9594fabccef911b6d08fa32a65cb` | definer, `pg_catalog, app, pg_temp`, `row_security=on`, worker-only | `0123_workspace_inbox_threads.sql` |
| `app.expire_workspace_inbox_threads(integer)` | `9deadaa33d0fa9e847c4cdc4127a837c` | definer, `pg_catalog, app, pg_temp`, `row_security=on`, worker-only | `0123_workspace_inbox_threads.sql` |
| `app.fold_workflow_trigger_outcomes(integer,boolean)` | `54c69650fa9bbf8c2580e0e86659e894` | definer, `pg_catalog, app, pg_temp`, `row_security=on`, worker-only | `0125_workflow_auto_pause_controls.sql` |
| `app.workflow_auto_pause_control(uuid,uuid,uuid,text,jsonb,text,text,text,text)` | `2ce8ab04731f24bd9292bdc7cf9e4079` | definer, `pg_catalog, app, pg_temp`, `row_security=on`, API-only | `0125_workflow_auto_pause_controls.sql` |
| `app.schedule_claim_workflow_paused(uuid,uuid,timestamptz)` | `7f7b9cf2e74f7e45644cd0fe3d37b205` | definer, `pg_catalog, app, pg_temp`, `row_security=on`, API/worker-only | `0125_workflow_auto_pause_controls.sql` |
| `app.workspace_reserved_active_slot_count(uuid)` | `6ed33604664c79cbc928094e4ada3202` | definer, stable, `pg_catalog, app, pg_temp`, `row_security=on`, API-only | `0126_workspace_usage_capacity.sql` |
| `app.enforce_workflow_run_admission()` | `4a178a6940d2a28eb9afde6f5227fbaf` | definer, `pg_catalog, app`, `row_security=on`, internal trigger | `0127_workflow_concurrency.sql` |
| `app.workflow_concurrency_admissible(uuid,uuid,boolean)` | `4f2b5fe534190e0d4af122280a636775` | definer, `pg_catalog, app, pg_temp`, `row_security=on`, internal | `0139_workflow_json_calls.sql` |
| `app.workflow_concurrency_control(uuid,uuid,uuid,text,jsonb,text,text,text,text)` | `f37e4d9d93e59b518d37713078575eda` | definer, `pg_catalog, app, pg_temp`, `row_security=on`, API-only | `0127_workflow_concurrency.sql` |
| `app.workflow_run_admission_blockers(uuid,uuid)` | `f0127382f587223639b4bfb02f120ee8` | definer, stable, `pg_catalog, app, pg_temp`, `row_security=on`, API-only | `0127_workflow_concurrency.sql` |
| `app.workflow_run_active_capacity_available(uuid,integer,uuid)` | `66e1c3ed4d6d458c4889799733c11063` | definer, `pg_catalog, app`, `row_security=on`, worker-only | `0127_workflow_concurrency.sql` |
| `app.rebind_workflow_run_active_admission(uuid,uuid,uuid,uuid)` | `8ff6b3bf9c4140076f4a16b80f0949a3` | definer, `pg_catalog, app`, `row_security=on`, worker-only | `0127_workflow_concurrency.sql` |
| `app.workflow_run_active_admission_eligible(uuid,uuid,uuid)` | `02b0d390926624f0ea6d41ffe8ed92a5` | definer, `pg_catalog, app, pg_temp`, `row_security=on`, dispatcher-only | `0139_workflow_json_calls.sql` |
| `app.reserve_workflow_run_active_admission(uuid,uuid,uuid)` | `e11cf9af2c42e62f995138c7483fe162` | definer, `pg_catalog, app`, `row_security=on`, dispatcher-only | `0127_workflow_concurrency.sql` |
| `app.lock_notification_connection(uuid,uuid)` | `a12fd79c0d2753ff214e864732ed1ca3` | definer, `pg_catalog, app`, `row_security=on`, API/worker-only | `0128_connection_health.sql` |
| `app.enforce_connection_health_protocol()` | `4b36377613e407ba046e8c9c8f9ee824` | invoker, `pg_catalog, app`, internal trigger | `0128_connection_health.sql` |
| `app.cleanup_connection_health_command()` | `3356eaa54a79e4c96e55d258621c6fea` | definer, `pg_catalog, app`, `row_security=on`, internal trigger | `0128_connection_health.sql` |
| `app.bind_node_attempt_connection_dispatch(uuid,uuid,text,bigint,uuid,uuid)` | `a63cdd2cf7a8e9c967b992f9df28ed30` | definer, `pg_catalog, app`, `row_security=on`, worker-only | `0128_connection_health.sql` |
| `app.record_node_attempt_connection_health(uuid,uuid,text,bigint,text,text,text,uuid,uuid)` | `abded4cdf7da724dce322df3801262c5` | definer, `pg_catalog, app`, `row_security=on`, worker-only | `0128_connection_health.sql` |
| `app.apply_connection_health_observation(uuid,uuid,text,uuid,text)` | `2a15128a645b16ac211456c880d2cfd2` | definer, `pg_catalog, app`, `row_security=on`, worker-only | `0128_connection_health.sql` |
| `app.audit_connection_secret_access(uuid,uuid,uuid,text,text,text,text)` | `62ddece0876f51039e5825ac914246d3` | definer, `pg_catalog, app`, `row_security=on`, worker-only | `0128_connection_health.sql` |
| `app.apply_workspace_deletion_side_effects()` | `908becdc3d5fbf1ec9a1a855c97c75bf` | definer, `pg_catalog, app, pg_temp`, `row_security=on`, internal trigger | `0128_connection_health.sql` |
| `app.reject_retention_batch_direct_mutation()` | `bd7d508fdf10cf97eb33467e8bd00f37` | invoker, `pg_catalog, pg_temp`, internal trigger | `0128_connection_health.sql` |
| `app.create_workflow_duplicate_draft(uuid,uuid,uuid,uuid,character varying,integer,jsonb,character,character,text,uuid)` | `cca6cf717f5528c781f30c2460fe9dca` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0133_curated_template_origin.sql` |
| `app.lock_workflow_portable_version(uuid,uuid,uuid,uuid)` | `00c1b41bf997942d194f9af7819f4d15` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only scoped read lock | `0132_workflow_portability.sql` |
| `app.create_workflow_import_draft(uuid,uuid,uuid,jsonb,character,character,text)` | `b6a6e87c4bed5ae35b3edc927a40f4e4` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0133_curated_template_origin.sql` |
| `app.guard_curated_template_descriptor()` | `6e0fd4efae62132ea0312d9d99496039` | invoker, `pg_catalog, pg_temp`, internal trigger | `0133_curated_template_origin.sql` |
| `app.curated_template_inventory_matches(text)` | `c24b77c0f824bd4701e2afa88404cd90` | definer, stable, `pg_catalog, pg_temp`, `row_security=on`, API/worker-only boolean | `0133_curated_template_origin.sql` |
| `app.lock_curated_template_descriptor(text,integer)` | `f9f5e6053b93a8900abe09fe5e624bba` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0133_curated_template_origin.sql` |
| `app.curated_https_endpoint_valid(text)` | `dde56c7e4aca9c64bd745c80be97e8d5` | invoker, immutable, `pg_catalog, pg_temp`, owner-only | `0133_curated_template_origin.sql` |
| `app.verify_curated_template_origin(jsonb,jsonb,text)` | `e7a60281a1a81b56a085ff72c4bf8bf4` | definer, `pg_catalog, pg_temp`, `row_security=on`, owner-only | `0133_curated_template_origin.sql` |
| `app.guard_workflow_input_case_write()` | `a3108e59e200d8e251cf39c056f41dd9` | definer, `pg_catalog, pg_temp`, `row_security=on`, internal trigger | `0130_workflow_input_cases.sql` |
| `app.reap_workflow_input_cases(integer)` | `f5a5951bcb6a7d913dac66dc15702e25` | definer, `pg_catalog, pg_temp`, `row_security=on`, maintenance-only | `0130_workflow_input_cases.sql` |
| `app.execute_workspace_tenant_rows_page_before_organization(uuid,uuid,bigint,integer,bigint,character)` | `348588ea384effc589d6c8c74686aa58` | definer, `pg_catalog, pg_temp`, `row_security=on`, owner-only retained body | `0130_workflow_input_cases.sql` |
| `app.execute_workspace_tenant_rows_page_before_folders(uuid,uuid,bigint,integer,bigint,character)` | `04650e6c8360b75173a63d34265f7aa0` | definer, `pg_catalog, pg_temp`, `row_security=on`, owner-only retained body | `0134_workflow_organization.sql` |
| `app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)` | `c19d0d7f7d347550eba8c52564144a86` | definer, `pg_catalog, pg_temp`, `row_security=on`, maintenance-only | `0135_workflow_folders_batch_identity.sql` |
| `app.execute_workflow_folder_command(text,uuid,text,jsonb)` | `ecfc968efc4600e3da617848ecf3742d` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0135_workflow_folders_batch_identity.sql` |
| `app.admit_workflow_organization_batch(text,jsonb)` | `fefeaa5b268b5cabf83939bc5ef12da5` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0135_workflow_folders_batch_identity.sql` |
| `app.execute_workflow_folder_placement(uuid,text,jsonb)` | `61a15b76b135ee03615f79ee90014c10` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0135_workflow_folders_batch_identity.sql` |
| `app.execute_workflow_organization_batch_item(text,jsonb,uuid,text)` | `22c72a807734ddb1cca778b55584ee57` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0135_workflow_folders_batch_identity.sql` |
| `app.lock_manual_workflow_run_start(uuid,uuid,text,text)` | `e70f076dbfffbb8a79b4534b49bdc138` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0131_checked_manual_start.sql` |
| `app.enforce_manual_start_writer()` | `a24d51f06dfe43548064394c9bf03ca9` | invoker, `pg_catalog, pg_temp`, internal trigger | `0131_checked_manual_start.sql` |
| `app.assert_workflow_input_cases_enabled()` | `f537940438bedfc091e8a19b64c01689` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0131_checked_manual_start.sql` |
| `app.prune_manual_start_rejections(integer)` | `490686b5af7560b8c7d0a6f526762fe2` | definer, `pg_catalog, pg_temp`, `row_security=on`, maintenance-only | `0131_checked_manual_start.sql` |

The executable inventory is split between
`packages/database/src/platform/readiness.ts` (compatibility-release functions)
and `packages/database/src/platform/readiness-probe-3.sql.ts` (the preview pin
guard), with the workspace inbox fold and expiry commands in
`packages/database/src/execution/workspace-inbox/inbox-fold-readiness.ts` and
the trigger pause fold (ADR 056) in
`packages/database/src/execution/trigger-pause/trigger-pause-readiness.ts`,
which the worker checks at startup. The operational pause command is checked by
`packages/database/src/platform/readiness-probe-auto-pause.sql.ts`.
The scoped workspace reservation-count reader (ADR 057) is checked by
`packages/database/src/platform/readiness-probe-4.sql.ts`, including its exact
tenant guard/count body, ownership, security configuration, API-only execution
grant, lack of API reservation-row privileges, and workspace index.
This table is an operator aid and must
change in the same commit whenever an owning inventory changes.

The organization boundary (ADR064) is catalog-only at startup in
`packages/database/src/platform/readiness-workflow-organization.sql.ts`. Head
0135 pins 11 relations, 30 function ABIs and 29 exact function bodies/security/ACL
contracts, with normalized catalog SHA-256
`9827f9fecb4e4c69185428ce253e57728fde64996d6469455f6bccdc317ad4ea`.
All 0134 bodies remain pinned unchanged; its former public purge body is retained
as the owner-only `before_folders` alias. The independent writer is not a schema
readiness input. Migration 0135 closes an already enabled writer during the
held-traffic upgrade, and never enables it; compatible reads and admitted exact
replays do not authorize new batch items while the writer is OFF. Follow the
accepted [folder/batch contract](../feature-plans/07-folders-bulk-follow-on-proposal.md).

The queue-only workflow concurrency boundary (ADR 058) is shared by API/worker
admission startup and dispatcher startup in
`packages/database/src/platform/readiness-workflow-concurrency.sql.ts`. It pins
the seven bodies above, security configuration, runtime execution ACLs, private
policy/receipt RLS and ACLs, ticket/reservation columns, private ticket sequence,
and exact scoped active/order index shapes. Follow the lock and rollout contract
in [Workflow concurrency enforcement](workflow-concurrency-enforcement.md).

The connection-health boundary (ADR059) is checked by
`packages/database/src/platform/readiness-connection-health.sql.ts`, included in
the API/worker compatibility probe. It pins the eight bodies above, exact
execution grants, private evidence tables and column grants, forced tenant RLS,
source-cascade constraints, command cleanup, and transition/revision constraints.
Follow [Connection health enforcement](connection-health-enforcement.md) for
lock order, mode-preserving backlog handling, and fail-closed mixed-version
deployment. Restore-before-serve uses the same migration-head compatibility
boundary; restoring evidence does not authorize enabling enforcement.

The atomic same-workspace duplication creator (ADR060) is checked by
`packages/database/src/platform/readiness-workflow-duplication.sql.ts` in the
startup compatibility probe. Its exact body, owner, security configuration and
API-only execution ACL are pinned. Migration 0129 is additive: apply it before
serving the new API; no existing creation function, runtime INSERT privilege or
receipt lifecycle is replaced. The exact migration-head contract does not admit
0128 images against 0129: hold serving traffic closed until all serving and
restore images accept 0129. This is not a zero-downtime mixed-head rollout.
Application rollback requires an image qualified against 0129; it may leave the
capability installed. Do not remove it while a supported image uses it, or rewrite
migration history to admit an older image.

Portable authoring (ADR062) is checked by
`packages/database/src/platform/readiness-workflow-portability.sql.ts` in the
same startup probe. It pins both API-only function bodies, owner, security
configuration and execution ACLs, plus ownership and API read/immutable-singleton
column grants on the default-off writer gate. Missing gate authority fails new
imports closed; export and preview are independent readers. The version reader
locks the exact scoped immutable version without granting API UPDATE on versions.
The creator hashes a transient canonical command containing only the exact
submitted manifest, bindings, normalized name and original catalog fingerprint;
workspace and actor are independently guarded transaction/receipt scopes. It
compares the rebound graph against that command and never persists its contents.

Apply additive 0132 before serving the feature image, with traffic held closed
until API, worker, dispatcher and restore images accept that exact head. This
branch qualifies the 0129-to-0132 path; 0130/0131 belong to concurrent F02 and are
not copied or renumbered here. Integration with that release must retain their
checksums and qualify the combined prior-head suffix. No mixed-head rolling
overlap is claimed. Reader availability is not writer activation: enabling the
gate requires a separately authorized deployment decision, not a migration
default. Rollback first disables new imports; exact authorized completed replay
is resolved before gate/catalog/binding checks. Use an image qualified for 0132,
leave imported normal workflows and the additive helpers readable, and retain
the existing 24-hour receipt reaper, legal holds and bounded workspace erasure.
No production activation is authorized.

The ADR061 case and checked-start boundary is checked by
`packages/database/src/platform/readiness-workflow-input-cases.sql.ts` and
`packages/database/src/platform/readiness-manual-start.sql.ts`. Migration 0130
installs bounded case storage and lifecycle functions; 0131 installs the shared
manual-command lock, rejection receipts, and all-manual-writer insertion fence.
The rollout row defaults to disabled. Migration-head readiness requires 0131
for all serving and restore images, and the insertion fence rejects predecessor
manual writers even when cases are disabled. Keep serving closed while applying
both migrations and replacing incompatible images. Only an operator may enable
cases after qualifying the complete deployment; this repository's isolated
fixtures do not authorize production enablement. Rollback uses an image qualified
against 0131 with cases disabled, not an older migration head. Preserve retained
receipts and held payloads; do not rewrite migration history.

Case cleanup acquires the destruction lock before workspace authority and quota
locks. Workspace purge retains the existing coordinator's dedicated-client
session destruction lock; its transaction must not reacquire that same lock on a
second client. Both paths recheck workspace legal holds before deleting data.

Case writers set the transaction-local writer marker only after current
authority, command-key, workflow and quota locks. The case trigger rejects a
markerless direct write before waiting for those locks, including raw UPDATE
paths that have already acquired the case row lock.

The combined ADR061/ADR062 image requires the ordered `0130`/`0131`/`0132`
history and exact migration head `0132_workflow_portability.sql`, with both
capability inventories intact. The individual release prerequisites above are
historical boundaries, not permission to serve an `0131` image at combined head
`0132`. Hold traffic until serving and restore images are qualified against the
combined head; leave both new writer gates disabled until separately authorized.

## Synchronized update procedure

ADR063 advances the exact head to `0133_curated_template_origin.sql` under held
traffic, retaining all combined F02/F05 capability checks. Unmodified 0132 images
are not compatible with that head. The curated writer remains off by default;
both API and worker pin the helper above and immutable inventory digest
`b2c003431f093031cdaebb97b78f8a9ddae81f8ce5fa14efd4035b639a3e9f75`.
Its canonical length-prefixed encoding is specified in the
[F06 contract](../feature-plans/06-template-origin-contract.md); mutable selection
flags are excluded. Worker gains no descriptor SELECT/DML or descriptor-lock
execution. Qualification of new-head compatible/off, owned enablement and
compatible/off rollback remains required; inventory code alone is not cutover proof.

All startup roles retain the exact curated schema, helper-body and ACL metadata
checks. After that audit, API/worker alone invoke the bounded inventory witness
on the same connection, selected by the database's actual `current_user`.
Dispatcher and other roles receive no helper execution grant. Their metadata
query must not reference the confined helper, even inside `CASE`: PostgreSQL can
require execution permission before evaluating that branch. Missing, false,
malformed or errored API/worker inventory results fail readiness closed.

1. Treat any body edit, including formatting, as a forward-only database
   compatibility change. Do not edit a published migration.
2. Prefer a new function signature or name when a zero-downtime rolling overlap
   is required. Keep the predecessor callable until the supported overlap is
   retired.
3. Add a new migration with the replacement body, owner, `SECURITY DEFINER`
   mode, fixed `search_path`, grants, and public-execute revocation.
4. Apply the migration to a disposable database and obtain the authoritative
   value with `select md5(prosrc) from pg_proc where oid =
   'app.<signature>'::regprocedure`. Copy that exact value into startup
   compatibility and this inventory.
5. Add or update the exact prior-head-to-head migration test. For compatibility
   release functions, retain the one-predecessor rolling-overlap test and prove
   both API and worker cohorts before activation.
6. Run the focused drift tests, the zero/prior-head database matrix, and
   `pnpm check`. Review the migration and application change as one release
   unit.
7. The release job applies migrations before serving tasks start. If an
   in-place replacement cannot support both application versions, hold traffic
   closed until the new API and worker startup compatibility checks pass. Do not
   mix an old image with a body hash it does not recognize.

### Patching a function by text

Some migrations change an existing function by reading its body with
`pg_get_functiondef`, replacing a marker, and executing the result, so each
feature adds its lines without copying the whole function. From migration 0123
on, every such replacement must first count its marker and raise unless it
occurs exactly once; a presence check alone lets a marker that later appears
twice receive the change twice or in the wrong place.
`packages/database/test/migration-function-patching.test.ts` enforces this.
Published migrations before 0123 keep their original presence checks and must
not be edited.

## Failure and rollback

A hash mismatch is a startup compatibility failure, not a liveness failure.
Keep the service out of rotation and compare `pg_get_functiondef`, owner,
language, `prosecdef`, `proconfig`, and grants against the reviewed migration.
Do not weaken or bypass the hash check to restore traffic.

Database rollback is forward-only. Add a reviewed repair migration that restores
the previously approved body and security attributes, verify its authoritative
hash, then deploy an application image whose inventory accepts that body. For a
rolling overlap, retire the replacement only after persisted compatibility
state and both serving cohorts no longer require it. Never rewrite migration
history or run an unreviewed `CREATE OR REPLACE FUNCTION` in production.

Current regression coverage includes exact drift rejection for the preview pin
guard and Phase 3 non-removal guard, full preactivation authority validation,
the bounded one-predecessor compatibility-release overlap, and zero/prior-head
migration suites. Every future supported rolling release must add its own
prior-head fixture before the predecessor is admitted.

## Ordinary draft format cutover

The registered `0136_workflow_draft_graph_v2.sql` migration enables editable
Graph V2 source only. Startup readiness separately checks draft support `[1, 2]`,
the exact validated schema/header constraints, and the registered head. Published
graphs remain V1; executable graphs remain V2. No native runtime routines,
catalog entries, grants or writer activation are included.

Do not use this change as a zero-downtime or mixed-image compatibility release.
The exact-head check does not fence already-running older processes. An
authorized operator must hold writes/traffic closed, drain old API/worker and
other serving cohorts, apply the registered migration through the normal runner,
and start synchronized compatible images. Reopen only after all serving startup
checks pass and ordinary retained/native draft GET/conditional-save checks pass.
Keep native execution/catalog/writers and native Publish/Run disabled. A failing
constraint validation is a failed cutover, not permission to use `NOT VALID`,
rewrite source, drop checks or weaken readiness.

After V2 drafts exist, rollback must retain a reader/image supporting both draft
formats and this exact head, or use a reviewed forward repair. Do not deploy an
older V1-only reader or downgrade stored drafts to make it start. This procedure
documents a release requirement; the local draft-storage checkpoint does not
authorize deployment or qualify the paused native security/runtime gates.
