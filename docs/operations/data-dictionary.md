# Database data dictionary

This dictionary describes the current `app` tables. Table and column definitions
are owned by
[`packages/database/src/schema`](../../packages/database/src/schema); the
migration history records policies, grants, triggers and function bodies. The
schema's `workspace_id` is an isolation key, not optional query decoration.
Actor-scoped tables carry their actor key. Global identity/authentication tables
are accessed by sign-in and account operations and are not covered by workspace
RLS. The organization link/mapping tables accept verified organization context;
see [ADR 003](../adr/003-workspace-tenancy-rls-runtime-roles.md).

Execution documents use JSON/JSONB for graphs, values and scheduler state. The
immutable version pin and optimistic checkpoint revision are distinct from
mutable authoring revisions. Artifact references are indexed for discovery, but
their owner rows and retained audience determine visibility. A receipt, audit
fact and user-facing event are distinct records with distinct lifetimes.

Current deletion predicates live in core's
[`lifecycle/retention`](../../packages/core/src/lifecycle/retention) rules;
workspace purge checks residual workspace-owned rows against the live catalog.
Stable configuration, identity and immutable publication history are retained
until their explicit lifecycle operation; a table's presence here does not claim
a general retention period or a product UI reader.

`pertexo_internal.schema_migrations` stores migration names, checksums and
application times. It is runner bookkeeping and is outside the product schema.

Drizzle generation detects table-definition drift. The complete row-security
matrix tests live isolation and grants at their boundaries. Neither compares
arbitrary function bodies or every grant to a committed catalog snapshot: the
baseline squash must retain its planned fresh-migrate catalog comparison and
reviewable `schema.sql` snapshot.

The table inventory below is paired with these stored meanings. Exact SQL types,
nullability, defaults and foreign-key definitions remain in the schema rather
than being copied into a second definition.

