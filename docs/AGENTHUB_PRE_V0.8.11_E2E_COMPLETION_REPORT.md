# AgentHub PRE-V0.8.11 E2E Completion Report

Date: 2026-09-21 (Asia/Hong_Kong)

## Locked versions

```text
Backend:
0.7.3K

Backend Production:
d3ec66605d469e5328caff2317a8605a69419b7c

Backend tested HEAD:
302bb08d4502572f3cbf25d160303f619817f3b3

Desktop:
V0.8.10D

Desktop Production:
bff306cd3ba1b5c5e5f612ebe6a604164c9c619f

Desktop tested HEAD / Docs main:
a24e1d3cb9ea8fddd098d5a0e0179980cfa6d87f

Fake Provider:
YES

Real Provider calls:
0
```

Both tested worktrees were clean before testing. The tested Backend and Desktop source, test, package, and TypeScript configuration paths have no code difference from their respective Production commits; the later commits contain documentation changes only.

## Executive result

```text
Final:
NOT SEALED
```

The Backend regression, Desktop regression, and the real Backend 0.7.3K + deterministic Fake Provider + Desktop connection smoke passed. Native Windows automation subsequently became available and drove the real Electron UI into the Backend Lifecycle Workspace. That run exposed a blocking Desktop mutation-lifecycle defect: after `Create Intake` succeeds, the next lifecycle mutation (`Create Plan`) is rejected locally with `Submit is already in flight`. The Backend confirms that exactly one new Intake was created and no new Plan, Task, or Assignment was created by the blocked action. The release gate therefore remains unsealed.

The earlier Desktop `npm ci` failure was resolved by installing `Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64.Spectre`. The MSVC 14.44 Spectre libraries are present for x64, x86, and onecore, and `electron-rebuild` now completes successfully.

## E2E matrix

### E2E-01 Happy Path: FAIL

- PASS: real Backend 0.7.3K health (`status=ok`, `version=0.7.3K`).
- PASS: deterministic Fake Provider dispatch produced exactly one authoritative `REVIEWING` task and Review.
- PASS: Desktop connection hydrated `/state` and `/reviews` and matched the Review by exact `runtimeTaskId`.
- PASS: Backend automated coverage proves review ACCEPT completes the task/plan exactly once.
- PASS: the real Desktop GUI showed `connected`, Backend `0.7.3K (ok)`, `E2E Project`, and `E2E Worker`.
- PASS: `Create Intake` through the real Electron GUI created exactly one new Intake with goal `创建一个测试任务并完成`.
- FAIL: the immediately following real GUI `Create Plan` action was rejected with `Submit is already in flight`; Backend state remained at 2 Intakes, 1 pre-existing completed Plan, 1 Task, and 1 Assignment.
- Root cause evidence: `AgentHubLifecycleWorkspace.applyResult()` calls `lifecycleRef.current.onEdit()` while `TaskSubmissionIdLifecycle` is still in `submitting`; `onEdit()` does not settle that phase. Unlike the other submission/execution modals, this workspace never calls `onResult(...)`, so all later lifecycle mutations remain blocked.

### E2E-02 Revision: FAIL

- PASS: Backend real Git integration reused one assignment and one healthy Fake Provider session for exactly one revision turn.
- PASS: review round-trip tests prove `REQUEST_REVISION` rotates the handle and preserves one active Review.
- FAIL: the revision flow could not be driven end-to-end through the real Desktop GUI because the first successful lifecycle mutation permanently leaves the workspace submission lifecycle in flight.

### E2E-03 Backend Restart: PASS

- SQLite close/reopen tests preserved plan, runtime task, assignment, review identity, and exact `runtimeTaskId`.
- Startup recovery tests resumed/requeued safely, remained idempotent, and failed closed for uncertain owned residue.
- Repeated recovery produced one Review and one dispatch event without duplicate assignment/provider turns.

### E2E-04 Desktop Restart: FAIL

