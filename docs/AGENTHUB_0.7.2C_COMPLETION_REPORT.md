# AgentHub 0.7.2C Completion Report

## Provenance

```text
Repository: 704986409/AgentHub
Base SHA: e06829a7cfdbf71802eaeebc61296005143216b6
Base tag: 0.7.2B (MUST NOT MOVE)
Historical tags 0.7.2 / 0.7.2A: unchanged
Release version: 0.7.2C
Release tag: 0.7.2C
Final SHA: b26c2412f81b6c52f0a1cfe9f6f18ceef2b12173
```

## Exact production fixes

Windows process tree cleanup:
- win32 path waits for `taskkill.exe /PID /T /F` completion before confirming root child exit
- `child.kill('SIGKILL')` is fallback only (taskkill spawn/error/timeout/nonzero)
- total cleanup budget is `deadline = now + stopTimeoutMs` with remaining() per phase
- helper accepts injectable `platform` / `spawnKiller` for unit tests
- ownership still released only after confirmed root exit; timeout quarantines

CapabilityDetector `--help` throw:
- Cursor and Antigravity wrap `--help` runner in try/catch
- throw → `PROBE_FAILED`, `installed=true`, `usable=false`, version preserved
- `detect()` does not throw runner exceptions

Antigravity signal-dead child:
- `processAlive` requires `signalCode === null`
- SIGKILL / SIGTERM dead child is not reused
- next turn spawns fresh process with `--conversation <owned-id>`

Antigravity persistent listeners:
- per-turn `error` / `exit` listeners are stored and removed in `#detachListeners`
- terminal success, fatal, timeout, stdin write error, process error/exit, and shutdown all detach

package-lock version sync:
- package.json = 0.7.2C
- package-lock root version = 0.7.2C
- packages[""].version = 0.7.2C

## Changed production files

```text
package.json
package-lock.json
src/providers/shared/ProcessCleanup.ts
src/providers/cursor/CursorCapabilityDetector.ts
src/providers/antigravity/AntigravityCapabilityDetector.ts
src/providers/antigravity/AntigravityWorkerSession.ts
```

## Changed test files

```text
tests/provider-runtime-0.7.2C.test.ts
```

## Windows process tree cleanup

```text
PASS
Case A: taskkill exit 0 → child exits → killCount = 0
Case B: taskkill nonzero → child.kill fallback → exited
Case C: hanging taskkill → bounded timeout (<400ms with 40ms budget) → fallback kill → timed-out
```

## Cursor help throw fail-closed

```text
PASS
```

## Antigravity help throw fail-closed

```text
PASS
```

## Antigravity signal-dead detection

```text
PASS
SIGKILL and SIGTERM both spawn fresh `--conversation` resume
```

## Antigravity listener boundedness

```text
PASS
20 persistent turns: error/exit listenerCount = 0 after each settle
```

## Focused tests

```text
Command:
npx vitest run tests/provider-runtime-0.7.2C.test.ts tests/provider-runtime-0.7.2B.test.ts tests/provider-runtime-0.7.2A.test.ts tests/cursor-worker-session.test.ts tests/antigravity-worker-session.test.ts tests/provider-catalog.test.ts --testTimeout=8000 --hookTimeout=8000

passed: 91
failed: 0
skipped: 0
total: 91
```

All new async tests use `{ timeout: 5000 }` or `8000` for cleanup. Cleanup hang budget is 40ms.

## Other local checks

```text
typecheck: PASS
build: PASS
lint: PASS
git diff --check: PASS
```

## Full CI

```text
CI Run: pending GitHub Actions on the 0.7.2C commit
CI conclusion: pending at report authoring time
```

## External API / model calls

```text
0
```

## Desktop changed

```text
NO
```

## V0.8.9 started

```text
NO
```

## Final status

```text
PENDING INDEPENDENT AUDIT
```