| Field or record                                   | Stored meaning                                                                                                                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace_id`                                    | Materialized tenant identity. Composite tenant foreign keys prevent cross-workspace references; an ID alone does not establish caller authority.                                                                                 |
| `workflow_id`, `workflow_version_id`              | Authoring identity and the immutable publication pin are different. Execution advances use the captured version rather than a mutable current publication.                                                                       |
| `revision`                                        | Version or change position within its owning protocol. Authoring/checkpoint revisions are distinct from the allocated Inbox revision sequence; the checkpoint comparison fences scheduler persistence and its associated writes. |
| `execution_entitlement_version`                   | Admission's reference to execution-limit records. Instance limit updates propagate to existing entitlement records; this is not an immutable history of old limit values.                                                        |
| `variable_set_revision`                           | Reference to an immutable captured non-secret variable set; execution retention can remove the reference after details expire.                                                                                                   |
| `input_ref`, `output_ref`                         | Stored execution-value envelopes, including inline values or artifact descriptors. Runtime validators own their meaning; SQL guards preserve the existing byte bounds at writes.                                                 |
| `scheduler_state`                                 | Versioned engine checkpoint with scoped invocation/frontier state; compaction prevents retaining every completed loop iteration.                                                                                                 |
| `artifact_owner_references` locators              | `owner_family`, `owner_id`, `owner_sub_id` and `owner_slot` locate a source row/value. The derived locator does not grant the reader that owner's audience.                                                                      |
| `workflow_run_active_admissions.borrowed_call_id` | A transferred capacity reservation belongs to a workflow Call loan; it is not a second independent active slot.                                                                                                                  |
| `trigger_schedules.lease_token`                   | Token fencing for a claimed lease; an earlier claimant cannot retire or release a later holder's lease.                                                                                                                          |
| `payload_checksum`                                | Integrity identity of a transport payload, distinct from command idempotency or authorization.                                                                                                                                   |
| `outbox_events` timestamps                        | Publication, failure and delivery-recovery timestamps describe transport progress, not the workflow run's execution outcome.                                                                                                     |
| `input_ref_expires_at`, `details_purged_at`       | Retained input availability and execution-detail removal are separate from the longer-lived run summary.                                                                                                                         |
| `connection_events.actor_id`                      | Text actor identity can describe worker/system activity as well as a person; it is not always a user foreign key.                                                                                                                |
| Authentication and connection secrets             | Authentication-library credential/session records are separate from sealed workflow-connection credentials and their versioned encryption metadata.                                                                              |

## Tables

| Table                                             | Purpose                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `api_tokens`                                      | Personal, workspace-scoped API credentials and scopes.                                                  |
| `artifact_links`                                  | Explicit execution owners that keep generated artifacts alive.                                          |
| `artifact_owner_references`                       | Derived index of file identities embedded in retained owner values; never visibility authority.         |
| `artifacts`                                       | Stored-object identity, immutable metadata, lifecycle status and expiry.                                |
| `audit_events`                                    | Workspace audit history with bounded metadata.                                                          |
| `auth_accounts`                                   | Sign-in credentials and external account links; includes password hashes.                               |
| `auth_directory_group_mappings`                   | Directory group to workspace-role mappings, scoped by workspace or verified organization context.       |
| `auth_directory_group_members`                    | Provisioned directory user/group relationships.                                                         |
| `auth_directory_groups`                           | Provisioned identity-organization groups.                                                               |
| `auth_directory_memberships`                      | Provenance for directory-managed workspace membership.                                                  |
| `auth_directory_users`                            | Provisioned directory identities and their state.                                                       |
| `auth_domains`                                    | Verified domain ownership and sign-in enforcement configuration.                                        |
| `auth_email_proofs`                               | Short-lived proof for an email-address operation.                                                       |
| `auth_federation_attempts`                        | State and proof for an OIDC/SAML sign-in journey.                                                       |
| `auth_method_link_attempts`                       | Short-lived proof for linking a sign-in method.                                                         |
| `auth_organization_workspaces`                    | Workspace links and default roles within an identity organization.                                      |
| `auth_organizations`                              | Identity organization and its controlling workspace.                                                    |
| `auth_provider_checks`                            | Verification evidence for sign-in provider configuration.                                               |
| `auth_providers`                                  | OIDC/SAML provider configuration and sealed secrets.                                                    |
| `auth_provisioning_credentials`                   | SCIM credential identity, scope and revocation.                                                         |
| `auth_sessions`                                   | Authentication sessions and session tokens.                                                             |
| `auth_sign_in_attempts`                           | Sign-in journey state and expiry.                                                                       |
| `auth_two_factors`                                | Second-factor authentication secrets and recovery data.                                                 |
| `auth_verifications`                              | Authentication-library verification records.                                                            |
| `connection_events`                               | Connection lifecycle and credential-access history, with retention.                                     |
| `connection_health_observations`                  | Recorded evidence of connection usability.                                                              |
| `connection_oauth2_authorizations`                | Pending authorization journeys for workflow OAuth2 connections.                                         |
| `connection_oauth2_clients`                       | Workflow OAuth2 client configuration and sealed client secrets.                                         |
| `connection_oauth2_tokens`                        | Sealed OAuth2 grants and refresh coordination state.                                                    |
| `connection_secret_versions`                      | Versioned sealed connection credentials.                                                                |
| `connection_shares`                               | Connection-use grants to members or groups.                                                             |
| `connections`                                     | Workspace-owned external-service connection identity and current credential pointer.                    |
| `data_table_write_receipts`                       | Idempotent workflow data-table write results, committed with the write.                                 |
| `failure_notification_destination_versions`       | Immutable shared-alert destination configuration versions.                                              |
| `failure_notification_destinations`               | Shared-alert destination identity and current configuration pointer.                                    |
| `form_uploads`                                    | Form-issued file reservations before execution admission.                                               |
| `idempotency_records`                             | Workspace command identity, request hash and durable result.                                            |
| `identity_security_audit_facts`                   | Identity security evidence with a bounded stored shape.                                                 |
| `inbox_receipts`                                  | Transport-consumption deduplication receipts, independent of the personal Inbox.                        |
| `instance_capacity`                               | Singleton operator-configured execution and artifact limits.                                            |
| `node_attempt_connection_dispatches`              | Connection credential/health binding for a dispatched step attempt.                                     |
| `node_attempts`                                   | Attempt-level dispatch, provider outcome and execution evidence.                                        |
| `node_runs`                                       | Logical invocation state, retained input/output and pending wait information.                           |
| `notice_mail_batches`                             | Personal notice email delivery batches and progress.                                                    |
| `notice_mail_items`                               | Notice items captured into one email batch.                                                             |
| `notice_preferences`                              | Personal notification email schedule and preferences.                                                   |
| `notice_subscriptions`                            | Personal subject follow/mute choices; grants no access.                                                 |
| `notice_workspace_settings`                       | Workspace-level defaults for notices.                                                                   |
| `operator_commands`                               | Operator command receipts and outcome history.                                                          |
| `operator_run_replay_requests`                    | Operator-issued replay requests and their admission outcome.                                            |
| `operator_unknown_outcome_evidence`               | Operator evidence used to resolve an uncertain provider outcome.                                        |
| `outbox_events`                                   | Transactional transport deliveries, publication state and delivery evidence.                            |
| `outbox_fair_dispatch_cursor`                     | Shared dispatch position for fair workspace selection.                                                  |
| `pending_run_tasks`                               | Durable human/callback waits and their resolution state.                                                |
| `preview_attempts`                                | Attempt-level execution evidence for a draft step preview.                                              |
| `preview_runs`                                    | Saved draft step-preview execution and retained values.                                                 |
| `run_checkpoints`                                 | Versioned scheduler-state document for one workflow run.                                                |
| `run_error_workflow_intents`                      | Durable admission intent for a separate error workflow.                                                 |
| `run_events`                                      | Ordered retained run history events.                                                                    |
| `run_failure_notification_audit_facts`            | Evidence of shared failure-alert processing.                                                            |
| `run_failure_notification_intents`                | Captured shared-alert delivery intents for a terminal run.                                              |
| `system_mail_deliveries`                          | Durable platform mail delivery and retry state.                                                         |
| `transport_security_audit_facts`                  | Transport checksum-mismatch security evidence.                                                          |
| `trigger_coordinated_events`                      | Accepted events awaiting deduplicate/debounce/throttle admission.                                       |
| `trigger_event_windows`                           | Per-key coordination windows and counters.                                                              |
| `trigger_schedule_occurrences`                    | Scheduled occurrence identity and admission outcome.                                                    |
| `trigger_schedules`                               | Schedule timing, lease and health storage.                                                              |
| `usage_events`                                    | Bounded-category usage facts with category-specific retention.                                          |
| `user_profile_command_receipts`                   | Actor-scoped profile command idempotency results.                                                       |
| `users`                                           | Stable Pertexo account identity and standing.                                                           |
| `webhook_endpoint_ingress_limits`                 | Serialized per-endpoint ingress window counters.                                                        |
| `webhook_run_responses`                           | A webhook run's selected bounded HTTP response.                                                         |
| `webhook_test_events`                             | Short-lived live webhook capture for authoring.                                                         |
| `webhook_trigger_deliveries`                      | Webhook receipt and admission evidence.                                                                 |
| `webhook_trigger_endpoints`                       | Opaque public webhook endpoint identity and standing.                                                   |
| `webhook_trigger_replay_records`                  | Webhook replay deduplication identities.                                                                |
| `webhook_trigger_secret_versions`                 | Versioned webhook verification secrets.                                                                 |
| `workflow_calls`                                  | Pinned parent/child execution relationship and call result state.                                       |
| `workflow_comment_mentions`                       | Explicit member mentions in a workflow comment.                                                         |
| `workflow_comment_threads`                        | Workflow or stable-step discussion and resolution state.                                                |
| `workflow_comments`                               | Authored discussion messages.                                                                           |
| `workflow_concurrency_policies`                   | Per-workflow concurrency and queue policy.                                                              |
| `workflow_drafts`                                 | Mutable authoring graph with optimistic revision.                                                       |
| `workflow_error_policies`                         | Configured target for independent error-workflow admission.                                             |
| `workflow_failure_notification_policies`          | Workflow binding to a shared failure-alert destination.                                                 |
| `workflow_failure_streaks`                        | Derived auto-pause consecutive-failure state.                                                           |
| `workflow_favorites`                              | One member's private workflow bookmarks.                                                                |
| `workflow_folder_grants`                          | Folder-specific audience grants within workspace authority.                                             |
| `workflow_folders`                                | Workspace workflow folder hierarchy.                                                                    |
| `workflow_forms`                                  | Public form definition and opaque capability identity.                                                  |
| `workflow_input_case_payloads`                    | Stored JSON payload and expectations for a run-input case.                                              |
| `workflow_input_cases`                            | Named reusable manual-run input cases.                                                                  |
| `workflow_integration_usage`                      | Published-version connection/integration usage projection.                                              |
| `workflow_manual_start_rejections`                | Durable evidence of rejected manual admission.                                                          |
| `workflow_organization_state`                     | Revision for workflow organization metadata changes.                                                    |
| `workflow_presence_leases`                        | Expiring advisory editor presence; grants no lock or authority.                                         |
| `workflow_promotion_origins`                      | Target workflow lineage from a source workspace promotion.                                              |
| `workflow_publication_requests`                   | Review request for one exact draft revision.                                                            |
| `workflow_run_active_admissions`                  | Reserved active-run capacity and borrowed-slot ownership.                                               |
| `workflow_run_values`                             | Retained execution values separate from scheduler state.                                                |
| `workflow_runs`                                   | Execution identity, immutable version pin, lifecycle and retained run values.                           |
| `workflow_step_samples`                           | Captured shared draft step pins with bounded payloads.                                                  |
| `workflow_tag_assignments`                        | Workflow-to-tag relationships.                                                                          |
| `workflow_tags`                                   | Workspace-defined tag identity and label.                                                               |
| `workflow_template_origins`                       | Template provenance attached to a workflow.                                                             |
| `workflow_test_snapshots`                         | Saved draft test snapshots and execution context.                                                       |
| `workflow_test_suite_cases`                       | Ordered case membership in a workflow test suite.                                                       |
| `workflow_test_suites`                            | Saved workflow test-suite definition and report.                                                        |
| `workflow_trigger_failures`                       | Queued trigger failure evidence awaiting core processing.                                               |
| `workflow_trigger_outcomes`                       | Terminal-run outcomes awaiting auto-pause folding in core.                                              |
| `workflow_trigger_pause_periods`                  | Recorded automatic trigger-pause periods.                                                               |
| `workflow_triggers`                               | Published trigger configuration and activation bindings.                                                |
| `workflow_version_dependencies`                   | Immutable callable-workflow version dependencies.                                                       |
| `workflow_version_promotions`                     | Source/target immutable published-version correspondence.                                               |
| `workflow_versions`                               | Immutable published graph and executable identity.                                                      |
| `workflows`                                       | Workspace workflow identity, lifecycle and current publication.                                         |
| `workspace_artifact_capacity`                     | Locked derived artifact count/byte charges and limits.                                                  |
| `workspace_creation_idempotency_records`          | Actor-scoped workspace-creation command results.                                                        |
| `workspace_data_table_quotas`                     | Workspace data-table count and storage capacity bookkeeping.                                            |
| `workspace_data_table_rows`                       | Typed user dataset rows and optimistic revisions.                                                       |
| `workspace_data_tables`                           | User dataset definition, stable column identities and counters.                                         |
| `workspace_execution_admission_counters`          | Locked derived active/queued execution counts.                                                          |
| `workspace_execution_entitlement_versions`        | Execution-limit records referenced by admission; instance limit changes propagate to existing versions. |
| `workspace_execution_entitlements`                | Current execution entitlement version pointer.                                                          |
| `workspace_inbox_events`                          | Durable queue of personal-Inbox changes to fold in core.                                                |
| `workspace_inbox_failure_days`                    | Per-day failure aggregation backing Inbox failure windows.                                              |
| `workspace_inbox_reads`                           | One recipient's read position for an Inbox thread.                                                      |
| `workspace_inbox_threads`                         | Shared notice subject state, revision and failure summary.                                              |
| `workspace_invitation_acceptance_intents`         | Short-lived accepted invitation proof and binding state.                                                |
| `workspace_invitation_binding_replacement_claims` | Serialized replacement of an invitation identity binding.                                               |
| `workspace_invitation_delivery_attempts`          | Invitation-mail delivery attempts and evidence.                                                         |
| `workspace_invitations`                           | Workspace invitation identity, role and lifecycle.                                                      |
| `workspace_lifecycle_operations`                  | Durable workspace deletion/restoration/purge operation state.                                           |
| `workspace_memberships`                           | A user's workspace role, status and membership provenance.                                              |
| `workspace_promotion_targets`                     | Configured cross-workspace authoring promotion destinations.                                            |
| `workspace_variable_set_revisions`                | Immutable non-secret variable snapshots captured by executions.                                         |
| `workspace_variables`                             | Current non-secret named workspace variable definitions.                                                |
| `workspaces`                                      | Workspace tenant identity, standing and operator settings.                                              |
