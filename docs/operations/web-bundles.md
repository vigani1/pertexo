# Production web bundle measurement — 2026-11-10

J2 compared production builds with the same application source and fresh isolated
Chromium contexts, using port 5460. The login view reached its Sign in button;
only the session refusal and authentication-capabilities API responses were
stubbed. No signed-in session or running API was reused.

| Measurement | Existing React runtime grouping | Additional shared API transport grouping |
| --- | ---: | ---: |
| Emitted JavaScript chunks | 323 | 311 |
| Total emitted JavaScript bytes | 4,261,425 | 4,255,148 |
| Login JavaScript requests | 79 | 75 |
| Login requests including two API reads | 86 | 82 |
| Initial resource body bytes | 568,071 | 569,996 |

The retained `api-client` group collects `src/lib/api` without collecting route
UI. It removes four initial script requests for 1,925 additional initial body
bytes (0.34%), and twelve emitted chunks overall. These are Vite preview resource
body sizes, not compressed production transfer sizes. They do not establish an
LCP or latency improvement. Keep heavy feature UI and data conditional; avoid a
single vendor or whole-application chunk. The pre-existing React runtime group
continues to provide its separate cache boundary.

The local batch evidence contains the two build logs, request/resource JSON and
the browser measurement script. Re-measure the same route after changing chunk
rules; request counts alone do not show the cost of eager bytes on other routes.
