# Test results — 2026-09-22

## Executed successfully

| Area | Result | What was actually exercised |
| --- | --- | --- |
| Python receiver/storage tests | 17 passed | Commit/reopen, idempotent replay, payload collisions, partial upgrade/no downgrade, identity and allowlist rejection, rollback, export, HTTP auth/Origin/Host/CORS |
| Real Chromium DOM tests | 14 passed | Synthetic classic and Next-shaped documents, unchanged DOM, hidden/form data excluded, non-target/unknown forum, partial/media/clipping handling, challenge, pagination, canonical conflict, query redaction |
| DOM → HTTP → SQLite integration | 1 passed | Real Chromium DOM extraction; real shared JavaScript hashing executed in Node; authenticated real HTTP POST; actual SQLite commit. This is NOT an installed-extension runtime test. |
| Real background.js with simulated Chrome APIs | 9 passed | Selected tab, token boundary, matching/wrong ACK, outage/outbox replay, simulated worker restart, quota stop, challenge stop, identity mismatch |
| JavaScript syntax / Python compilation | Passed | All extension JS checked with node --check; collector.py compiled |

**Total: 41 automated checks passed. One installed-extension E2E test was skipped in the final suite.**

Environment: Chromium 144.0.7559.96, Python 3.13.5, Node 22.16.0.
All forum-shaped documents were generated test fixtures. No real forum account, production API or AWS data was accessed.
No source website requests were made by the extension/receiver code in these passing tests.

## Important blocked verification

A full installed-extension run was attempted. Chromium reported:

> Loading of unpacked extensions is disabled by the administrator.

The environment also returned ERR_BLOCKED_BY_ADMINISTRATOR for chrome://extensions.
No administrator policy was changed or bypassed. The opt-in E2E test is included in the package, but it is not counted as passed.
The background tests simulate Chrome's APIs; they do not validate actual service-worker registration, Chrome permission prompts,
extension-origin networking in the user's browser, or suspension/resume behavior inside an installed extension.

The DOM→HTTP test reads synthetic DOM in Chromium, passes the result through the shared hashing function in Node,
and uses a real authenticated HTTP request to SQLite. It proves those component interfaces agree, not that the missing Chrome runtime step is verified.

## Still required on the user's Mac

Load extension/, pair the receiver, and confirm the actual current forum DOM matches the conservative selectors.
Confirm one real permitted main post appears in SQLite; a duplicate/non-target page does not increment the completion counter.
Stop the local receiver while collecting a new page, verify a pending record remains, restore receiver and retry without revisiting the source.
Confirm clicking Stop, switching to an unarmed tab, browser restart and a visible challenge pause collection appropriately.

No overnight 300-thread navigation, mouse control, complete replies capture, model classification or cloud ingestion has been tested or implemented here.
