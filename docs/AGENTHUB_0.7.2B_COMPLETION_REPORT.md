# AgentHub 0.7.2B Completion Report

## Provenance

```text
Repository: 704986409/AgentHub
Base SHA: 686433d56b044b4661bfcd3b00471f88b364cd1c
Base tag: 0.7.2A (MUST NOT MOVE)
Historical tag 0.7.2: unchanged
Release version: 0.7.2B
Release tag: 0.7.2B
```

## Exact production fixes

Cursor fatal cleanup:
- fatal path awaits bounded `killProcessTreeAndWait`
- reject happens only after cleanup result
- child reference is released only after confirmed exit, otherwise quarantined (`cleanupFailed`)

Antigravity fatal cleanup:
- same ownership invariant as Cursor
- listeners detach before bounded kill
- shutdown retries residual cleanup

Cursor signal exit:
- success requires `exitCode === 0 && signal === null`
- SIGKILL / SIGTERM / nonzero exit fail even with valid terminal + session_id + worker result

Capability readiness:
- `--help` timeout → PROBE_TIMEOUT
- `--help` spawn error / exitCode !== 0 / exitCode === null → PROBE_FAILED
- token text in stderr is not enough for READY

Native model discovery:
- JSON array or `{ models: [...] }` only
- generic line-list fallback removed
- unknown plain text → `unavailable + []`
- `[]` remains `native + []`

package-lock version sync:
- package.json = 0.7.2B
- package-lock root version = 0.7.2B
- packages[""].version = 0.7.2B

## Changed production files

```text
package.json
package-lock.json
src/providers/shared/ProcessCleanup.ts
src/providers/cursor/CursorWorkerSession.ts
src/providers/cursor/CursorCapabilityDetector.ts
src/providers/cursor/CursorModelDiscovery.ts
src/providers/antigravity/AntigravityWorkerSession.ts
src/providers/antigravity/AntigravityCapabilityDetector.ts
src/providers/antigravity/AntigravityModelDiscovery.ts
```

## Changed test files

```text
tests/provider-runtime-0.7.2B.test.ts
tests/provider-runtime-0.7.2A.test.ts
tests/cursor-worker-session.test.ts
tests/antigravity-worker-session.test.ts
```

## Focused tests

```text
Command:
npx vitest run tests/provider-runtime-0.7.2B.test.ts tests/provider-runtime-0.7.2A.test.ts tests/cursor-worker-session.test.ts tests/antigravity-worker-session.test.ts tests/provider-catalog.test.ts tests/cursor-agent-provider-adapter.test.ts tests/antigravity-agent-provider-adapter.test.ts tests/execute-routing.test.ts tests/agent-management-0.7.2.test.ts --testTimeout=8000 --hookTimeout=8000

passed: 96
failed: 0
skipped: 0
total: 96
```

All new async tests use `{ timeout: 5000 }` or equivalent. Cleanup timeout is 40ms bounded.

## Other local checks

```text
typecheck: PASS
build: PASS
lint: PASS
git diff --check: PASS
```

## Full CI

```text
CI Run: pending GitHub Actions on the 0.7.2B commit
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
