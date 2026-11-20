// ADR 069 storage categories. Exceptions are the recorded owner decisions in batches D/E.
export const SQL_FUNCTION_ALLOWLIST = Object.freeze({
  'app.apply_instance_capacity(integer,integer,integer)': {
    category: 'capacity counters',
    reason:
      'Propagate the singleton capacity limits under the existing serialization lock.',
  },
  'app.arm_dispatcher_workflow_run_active_admission(uuid,uuid)': {
    category: 'capacity counters',
    reason:
      "Arm the slot protocol's own five-minute recovery lease on an existing dispatcher reservation; no TypeScript reads or chooses it.",
  },
  'app.artifact_capacity_purge_start()': {
    category: 'capacity counters',
    reason: 'Remove an empty artifact capacity record when purge starts.',
  },
  'app.artifact_capacity_transition()': {
    category: 'capacity counters',
    reason:
      'Atomically charge/release artifact capacity; enforce immutable storage metadata and forbidden stored transitions, not deletion eligibility or timing.',
  },
  'app.artifact_owner_ids(jsonb,text)': {
    category: 'derived storage',
    reason:
      'Owner-approved Batch D exception: decode reference identities for the derived index, never visibility or retention decisions.',
  },
  'app.artifact_owner_text_may_reference(text)': {
    category: 'derived storage',
    reason:
      'Owner-approved Batch D exception: necessary descriptor precheck for text owners; the shared SDK shape is tested against deployed guards.',
  },
  'app.check_execution_value_bytes()': {
    category: 'constraints',
    reason:
      'Enforce existing execution-value byte limits only when the stored column is written.',
  },
  'app.claim_due_node_run_wakeups(integer)': {
    category: 'queue claiming',
    reason:
      'Claim a bounded due page with skip-locked row ownership and its durable wakeup.',
  },
  'app.claim_due_run_failure_notification_recoveries(integer)': {
    category: 'queue claiming',
    reason:
      'Claim due notification rows only; core owns retry, delivery evidence, audit and outbox decisions.',
  },
  'app.claim_due_trigger_polls(character varying,integer,integer)': {
    category: 'queue claiming',
    reason:
      'Acquire bounded polling leases with skip-locked row ownership. Config and progress stay tenant scoped.',
  },
  'app.claim_due_trigger_schedules(character varying,integer,integer)': {
    category: 'queue claiming',
    reason:
      'Acquire bounded, token-fenced due schedule leases, one per workspace per claim so no workspace starves another; core owns firing and misfire choices.',
  },
  'app.claim_due_workflow_run_deadlines(integer)': {
    category: 'queue claiming',
    reason:
      'Claim a bounded deadline page with skip-locked row ownership and its durable wakeup.',
  },
  'app.claim_workspace_inbox_events(integer)': {
    category: 'queue claiming',
    reason:
      'Claim bounded inbox intake rows (skip locked, worker only); core owns grouping, notice windows, latest failure and revision writes.',
  },
  'app.delete_removed_member_private_rows(uuid,uuid[],regclass)': {
    category: 'workspace isolation',
    reason:
      'A narrow removed-membership capability erases private rows without widening personal-reader policies.',
  },
  'app.discover_due_coordinated_events(integer)': {
    category: 'queue claiming',
    reason:
      "Expose each coordination key's due head across workspaces, ranked so each workspace gets a turn; core decides admission and retry.",
  },
  'app.enforce_workflow_run_admission()': {
    category: 'capacity counters',
    reason:
      'Enforce the locked capacity protocol for every writer; core owns standing, cancellation and deadline choices.',
  },
  'app.execution_artifact_ids(jsonb,text)': {
    category: 'constraints',
    reason:
      'Extract stored artifact foreign-key identities for reference-integrity locking, without granting visibility.',
  },
  'app.held_workflow_run_admission_events(uuid)': {
    category: 'queue claiming',
    reason:
      'Skip queued-run deliveries behind their queue head or beyond the free slots, so a claim checks a bounded set.',
  },
  'app.has_pending_invitation(character varying)': {
    category: 'workspace isolation',
    reason:
      'Pre-tenant discovery: whether one normalized address has a pending, unexpired invitation, exposing no invitation content.',
  },
  'app.index_artifact_owner_references()': {
    category: 'derived storage',
    reason:
      'Owner-approved Batch D exception: owner-only trigger adapter maintains the derived index in the source transaction.',
  },
  'app.instance_artifact_count_limit()': {
    category: 'capacity counters',
    reason:
      'Read the singleton count limit for a capacity default and storage reads.',
  },
  'app.lend_workflow_run_slot(uuid,uuid,uuid,uuid)': {
    category: 'capacity counters',
    reason:
      "Lend a running parent's slot to its queued child under the capacity lock order, arming the same recovery lease; the yes/no is run admission's, kept under the counter lock.",
  },
  'app.lock_execution_artifact_references()': {
    category: 'constraints',
    reason:
      'Lock declared JSON artifact dependencies before writes so physical removal cannot race live references.',
  },
  'app.lock_webhook_ingress_counter(character)': {
    category: 'capacity counters',
    reason:
      'Lock/read the ingress counter; core chooses the window, reset and retry result.',
  },
  'app.lock_workflow_run_replay_source(uuid,uuid)': {
    category: 'transactions',
    reason:
      'Context-checked source/workflow row locks return facts; core decides replay eligibility.',
  },
  'app.lock_workflow_run_replay_version(uuid,uuid,uuid)': {
    category: 'transactions',
    reason:
      'Context-checked immutable version pin lock/read, without replay policy.',
  },
  'app.lock_workspace_admission(uuid)': {
    category: 'capacity counters',
    reason: 'Maintain the shared workspace capacity lock order.',
  },
  'app.lock_workspace_execution_counter(uuid)': {
    category: 'capacity counters',
    reason:
      'Lock the capacity counter after caller-owned run/checkpoint locks.',
  },
  'app.lock_workspace_run_admission(uuid)': {
    category: 'transactions',
    reason:
      'Lock workspace/entitlement rows and return facts for the core admission decision.',
  },
  'app.lookup_public_form(uuid,character)': {
    category: 'workspace isolation',
    reason:
      'Resolve one opaque public capability; core decides availability and admission.',
  },
  'app.pending_callback_key_inventory(text)': {
    category: 'workspace isolation',
    reason:
      'Bounded cross-workspace key-version discovery for startup rotation safety, without task content.',
  },
  'app.provision_workspace_execution_admission()': {
    category: 'capacity counters',
    reason:
      'Provision capacity records atomically with workspace creation and instance-limit serialization.',
  },
  'app.rebind_workflow_run_active_admission(uuid,uuid,uuid,uuid)': {
    category: 'capacity counters',
    reason:
      "Move an existing reservation to a new advance delivery for the same queued run, re-arming a borrowed slot's recovery lease.",
  },
  'app.recover_due_workflow_run_active_admissions(integer)': {
    category: 'capacity counters',
    reason:
      "Claim reservations whose recovery lease expired (skip locked) and rebuild their lost advance job, or return a finished borrower's slot to its parent; queue claiming and counters, no product rule.",
  },
  'app.refresh_workflow_run_admission_counters()': {
    category: 'capacity counters',
    reason:
      'Keep derived run counters and ordinary reservation release consistent with every run writer.',
  },
  'app.release_dispatcher_workflow_run_active_admission(uuid,uuid)': {
    category: 'capacity counters',
    reason:
      'Release a dispatcher reservation while preserving borrowed-slot ownership.',
  },
  'app.release_trigger_schedule_claim(uuid,uuid)': {
    category: 'queue claiming',
    reason:
      'Release only the matching lease token; no schedule-health decision.',
  },
  'app.release_workflow_run_active_admission(uuid,uuid)': {
    category: 'capacity counters',
    reason: 'Release a reservation under its workspace context fence.',
  },
  'app.replace_artifact_owner_references(uuid,text,uuid,integer,jsonb,jsonb)': {
    category: 'derived storage',
    reason:
      'Owner-approved Batch D exception: single owner-only derived-index writer; source JSON remains authoritative.',
  },
  'app.require_workflow_skip_protocol()': {
    category: 'constraints',
    reason:
      'Require the existing capacity protocol; core chooses queue versus skip.',
  },
  'app.reserve_workflow_run_active_admission(uuid,uuid,uuid)': {
    category: 'capacity counters',
    reason:
      'Reserve/count capacity atomically with skip-locked ownership and workspace/run/outbox lock order.',
  },
  'app.resolve_public_pending_callback(character)': {
    category: 'workspace isolation',
    reason:
      'Resolve one opaque callback token to its tenant; core owns task decisions.',
  },
  'app.resolve_public_webhook_endpoint(character)': {
    category: 'workspace isolation',
    reason:
      'Resolve an opaque endpoint and return standing/pin/key facts for core admission.',
  },
  'app.resolve_webhook_test_event(character)': {
    category: 'workspace isolation',
    reason:
      'Resolve one opaque live capture; authoring decisions remain in core.',
  },
  'app.return_workflow_run_slot(uuid,uuid,uuid)': {
    category: 'capacity counters',
    reason:
      "Return a borrowed slot to its parent under the counter lock; whether a resumed parent keeps it is run admission's yes/no.",
  },
  'app.revoke_auth_sessions_for_email_change()': {
    category: 'security integrity',
    reason:
      'Owner-approved exception: one revocation owner covers every email writer, including operator SQL and the auth library.',
  },
  'app.revoke_auth_sessions_for_inactive_user()': {
    category: 'security integrity',
    reason:
      'Owner-approved exception: one revocation owner covers every user-standing writer, including operator SQL and the auth library.',
  },
  'app.revoke_auth_sessions_for_workspace_unavailability()': {
    category: 'security integrity',
    reason:
      'Owner-approved exception: one revocation owner covers every workspace-standing writer, including operator SQL and the auth library.',
  },
  'app.signal_outbox_rows()': {
    category: 'transactions',
    reason:
      'Emit an empty-safe statement-level queue wakeup in the same transaction as inserted outbox rows.',
  },
  'app.store_trigger_schedule_retirement(uuid,uuid,text,text,timestamp with time zone)':
    {
      category: 'queue claiming',
      reason:
        'Token-fenced storage of the health/backoff values already chosen by core.',
    },
  'app.store_webhook_ingress_counter(character,timestamp with time zone,integer,boolean,timestamp with time zone)':
    {
      category: 'capacity counters',
      reason:
        'Compare/store the locked counter tuple; core chooses window and reset values.',
    },
  'app.wake_next_ordered_workflow_run_start(uuid,uuid)': {
    category: 'capacity counters',
    reason:
      "Bring forward only the next granted run's deferred start when a granted run leaves the queue, under its writer's counter lock.",
  },
  'app.workflow_concurrency_admissible(uuid,uuid,boolean)': {
    category: 'capacity counters',
    reason:
      'Evaluate capacity and queue-order availability inside the serialized slot protocol.',
  },
  'app.workflow_run_active_admission_eligible(uuid,uuid,uuid)': {
    category: 'capacity counters',
    reason:
      'Check reservation validity and available capacity under the dispatcher protocol; core owns run admission behavior.',
  },
  'app.workflow_run_active_capacity_available(uuid,integer,uuid)': {
    category: 'capacity counters',
    reason:
      'Read active capacity with the pinned entitlement and reservation identity.',
  },
  'app.workflow_run_active_slots(uuid,uuid,uuid)': {
    category: 'capacity counters',
    reason:
      'Count the runs holding a workspace or workflow slot, without counting the queue.',
  },
  'app.workflow_run_reserved_slots(uuid,uuid,uuid)': {
    category: 'capacity counters',
    reason:
      'Count the slots reserved for queued runs, without counting the queue.',
  },
  'app.workflow_run_slot_counts(uuid,uuid,uuid)': {
    category: 'capacity counters',
    reason:
      'Read active, queued and borrowed-slot capacity counts under the shared locks.',
  },
  'app.workflow_run_slot_recovery_lease()': {
    category: 'capacity counters',
    reason:
      "Name the slot protocol's five-minute recovery lease once, for every reservation writer that arms it; no TypeScript reads or chooses it.",
  },
  'app.workspace_inbox_recipient_eligible(uuid,uuid)': {
    category: 'workspace isolation',
    reason:
      "Row-security predicate for personal inbox reads: the caller is the recipient, an active member and user, in a workspace whose status is one of policy's BROWSABLE_WORKSPACE_STATUSES (written out here, as row security needs; database's inbox-recipient-statuses test holds the two equal).",
  },
});
