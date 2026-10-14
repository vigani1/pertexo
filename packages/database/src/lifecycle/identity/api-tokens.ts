/** Membership revisions never return to an older grant, so its metadata can expire. */
export const API_TOKEN_RETENTION_RULE = Object.freeze({
  name: 'api_tokens',
  statement: `
    with page as (
      select token.id from app.api_tokens token
      join app.workspace_memberships member
        on member.workspace_id = token.workspace_id and member.user_id = token.owner_user_id
      where token.expires_at <= clock_timestamp() - interval '30 days'
        or token.revoked_at <= clock_timestamp() - interval '30 days'
        or (token.membership_revision <> member.role_revision
          and member.updated_at <= clock_timestamp() - interval '30 days')
      order by token.id limit $1
    )
    delete from app.api_tokens token using page where token.id = page.id`,
});
