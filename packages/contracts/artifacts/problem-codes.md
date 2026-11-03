# API problem codes

Generated from the problem manifest; run `pnpm contracts:generate`. Branch on the code, never on `detail`.

| Code | Status | Title |
| --- | --- | --- |
| `api_token.limit` | 409 | Active token limit reached |
| `api_token.unavailable` | 503 | Automation tokens unavailable |
| `artifact.conflict` | 409 | Artifact conflict |
| `artifact.too_large` | 413 | File too large |
| `artifact.unavailable` | 503 | Artifact storage unavailable |
| `auth.alternative_required` | 403 | Another sign-in method required |
| `auth.conflict` | 409 | Authentication change conflict |
| `auth.email_not_verified` | 403 | Email verification required |
| `auth.forbidden` | 403 | Forbidden |
| `auth.last_method` | 400 | Another working sign-in method required |
| `auth.method_limit` | 400 | Sign-in method limit reached |
| `auth.organization_email_managed` | 403 | Organization email address is managed |
| `auth.recovery_required` | 403 | Recovery password required |
| `auth.reset_link_invalid` | 400 | Reset link invalid or expired |
| `auth.session_not_fresh` | 403 | Recent sign-in required |
| `auth.sign_up_closed` | 403 | Sign-up is by invitation |
| `auth.sso_required` | 403 | Organization sign-in required |
| `auth.token_not_supported` | 403 | API tokens are not accepted here |
| `auth.token_scope_required` | 403 | Token scope required |
| `auth.two_factor_locked` | 429 | Two-factor sign-in temporarily locked |
| `auth.unauthenticated` | 401 | Authentication required |
| `callback.already_received` | 409 | Callback already received |
| `callback.expired` | 410 | Callback is no longer available |
| `callback.unavailable` | 503 | Callbacks are unavailable |
| `connection.conflict` | 409 | Connection conflict |
| `connection.not_configured` | 503 | Connections are not configured |
| `connection.oauth2_endpoint_refused` | 400 | OAuth2 address refused |
| `connection.oauth2_token_refused` | 409 | OAuth2 token refused |
| `connection.revoked` | 409 | Connection unavailable |
| `data_table.conflict` | 409 | Data table changed |
| `data_table.key_conflict` | 409 | Unique key already used |
| `data_table.quota_exceeded` | 409 | Data table limit reached |
| `export.already_running` | 409 | An export is already running |
| `form.access_conflict` | 409 | Form access changed |
| `form.changed` | 409 | Form changed |
| `form.file_too_large` | 413 | File too large |
| `form.file_type_not_allowed` | 415 | File type not allowed |
| `form.invalid` | 400 | Check the form fields |
| `form.required` | 409 | Use the workflow form |
| `form.unavailable` | 404 | Form unavailable |
| `form.upload_busy` | 429 | Uploads are busy |
| `form.upload_limit` | 429 | Too many uploads |
| `internal.unexpected` | 500 | Internal server error |
| `notifications.changed` | 409 | Notification settings changed |
| `notifications.unavailable` | 409 | Notification choice unavailable |
| `notifications.unsubscribe_unavailable` | 404 | Unsubscribe link unavailable |
| `pending_task.already_resolved` | 409 | Task already resolved |
| `pending_task.expired` | 409 | Task expired |
| `pending_task.not_eligible` | 403 | You cannot decide this task |
| `pending_task.run_closed` | 409 | Run is no longer waiting |
| `pending_task.self_decision` | 403 | Another person must decide |
| `provider.unavailable` | 503 | Provider unavailable |
| `request.aborted` | 499 | Request closed by the client |
| `request.idempotency_conflict` | 409 | Idempotency conflict |
| `request.invalid` | 400 | Invalid request |
| `request.method_not_allowed` | 405 | Method not allowed |
| `request.precondition_required` | 428 | Precondition required |
| `request.rate_limit_unavailable` | 503 | Request rate limiter unavailable |
| `request.rate_limited` | 429 | Request rate limit reached |
| `request.too_large` | 413 | Request body too large |
| `request.unsupported_media_type` | 415 | Unsupported media type |
| `resource.not_found` | 404 | Resource not found |
| `run.not_cancelable` | 409 | Run cannot be canceled |
| `run.outcome_unknown` | 409 | Run outcome is unknown |
| `run.recovery_unavailable` | 409 | Recovery unavailable |
| `trigger.coordination_unavailable` | 503 | Event coordination temporarily unavailable |
| `user.profile_revision_conflict` | 412 | Profile revision conflict |
| `variables.changed` | 409 | Workspace variables changed |
| `variables.usage_changed` | 409 | Workflow references changed |
| `webhook.authentication_failed` | 401 | Webhook authentication failed |
| `webhook.idempotency_conflict` | 409 | Webhook idempotency conflict |
| `webhook.invalid_json` | 400 | Invalid webhook JSON |
| `webhook.method_not_allowed` | 405 | Webhook method not allowed |
| `webhook.not_configured` | 503 | Webhooks are not configured |
| `webhook.payload_too_large` | 413 | Webhook payload too large |
| `webhook.rate_limited` | 429 | Webhook rate limit reached |
| `webhook.setting_up` | 409 | Webhook still being set up |
| `webhook.unavailable` | 503 | Webhook unavailable |
| `webhook.unsupported_media_type` | 415 | Unsupported webhook media type |
| `webhook.workflow_paused` | 423 | Workflow paused |
| `workflow.activation_failed` | 409 | Workflow activation failed |
| `workflow.already_running` | 409 | Workflow already running |
| `workflow.auto_pause_settings_conflict` | 409 | Workflow auto-pause settings conflict |
| `workflow.collaboration_conflict` | 409 | Discussion or presence changed |
| `workflow.concurrency_limit_exceeded` | 409 | Workflow concurrency limit exceeded |
| `workflow.concurrency_limit_unavailable` | 409 | Workflow concurrency limit unavailable |
| `workflow.concurrency_revision_conflict` | 409 | Workflow concurrency revision conflict |
| `workflow.error_policy_conflict` | 409 | Error workflow settings changed |
| `workflow.error_target_unavailable` | 409 | Error workflow unavailable |
| `workflow.folder_audience_review_required` | 409 | Review the audience change |
| `workflow.folder_hierarchy_conflict` | 409 | Workflow folder hierarchy conflict |
| `workflow.folder_limit_exceeded` | 409 | Workflow folder limit exceeded |
| `workflow.folder_name_conflict` | 409 | Workflow folder name conflict |
| `workflow.folder_not_empty` | 409 | Workflow folder is not empty |
| `workflow.folder_not_visible` | 409 | Workflow folder is not visible |
| `workflow.folder_revision_conflict` | 409 | Workflow folder revision conflict |
| `workflow.input_case_limit_exceeded` | 409 | Run-input case storage limit exceeded |
| `workflow.input_case_revision_conflict` | 412 | Run-input case revision conflict |
| `workflow.invalid` | 422 | Invalid workflow |
| `workflow.lifecycle_conflict` | 409 | Workflow lifecycle conflict |
| `workflow.name_conflict` | 409 | Workflow name conflict |
| `workflow.not_published` | 409 | Workflow not published |
| `workflow.organization_revision_conflict` | 409 | Workflow organization revision conflict |
| `workflow.pause_conflict` | 409 | Workflow pause conflict |
| `workflow.portability_compatibility_conflict` | 409 | Workflow compatibility changed |
| `workflow.portability_invalid` | 422 | Invalid portable workflow |
| `workflow.portability_review_conflict` | 409 | Reviewed workflow changed |
| `workflow.portability_unavailable` | 503 | Workflow import unavailable |
| `workflow.promotion_conflict` | 409 | Promotion needs review |
| `workflow.promotion_unavailable` | 503 | Promotion unavailable |
| `workflow.publication_review_conflict` | 409 | Publication request unavailable |
| `workflow.publish_approval_required` | 409 | Publication approval required |
| `workflow.published_version_conflict` | 409 | Published workflow version changed |
| `workflow.revision_conflict` | 412 | Workflow revision conflict |
| `workflow.sample_conflict` | 409 | Pinned sample changed |
| `workflow.sample_invalid` | 400 | Invalid pinned sample |
| `workflow.sample_limit` | 409 | Pinned sample storage limit reached |
| `workflow.tag_delete_overflow` | 409 | Workflow tag deletion requires bounded cleanup |
| `workflow.tag_key_conflict` | 409 | Workflow tag key conflict |
| `workflow.tag_limit_exceeded` | 409 | Workflow tag limit exceeded |
| `workflow.tag_revision_conflict` | 409 | Workflow tag revision conflict |
| `workflow.template_origin_unavailable` | 503 | Historical template origin unavailable |
| `workflow.validation_unavailable` | 503 | Workflow validation unavailable |
| `workflow.variable_snapshot_unavailable` | 409 | Captured workspace variables unavailable |
| `workspace.auto_pause_settings_conflict` | 409 | Workspace auto-pause settings conflict |
| `workspace.conflict` | 409 | Workspace conflict |
| `workspace.invitation_conflict` | 409 | Workspace invitation conflict |
| `workspace.invitation_delivery_unavailable` | 503 | Invitation delivery unavailable |
| `workspace.invitation_not_configured` | 503 | Invitations are not configured |
| `workspace.invitation_proof_expired` | 409 | Invitation verification expired |
| `workspace.invitation_recipient_mismatch` | 409 | Invitation recipient does not match |
| `workspace.invitation_revision_conflict` | 409 | Workspace invitation changed |
| `workspace.invitation_unavailable` | 404 | Workspace invitation unavailable |
| `workspace.member_directory_managed` | 409 | Membership managed by organization directory |
| `workspace.member_removal_conflict` | 409 | Workspace member removal conflict |
| `workspace.member_role_revision_conflict` | 409 | Workspace member role changed |
| `workspace.member_role_transition_conflict` | 409 | Workspace member role transition conflict |
| `workspace.member_status_conflict` | 409 | Workspace member status conflict |
| `workspace.quota_exceeded` | 429 | Workspace quota exceeded |
| `workspace.revision_conflict` | 412 | Workspace revision conflict |
