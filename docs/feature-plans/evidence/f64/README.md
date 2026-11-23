# F64 authoring proof

The CLI scaffolded an empty bind-mounted folder in a server-image container
with networking disabled. It checked one example and produced this approval.

| Field | Value |
| --- | --- |
| File | `integration.json` |
| Provider | `community.example.posts` |
| Version | `1.0.0` |
| Origin | `https://example-posts.provider.test` |
| SHA-256 | `d2c4be3c0ff67a79fe2da9bf3e1e6d324282d8a43a9e6e12136236a7fc936e53` |

The same bytes were mounted read-only into the API and worker in the
`pertexo-f64-author-proof` Compose project. Its TLS provider used that DNS
name on an internal Docker network. Both services used the normal secure
HTTP transport and the test certificate trusted by that project.

The step picker showed the publisher and target. The generated API key field
was masked. The API tested the saved synthetic key successfully, then a
published manual workflow sent `id = 1` to Get post. The worker projected
`{"title":"Hello"}`. The provider recorded two successful
`GET /posts/1` requests, one for the test and one for the published run.

| View | Light | Dark |
| --- | --- | --- |
| Step picker | [Light](step-tile-light.png) | [Dark](step-tile-dark.png) |
| Credential form | [Light](credential-form-light.png) | [Dark](credential-form-dark.png) |
