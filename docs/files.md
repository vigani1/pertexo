# Files in HTTP steps

F04's first consumer sends a finalized workspace artifact as an HTTP Request
body. Files are limited to **1 MiB (1,048,576 bytes)** for this consumer. Generic
storage uploads and HTTP response limits are separate; storing a larger file
does not make it usable as a request body.

The consumer/lifetime slice supplies the backend path. Input-local browser upload
controls follow in the next slice; the instructions below describe the existing
API and mapping contract, not an already shipped upload button.

## Upload and finalize

Use the existing authenticated workspace artifact API. Upload/finalize requires
`artifact:upload`, with normal cookie-session/CSRF handling; an automation token
is not an upload credential. Viewers cannot upload. Files are shared within the
workspace, not private to the person who selected them.

1. Compute the exact file length and lowercase hexadecimal SHA-256.
2. Begin with `POST /v1/workspaces/:workspaceId/artifacts/uploads`, an
   `Idempotency-Key` and `{ byteLength, mediaType, sha256 }`. Keep that key and
   metadata unchanged while recovering this reservation.
3. PUT the unchanged file to the returned upload URL using its required headers.
   Browser-owned headers such as Content-Length come from the browser. Never send
   Pertexo's cookie or API token to storage. A signed URL is a short-lived bearer
   credential; never save it in a workflow or paste it into logs.
4. Finalize with an empty JSON body at
   `POST /v1/workspaces/:workspaceId/artifacts/:artifactId/finalize`. Only an
   `available` response is attachable. PUT success alone is insufficient.

If finalization's reply is lost, read metadata or repeat finalization for the same
ID. Do not create a second upload merely because a reply was uncertain. Pending
reservations expire after 15 minutes; retries cannot extend that deadline.

## Map the file body

The body value uses the same descriptor that HTTP artifact responses already emit:

```json
{
  "kind": "artifact",
  "artifactId": "11111111-1111-4111-8111-111111111111",
  "byteLength": 4,
  "mediaType": "application/octet-stream",
  "sha256": "REPLACE_WITH_THE_FINALIZED_FILE_SHA256"
}
```

Use real finalized metadata, not the illustrative ID/hash above. A literal `body`
mapping stores that descriptor. To supply a different file per run, place the
same descriptor under `file` in the run's JSON input and map HTTP `body` from run
input `$.file`. To forward an earlier HTTP response file, map from that step's
`$.body`. The earlier artifact must also fit the request's 1 MiB ceiling.

POST, PUT, PATCH and DELETE may carry a body. GET/HEAD reject bodies. The artifact
MIME type becomes Content-Type unless an explicit permitted header supplies one.
Existing inline `{ "encoding": "utf8", "value": "..." }` and base64 bodies keep
their behavior. Multipart/form-data and file parsing are not part of this release.

## What is checked

The worker resolves the reference in its own workspace, requires available
metadata and matches ID, length, media type and SHA-256. It consumes and verifies
all bounded bytes before dispatching the HTTP request. Another workspace's ID,
forged metadata, corrupt bytes or an oversized file cannot reach the service.

Files remain opaque. Pertexo does not parse, decompress, render, execute or
virus-check them. A MIME label is not a safety guarantee. Downloads remain
attachments; sending a file is an explicit unsafe HTTP operation. HTTP failures
and unknown outcomes keep the existing retry/recovery acknowledgements. Reading
files does not enable artifact-aware reused-prefix recovery in F09.

## How long files stay

An unreferenced finalized upload has the existing 30-day deadline. A retained
draft, published version, input-case payload or execution fact protects its file.
Archiving a workflow keeps these references. Old input-case payloads stop keeping
files when the existing retention reaper removes them. Preview outputs keep
preview lifetimes and cannot be promoted into permanent workflow/run ownership
by copying their IDs.

Clearing/replacing an attachment changes its owner; it does not immediately erase
shared bytes. After the final retained reference disappears, expired files become
eligible for cleanup. Abandoned pending uploads also expire normally. Storage
remains charged until physical deletion succeeds. Workspace purge still erases
its files through the existing deletion process.

Exports keep literal file descriptors, not file bytes. Duplicating within the
same workspace can reuse them. To import into another workspace, upload there
and replace the literal descriptors; Pertexo will not grant access through a
foreign ID or silently copy the file.

Save an attachment before relying on its retention. Unsaved browser state is not
a durable reference. If a file is unavailable, re-upload and attach its finalized
reference; do not substitute a signed download URL for the descriptor.
