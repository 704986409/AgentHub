# AgentHub 0.7.1 Completion Report

## Provenance

```text
Repository: 704986409/AgentHub
Baseline tag: 0.7.0G
Baseline SHA: 03bc7824d732e740a88f9aa2c0122f3cf5df75ab
Release tag: 0.7.1
Package version: 0.7.1
Health version: 0.7.1
```

The historical `0.7.0G` tag was not moved.

## Public Contract

New runtime-safe Agent management routes:

```http
POST   /api/v1/agents
PUT    /api/v1/agents/:agentId
POST   /api/v1/agents/:agentId/enable
POST   /api/v1/agents/:agentId/disable
DELETE /api/v1/agents/:agentId
```

Existing reads remain:

```http
GET /api/v1/health
GET /api/v1/state
GET /api/v1/agents
GET /api/v1/agents/:agentId
```

Every Agent mutation requires `Idempotency-Key`. Fingerprints include HTTP method, exact route, and validated body. PUT and DELETE are dispatched explicitly; other methods remain fail-closed.

## AgentDto

Public Agent DTO now includes exact `modelId` mapped from the internal model. The raw `model` key is not public.

Create derives status from `enabled`:

```text
enabled = true  → IDLE
enabled = false → DISABLED
```

Create/update reject extra keys, `status`, client `id`, and (for update) `projectId`/`enabled`.

## Runtime Pool Consistency

`AgentManagementService` is the only public mutation owner. The composition root creates one shared `AgentPool` and passes that same pool to Scheduler, Dispatcher, Lifecycle, and AgentManagementService.

Create of a supported provider (`claude`, `codex`) registers the Agent in the pool without restart. Disabled supported Agents remain pool-registered. Provider/model updates rebind the pool registration. Profile-only updates do not unregister.

Unsupported providers are rejected before Registry/Profile/Pool mutation. Legacy unsupported Agents may be disabled or edited onto a supported provider; enable remains rejected until the provider is supported.

## Delete Safety

Hard delete is allowed only when the Agent has:

```text
0 assignment records
0 tasks referencing assignedAgentId
clean / unreserved runtime
```

There is no force delete and no cascade delete. Successful delete publishes `AgentDeleted` after Registry/Profile removal and pool unregister.

## Compensation

Registry create/update/delete compensate DB vs `AGENT.md` split-brain. Pool registration failure after create rolls back Registry/Profile. Rebind registration failure restores the previous Agent and previous runtime binding. Unrecoverable compensation surfaces `AGENTHUB_API_RUNTIME_RECONCILIATION_REQUIRED`.

Unsupported provider maps to `422 AGENTHUB_API_PROVIDER_UNAVAILABLE`.

## Real Provider Calls

Management tests use fake provider adapters. `createSession` is never invoked.

```text
Claude real calls = 0
Codex real calls = 0
Cursor real calls = 0
Antigravity real calls = 0
```

## Verification

Commands:

```bash
npm run typecheck
npm run build
npm run lint
npx vitest run tests/agent-management-0.7.1.test.ts tests/api-v0.7.test.ts tests/agent-profile.test.ts tests/event-foundation.test.ts tests/core-types.test.ts tests/agent-scheduler.test.ts tests/agent-pool.test.ts
git diff --check
```

Results:

```text
typecheck PASS
build PASS
lint PASS
git diff --check PASS
agent-management-0.7.1.test.ts  18 passed
api-v0.7.test.ts                9 passed
focused suite                   7 files / 103 passed
async tests bounded:
  vitest testTimeout/hookTimeout = 30000ms
  management tests timeout = 15000ms
  HTTP fetch AbortSignal.timeout = 8000ms
  server stop race = 5000ms
```

A full local `npm test` also executed existing long integration files. Environment-dependent local-only Codex CLI detection/handshake tests are skipped when `CI=true` (GitHub Actions). Management verification does not start Claude/Codex/Cursor/Antigravity CLIs.

## Git

```text
Commit: feat(api): add runtime-safe agent management
Tag: 0.7.1
```

SHA is the tagged 0.7.1 commit on `origin/main`.

## Final Status

```text
PENDING INDEPENDENT AUDIT
```
