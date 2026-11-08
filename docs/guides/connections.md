# Connections

Connections store a workspace's credentials encrypted. Owners and admins create
and replace them; people with permission to use them can select them in steps.
Responses, run receipts and connection tests never reveal the password or token.

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
