# AgentHub 0.7.2 Completion Report

## Release Summary

- Baseline tag: `0.7.1A`
- Release tag: `0.7.2`
- Package version: `0.7.2`
- Health version: `0.7.2`
- Scope: Provider Expansion (`cursor`, `antigravity`), Provider Catalog Service (`GET /api/v1/providers`), and Execution Output Protocol Contract (`worker-result`).

---

## Deliverables & Modules

### 1. Cursor Provider Subsystem
- `src/providers/cursor/CursorExecutableResolver.ts`: Resolved executable candidate (`agent` priority over `cursor-agent`), platform-safe file search on Windows/Linux/macOS.
- `src/providers/cursor/CursorModelDiscovery.ts`: CLI model probe via `agent models`, 512 model count bound, deduplication, hardcoded fallback models.
- `src/providers/cursor/CursorCapabilityDetector.ts`: Capability detection returning installed, version, models, error reason.
- `src/providers/cursor/CursorStreamParser.ts`: Real-time line-by-line JSON stream parser with buffer overflow limits (1MB) and malformed line fault tolerance.
- `src/providers/cursor/CursorWorkerSession.ts`: Full lifecycle session management. First turn spawns child process without `--resume` to extract session ID; continuation turns pass `--resume <sessionId>`; fail-closed validation; prompt securely streamed via stdin (not in argv); process tree termination on Windows via `taskkill /PID <pid> /T /F`.
- `src/runtime/providers/adapters/CursorAgentProvider.ts`: `AgentProvider` adapter registering capabilities (`protocols: ['worker-result']`, continuation support).

### 2. Antigravity Provider Subsystem
- `src/providers/antigravity/AntigravityExecutableResolver.ts`: Resolves `agy` CLI with platform extensions (`.cmd`, `.exe`).
- `src/providers/antigravity/AntigravityModelDiscovery.ts`: Probes available models from Antigravity CLI, bounded and deduplicated, with fallback.
- `src/providers/antigravity/AntigravityCapabilityDetector.ts`: Detects installed status, version, and model capabilities.
- `src/providers/antigravity/AntigravityStreamParser.ts`: Parses structured stream outputs and worker-result events.
- `src/providers/antigravity/AntigravityWorkerSession.ts`: Persistent worker session with standard protocol framing, taskkill process tree cleanup, and continuation integrity.
- `src/runtime/providers/adapters/AntigravityAgentProvider.ts`: `AgentProvider` adapter registering capabilities.

### 3. Provider Catalog Service & Usability Gating
- `src/services/provider-catalog-service.ts`:
  - Discovers all 4 providers: `claude`, `codex`, `cursor`, `antigravity`.
  - Concurrent request coalescing (in-flight promise reuse) and TTL caching (5s default).
  - Strict privacy boundary: output DTOs contain zero system paths, environment variables, credentials, or session IDs.
  - Exposes `isUsableSync(providerId)` for synchronous agent creation/enabling validation.
- `src/services/agent-management-service.ts`:
  - Enforced usability gate: creating an agent with `enabled: true` or calling `enableAgent()` on an unusable provider rejects with 422 `AGENT_PROVIDER_UNAVAILABLE`.
  - Creating or updating an agent with `enabled: false` is permitted even if the provider is temporarily unavailable.
- `src/api/AgentHubHttpServer.ts` & `src/api/ApiDtos.ts`:
  - `GET /api/v1/health`: Returns `0.7.2`.
  - `GET /api/v1/providers`: Read-only provider catalog endpoint.
  - `POST /api/v1/tasks/:taskId/execute`: Injects `requirements: { requiredOutputProtocols: ['worker-result'] }`.

---

## Zero Cost & Real Provider Calls

```text
Claude real calls = 0
Codex real calls = 0
Cursor real calls = 0
Antigravity real calls = 0
Total real provider API spend = $0.00
```

---

## Verification & Test Results

### Automated Quality Checks
- `npm run typecheck`: PASS (0 errors)
- `npm run build`: PASS (0 errors)
- `npm run lint`: PASS (0 errors, 0 warnings)
- `git diff --check`: PASS

### Test Suite Execution
All tests configured with explicit bounded timeouts to prevent deadlocks:
- `tests/cursor-agent-provider-adapter.test.ts`: 3 passed
- `tests/cursor-worker-session.test.ts`: 6 passed
- `tests/antigravity-agent-provider-adapter.test.ts`: 3 passed
- `tests/antigravity-worker-session.test.ts`: 6 passed
- `tests/provider-catalog.test.ts`: 4 passed
- `tests/agent-management-0.7.2.test.ts`: 4 passed
- `tests/api-v0.7.2.test.ts`: 2 passed
- `tests/execute-routing.test.ts`: 3 passed
- `tests/git-task-commit.integration.test.ts`: 3 passed
- `tests/git-workspace-change-capture.integration.test.ts`: 30 passed
- `tests/claude-persistent-stream.test.ts`: 43 passed
- `tests/claude-process-manager.test.ts`: 7 passed
- `tests/agent-management-0.7.1.test.ts`: 29 passed
- `tests/api-v0.7.test.ts`: 9 passed
- `tests/codex-protocol.test.ts`: 15 passed
- `tests/codex-process.integration.test.ts`: 4 passed

Total 0.7.2 target test assertions: 100% Passed.

---

## Git Information

- Tag: `0.7.2`
- Commit message: `feat(providers): expand cursor and antigravity providers with catalog service`
