# Physical-device gate — not yet executed

Use a local/LAN or separately authorized preview with mocked/test data. Do not
save scan sessions or send collection requests to production. Record device,
OS/browser version, build/hash, connection, battery %, room lighting and dataset.
Android Chrome required; iPhone Safari if available. Mark unavailable devices
NOT TESTED, never PASS. Run cold and warm sessions separately.

## Fast Scan — approximately 15 minutes per device

- Open scanner with `?debugScan=1`; start camera manually. Confirm permission,
  rear camera and focus. Never automate physical-camera access.
- Scan a fixed, labeled batch including MAMO EN012/013/014, multi-rarity RA01/RA02,
  Italian codes, old one-letter codes and difficult foil cards. Record expected
  physical identity/rarity; do not change OCR confidence inputs.
- Repeat 30 scans under normal light; include 5 repeats of one card, removing it
  from frame each time. Check no duplicate scan from holding the card still.
- Repeat 15 scans in low light and at oblique foil angles. Tap refocus; background
  and resume the browser; verify recovery without duplicate camera streams.
- Sustain 10 minutes. Record battery delta, perceived heat, frame stalls and any
  browser warning; do not infer temperature without a sensor reading.
- Export local telemetry JSON/CSV before leaving. For exact/review/catalog-missing
  counts also retain local scan-event classification/debug trace; not all these
  categories are separate counters in the existing telemetry summary.
- With a mocked catalog, verify EN013 absent → CATALOG_MISSING and present → EXACT;
  clear/restart the session or wait for the documented 20s miss cache. No live row
  deletion/insertion is allowed for this check.

Collect raw samples, sample count and p50/p95 for OCR (`primaryOcrMs` plus fallback
where used), ready-next (`readyNextMs`), lookup (`externalLookupMs`; background
verification duration separately). Record fallback, exact, review and
catalog-missing counts / completed attempts; exclude pending/cancelled scans and
report their count separately. Percentiles use sorted samples, not averages.
Retain error/timeout/offline counts rather than classifying them as catalog misses.

## Shared Collection — approximately 10 minutes per device

- Use the same 3,000-row fixture and 360/390 CSS-pixel viewport where available;
  record actual innerWidth. A desktop viewport emulation is not a physical test.
- Initial load, then four rapid keystrokes, backspace and paste. Check input focus,
  cursor, visible results and one debounced grid update after input settles.
- Apply each filter, switch both name orders and quantity sort; Load more twice.
  Scroll down/up; select several cards, edit quantity, close/reopen review, search
  again and reload. Confirm quantity bounds and draft/selection retention.
- Repeat 20 search/filter cycles on a low-end phone. Record visible tile count,
  total DOM nodes, scroll stutter and whether memory plateaus after repeated runs.
- Use remote Chrome DevTools / Safari Web Inspector to capture input-to-next-paint
  latency and grid render duration (report the intentional 180ms debounce
  separately), request count, duplicate URLs/payloads and lazy image requests.
  Record JS heap only where available; mark unsupported memory measurements N/A.
- Trigger two concurrent loads in the fixture: one API fetch expected. Do not send
  a real guest request; use the existing mocked submit endpoint.

## Record and decision

| Device/build | Scenario | N | p50 | p95 | Failures | Network/DOM/memory notes | PASS/FAIL/NOT TESTED |
|---|---|---:|---:|---:|---:|---|---|
| Android Chrome | Pending physical run | 0 | — | — | — | — | NOT TESTED |
| iPhone Safari | Pending availability | 0 | — | — | — | — | NOT TESTED |

Functional failures (lost selection, double events, wrong card auto-accept,
unrecoverable camera, duplicate data request) block rollout. Compare latency and
memory with the same device/build baseline; record degradation and device limits.
Do not invent a universal latency or battery threshold from desktop smoke data.
