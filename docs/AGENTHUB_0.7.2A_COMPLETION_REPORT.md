# AgentHub 0.7.2A Completion Report

## Provenance

```text
Repository: 704986409/AgentHub
Base version: 0.7.2
Base SHA: 09d45a52e0ef9c73cdb3006f3624b34f61e3a0f3
Base tag: 0.7.2 (MUST NOT MOVE)
Release version: 0.7.2A
Release tag: 0.7.2A
Package / health version: 0.7.2A
```

Historical tags were not moved.

## Exact production fixes

- Cursor first-turn and resume turns fail closed unless a trusted `session_id` is present and exact.
- Same-turn Cursor session identity is locked to the first valid ID; A then B fails.
- Antigravity dead-child restart uses the documented `--conversation <id>` resume option and verifies returned identity.
- Cursor / Antigravity stream-json parsers fail closed on malformed JSON, duplicate terminal, missing terminal, and identity conflict.
- Parser overflow / fatal errors settle the current turn once, request child-tree cleanup, and quarantine the session (`cleanupRequired`).
- Per-turn Cursor success requires protocol success AND process `exitCode === 0`.
- Capability detectors probe `--help` for actual runtime flags (print/stream-json/resume or conversation/headless) with a 5000ms bound. Missing contract => not READY.
- Native model discovery does not truncate, skip, or guess help/banner text. 0 models in a known grammar is native empty. 513+ or malformed => unavailable.

## Changed production files

```text
package.json
src/api/AgentHubHttpServer.ts
src/providers/cursor/CursorStreamParser.ts
src/providers/cursor/CursorWorkerSession.ts
src/providers/cursor/CursorCapabilityDetector.ts
src/providers/cursor/CursorModelDiscovery.ts
src/providers/antigravity/AntigravityStreamParser.ts
src/providers/antigravity/AntigravityWorkerSession.ts
src/providers/antigravity/AntigravityCapabilityDetector.ts
src/providers/antigravity/AntigravityModelDiscovery.ts
src/runtime/providers/adapters/CursorAgentProvider.ts
src/runtime/providers/adapters/AntigravityAgentProvider.ts
src/services/provider-catalog-service.ts
```

## Changed test files

```text
tests/provider-runtime-0.7.2A.test.ts
tests/cursor-worker-session.test.ts
tests/antigravity-worker-session.test.ts
tests/provider-catalog.test.ts
tests/api-v0.7.2.test.ts
```

## Focused test results

```text
Command:
npx vitest run tests/provider-runtime-0.7.2A.test.ts tests/cursor-worker-session.test.ts tests/antigravity-worker-session.test.ts tests/provider-catalog.test.ts tests/api-v0.7.2.test.ts tests/cursor-agent-provider-adapter.test.ts tests/antigravity-agent-provider-adapter.test.ts tests/execute-routing.test.ts tests/agent-management-0.7.2.test.ts --testTimeout=8000 --hookTimeout=8000

passed: 80
failed: 0
skipped: 0
total: 80
files: 9
```

Async tests use explicit 5000–8000ms bounds. No unbounded child waits.

## Other local checks

```text
typecheck PASS
build PASS
lint PASS
git diff --check PASS
```

Full `npm test` was not used as the local gate because this round is a provider-runtime closure fix; CI owns full regression.

## Full CI

```text
CI Run: pending GitHub Actions on the 0.7.2A commit
CI status: pending at report authoring time
```

## External API / model calls

```text
0
```

## Known skipped tests

```text
0 in the focused battery above
```

## Known unrelated flakes

```text
None observed in the focused battery.
```

## Final status

```text
PENDING INDEPENDENT AUDIT
DO NOT START V0.8.9
```
