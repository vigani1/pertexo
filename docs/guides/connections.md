# Connections

Connections store a workspace's credentials encrypted. Owners and admins create
and replace them; people with permission to use them can select them in steps.
Responses, run receipts and connection tests never reveal the password or token.

## Choose a connection

Open **Connections** and choose the kind used by your step or trigger.

- **HTTP** stores request headers or an OAuth2 grant. See
  [HTTP Request authentication](http-requests.md#authentication) and
  [add an OAuth2 connection](oauth2-connections.md#add-one).
- **Slack** uses a bot token for Slack steps. Give the bot access to the channels
  it needs.
- **Email** uses Resend or SMTP for [Send email](email.md) and can also power
  shared failure alerts. See the setup below.
- **PostgreSQL** connects to your database for
  [query and write steps](../feature-plans/53-database-step.md#outcome) or
  [row polling](../feature-plans/55-database-row-trigger.md#what-the-builder-does).
- **Signing key** stores the key used by the
  [HMAC signature step](data-transforms.md#crypto-and-hmac-signature).
- **AI** stores a model endpoint and API key. See
  [AI Model setup](../feature-plans/56-ai-model-step.md#outcome).
- **MCP** connects to an external server for MCP Call Tool. See
  [MCP client settings](../feature-plans/60-mcp.md#client-settings-and-execution).
- An operator-approved **community integration** can offer its own connection
  form. Its required fields come from the approved package. See
  [community integration releases](../operations/single-server.md#community-integration-releases).

## Set up email

Open **Connections** and choose **Email · Resend** or **Email (SMTP)**.
The Email form also lets you switch between Resend and SMTP, including when
you add a connection from a Send email step. For SMTP, enter the host, port,
username, password and from address. The from name
is optional. STARTTLS is required by default; choose implicit TLS for servers
that start encrypted (usually port 465), or required STARTTLS (usually 587).

Choose None only for a trusted relay: credentials and email then travel without
encryption, and the operator must explicitly allow it. A private or local relay
also needs the operator's outbound-network allowlist. Ask the operator for these
settings; choosing None does not grant network access.

Save, then test. SMTP connects, upgrades TLS when selected, authenticates and
quits without sending mail. A pass confirms connectivity and sign-in; the server
can still refuse a sender or recipient when an actual message is sent. Failed
tests distinguish connection, TLS and authentication problems using safe text.
Resend's test continues to ask permission before sending its real test message.

Use the connection in [Send email](email.md) or a shared email failure-alert
destination. Replacing SMTP credentials requires all fields again; the password
is never read back. Existing Resend connections keep working.

Failure alerts can also use **Send with this server's mail**, with a current
workspace member as recipient. That destination needs no connection. See
[notifications](notifications.md#failure-alerts-through-this-server).
