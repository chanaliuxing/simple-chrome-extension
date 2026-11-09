# Local protocol and privacy boundary

## Extension permission boundary

Manifest V3; content scripts in ISOLATED world; main frame only.
Only source hosts www.1point3acres.com / 1point3acres.com and IPv4 loopback are declared.
Chrome host match patterns do not restrict the loopback permission to a particular port;
our service-worker code hardcodes port 18765 and its connect-src CSP permits only that port.
No cookies, webRequest, debugger, history, downloads or unlimitedStorage permissions.
No web_accessible_resources, no externally_connectable, no remote scripts, no MAIN-world execution.
Local/session extension storage access is restricted to TRUSTED_CONTEXTS.
The pairing token stays in trusted extension local storage; content scripts receive only the active run ID and allowed forum IDs.
Page observations do not constitute proof that the extension is undetectable.

## Receiver

HTTP binds to 127.0.0.1 only, port 18765. Host header must match that literal address and port.
An Origin header, when present, must match the paired chrome-extension:// ID.
All GET/POST operations require Authorization: Bearer <local pairing token>.
No-Origin authenticated local CLI requests are supported. This is not a defense against an already compromised local account.
No wildcard CORS. No website fetch, arbitrary URL proxy, command execution, file read or cloud credentials API.
POST limit: 700,000 UTF-8 bytes. Per visible body limit: 180,000 characters (no silent truncation).
At most eight pending captures in extension local storage; a receiver failure pauses further capture.
Receiver and extension each enforce a forum allowlist. Source URLs are checked independently at both ends.
Default data directory permissions 0700; pairing/config and SQLite files 0600.
Do not back up pairing.json or browser profiles into Git or public storage.

## Persistence

source_record: stable (source, thread ID) identity and best available capture.
capture: immutable content-addressed snapshot and original payload.
delivery_receipt: idempotent request identity; same delivery ID with different payload is rejected.
run_success: a given source/thread counted at most once in the run in which it first became complete-visible locally.
SQLite uses WAL, foreign keys, synchronous FULL and explicit transaction commit before ACK.
A later partial capture cannot demote an existing complete-visible record.
Browser outbox records are deleted only after matching capture_id/delivery_id and durable=true.
The source is not revisited for outbox retries. Browser restarts do not intentionally auto-arm a tab.
Uninstalling the extension removes extension-local pending data; clear the outbox before uninstalling.

## Endpoints

GET /v1/health -> service version, receiver allowlist, local counters.
POST /v1/captures -> strictly validated ge.browser_capture.v1 object, durable receipt.
There is intentionally no remote code execution, navigation or direct AWS endpoint.

## External technical references

Official Chrome documentation consulted 2026-09-22:
- https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- https://developer.chrome.com/docs/extensions/reference/api/storage
- https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world
- https://playwright.dev/python/docs/chrome-extensions

These describe API mechanics; they are not evidence of compatibility with today's live forum DOM.