- PASS: Desktop connection stop/restart, generation isolation, lifecycle Review rehydration, and stale-record cleanup tests passed.
- PASS: the actual Electron window was closed by the user and restarted against the live Backend; the Desktop reconnected and recovered the Backend snapshot (`connected`, `0.7.3K`, 1 pre-existing Plan).
- FAIL: the required restart while a Plan is at `REVIEWING` could not be reached because the GUI mutation-lifecycle blocker prevents creating and advancing a new Plan.

### E2E-05 Realtime Reconnect: PASS

- WebSocket close, hello timeout, synchronous socket creation failure, stale-socket isolation, reconnect, and coalesced REST resync tests passed.
- Realtime remains invalidate/resync only; authoritative state comes from REST.

### E2E-06 Idempotency: PASS

- Backend tests passed for concurrent same-key joins, cached success/failure replay, fingerprint conflict rejection, and no repeated lifecycle side effects.
- Plan materialization tests preserved exactly one runtime task across replay and restart.
- Desktop lifecycle/task/review mutation services reuse the same key for the same logical mutation and reject changed payloads.

### E2E-07 Duplicate Click: PASS

- Desktop double-click and in-flight coalescing tests passed.
- Backend authoritative idempotency tests prove the operation and side effects execute once.

### E2E-08 Assignment Uniqueness: PASS

- Materialization, scheduler, assignment recovery, partial persistence, and repeated wakeup tests passed without a second live Assignment.
- Provider-turn and review-preparation recovery tests did not repeat dispatch/provider work.

### E2E-09 Provider Failure: PASS

- Deterministic provider failure tests prove no direct `COMPLETED`, no fabricated Review, no duplicate provider turn, and fail-closed handling for uncertain ownership.
- Agent/assignment recovery and cleanup tests passed.

### E2E-10 Review Identity: PASS

- The real cross-repository smoke matched Backend Review to Desktop task only by exact `runtimeTaskId`.
- A deliberately mismatched runtime task with the same plan/task context did not match.
- Negative tests prohibit title, clientId, planTaskId-only, and prefix fallback matching.

## Regression results

### Backend regression: PASS

Commands:

```text
npm ci
npm run check
git diff --check
```

Results:

```text
npm ci: PASS
typecheck: PASS
build: PASS
lint: PASS
tests: 1425 passed, 12 skipped; 110 files passed, 5 skipped
git diff --check: PASS
```

The skipped tests are explicitly gated real-provider tests. No real provider was called.

### Desktop regression: PASS

Commands:

```text
npm ci
npm run typecheck
npm run test:agenthub
npm run test:agenthub:smoke
npm run check:links
npm run build
git diff --check
```

Results:

```text
npm ci: PASS (electron-rebuild and node-pty rebuild completed; MSB8040 resolved)
typecheck: PASS
test:agenthub: PASS (415 passed, 1 skipped)
test:agenthub:smoke default: PASS (6 passed, 1 gated skip)
test:agenthub:smoke with AGENTHUB_REAL_BACKEND_SMOKE=1: PASS (7 passed, 0 skipped)
check:links: PASS
build: PASS
git diff --check: PASS
```

The production build and all mandatory Desktop regression commands completed successfully. The real Backend smoke also passed with 7 passed, 0 failed, and 0 skipped.

## Architecture and scope gates

```text
New lifecycle authority added to Desktop:
NO

Renderer generic fetch / HTTP / shell / exec / spawn / filesystem / Provider CLI authority added:
NO

Backend remains authoritative for scheduler, dispatcher, plan eligibility,
dependency truth, assignment truth, provider runtime, review, recovery, and completion:
YES

Windows Packaging started:
NO

Real Provider calls:
0
```

## Required follow-up before sealing

1. Correct the Desktop lifecycle workspace submission-state settlement so every applied/failed/ambiguous result advances `TaskSubmissionIdLifecycle` consistently with the existing task submission and execution modals; add a sequential-mutation regression test.
2. Re-run the real Electron GUI against Backend 0.7.3K and deterministic Fake Provider for the complete happy path, revision path, and restart-at-`REVIEWING` path.
3. Attach evidence showing all ten E2E rows PASS; both mandatory regressions are now PASS.

Until those follow-ups pass:

```text
PRE-V0.8.11 E2E SEALED: NO
Windows Packaging: NOT STARTED
```
