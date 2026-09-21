# AgentHub Backend 0.7.3L Completion Report

Implementation is complete for the 0.7.3L Revision Review Identity / Stale Review Lifecycle Fix. The release remains **PENDING INDEPENDENT AUDIT**.

```text
AgentHub Backend 0.7.3L
PENDING INDEPENDENT AUDIT

Base (0.7.3K main before 0.7.3L):
302bb08d4502572f3cbf25d160303f619817f3b3

Production:
e058a4749e265029271e645ca08eabcb74ab93be

Docs/main:
this docs-only commit (annotated tag 0.7.3L peels to it)

Tag:
0.7.3L

Tag object:
recorded in the annotated tag after this commit; exact object/peeled values are in the coding-agent completion message

Tag peeled:
this docs-only commit

Exact Production CI:
35635498733
url: https://github.com/704986409/AgentHub/actions/runs/35635498733

event:
push

head_sha:
e058a4749e265029271e645ca08eabcb74ab93be

status:
completed

conclusion:
success

job:
test success (18m 36s)

steps:
npm ci success
npm run typecheck success
npm run build success
npm run lint success
npm test success

Health version:
0.7.3L
```

---

## 1. Modified Files List (Production Commit)

```text
src/api/AgentHubHttpServer.ts
src/api/ReviewHandleStore.ts
src/lifecycle/plan-lifecycle.ts
src/lifecycle/review-transition-coordinator.ts
src/orchestration/TaskLifecycleOrchestrator.ts
package.json
package-lock.json
tests/api-v0.7.2.test.ts
tests/plan-api-0.7.3A.test.ts
tests/plan-execution-0.7.3A.test.ts
tests/plan-review-projection-0.7.3E.test.ts
tests/plan-review-roundtrip-0.7.3E.test.ts
tests/plan-review-revision-identity-0.7.3L.test.ts (NEW)
```

---

## 2. Root Cause Analysis (根因分析)

In real Electron GUI E2E under Backend 0.7.3K, when `REQUEST_REVISION` was submitted:
1. `TaskLifecycleOrchestrator.#revise()` transitioned runtime Task status from `REVIEWING` -> `REVISION_REQUIRED` -> `IMPLEMENTING`.
2. However, the prior review handle was not retired upfront within `ReviewHandleStore`.
3. `PlanLifecycle.projectRuntimeState()` allowed `TaskStatus.IMPLEMENTING` to return `'REVIEWING'` when `reviewPending === true`, projecting an unreviewable task as currently actionable.
4. `/api/v1/reviews` in `AgentHubHttpServer.ts` and `ReviewHandleStore.listPublic()` did not check the authoritative runtime `Task.status === TaskStatus.REVIEWING` with exact identifier match, exposing the stale Review handle during revision execution.
5. If the revision turn generated identical source/worker output, `TaskReviewBundle` produced an identical `reviewBundleSha256` without revision round identity, colliding with the prior handle.
6. Subsequent attempts to submit or accept while `Task.status` was not `REVIEWING` resulted in 409 `AGENTHUB_API_CONFLICT`.

---

## 3. Implementation Details (具体修复方式)

1. **Transactional Review Retirement on Revision**:
   - Added `ReviewTransitionCoordinator.retireForRevision(taskId, priorHandle)`:
     - Atomically expires `priorHandle` in `ReviewHandleStore`.
     - Resets `PlanLifecycle`'s `reviewPending` flag to `false`.
     - Advances durable review round counter for `taskId` (`#reviews.advanceReviewRound(taskId)`).
   - In `TaskLifecycleOrchestrator.#revise()`, `retireForRevision` is invoked before transitioning to `REVISION_REQUIRED` and `IMPLEMENTING`.
2. **Authoritative Fail-Closed Public Review Listing**:
   - `ReviewHandleStore.listPublic()` now accepts `tasks: { getTask(id: string): Task | null }`.
   - Strictly verifies that:
     - `realTask !== null`
     - `realTask.status === TaskStatus.REVIEWING`
     - `realTask.id === bundle.taskId`
     - `realTask.assignmentId === bundle.assignmentId`
     - `realTask.assignedAgentId === bundle.agentId`
     - `bundle.reviewBundleSha256` is not marked expired.
   - If runtime Task is in `IMPLEMENTING`, `REVISION_REQUIRED`, `COMPLETED`, `FAILED`, or `CANCELLED`, `/api/v1/reviews` returns nothing.
3. **Plan Projection Fail-Closed**:
   - In `src/lifecycle/plan-lifecycle.ts`, `projectRuntimeState()` projects `ASSIGNED`, `IMPLEMENTING`, `IN_PROGRESS`, and `REVISION_REQUIRED` as `'RUNNING'`, preventing any stale `reviewPending` state from disguising an executing task as `'REVIEWING'`.
4. **Deterministic Revision Round Identity**:
   - Implemented `revisionBundleToDispatch(bundle, round)` in `TaskLifecycleOrchestrator`:
     - Computes `makeRevisionReservationSha(priorReservationSha, round, priorBundleSha)` using `AgentHub.RevisionReservation.v1\0...`.
     - Derives a new, canonical 64-hex `dispatchSha256` via `dispatchDigest()`.
     - Even with identical files, test evidence, and worker output, each revision round generates a unique, distinct `reservationSha256`, `dispatchSha256`, and resulting `reviewBundleSha256`.
5. **Durable Persistence Across Restarts**:
   - `ReviewHandleStore` serializes `rounds: [...this.#rounds.entries()]` and `expired: [...this.#expired]` alongside `bundles` in the `settings` database table.
   - Restarting Backend restores active bundles, expired handles, and round counters without losing revision identity.
6. **409 Conflict Protection on Retired Handle**:
   - `ReviewHandleStore.replaceActiveForTask()` immediately rejects any bundle whose handle is recorded in `#expired` with a 409 conflict.

---

## 4. Why Stale Reviews Cannot Be Re-exposed (为什么不会重新公开 stale Review)

- As soon as `REQUEST_REVISION` is accepted, the prior handle is added to `#expired` and `reviewPending` is cleared to `false`.
- `/api/v1/reviews` requires `realTask.status === TaskStatus.REVIEWING`. During revision execution, `realTask.status` is `IMPLEMENTING`, which causes `listPublic()` to fail closed and omit the task completely.
- Any decision POST against the old handle returns 410 (handle expired and inactive).

---

## 5. Durable Review-Round Identity (review-round identity 如何 durable)

- Revision rounds are tracked by `ReviewHandleStore.#rounds` and persisted in SQLite `settings` under key `AgentHub.ReviewHandleStore.v1`.
- On startup / recovery, `ReviewHandleStore` restores all round numbers and expired handles.
- Restarts during `IMPLEMENTING` do not revive expired reviews or reset round counters.
- Restarts during subsequent `REVIEWING` preserve the exact current review handle and round identity.

---

## 6. Targeted 0.7.3L Test Results

New comprehensive test suite `tests/plan-review-revision-identity-0.7.3L.test.ts` (9 tests, 100% pass):
- **7.1 Slow Revision Provider Test**: PASS (hides stale review during held provider turn, then exposes exactly one fresh review).
- **7.2 Identical Evidence Revision Test**: PASS (generates distinct round identity even when worker result, evidence, and changedFiles are identical).
- **7.3 Restart During Revision Test**: PASS (restarting Backend while task is IMPLEMENTING does not resurrect old review; authority remains consistent).
- **7.4 Restart After Second REVIEWING Test**: PASS (restarting Backend while task is in second REVIEWING restores exact second review identity and handle).
- **7.5 Final Revision ACCEPT Test**: PASS (completes task and plan with clean terminal state, empty review list, IDLE agent, no duplicate tasks/assignments).
- **8.1 - 8.2 Negative Tests**: PASS (old handle cannot be accepted after REQUEST_REVISION; decision returns 410).
- **8.3 - 8.4 Negative Tests**: PASS (fail-closed prevents exposing review if task is IMPLEMENTING even with stale reviewPending).
- **8.5 Negative Tests**: PASS (multiple revision rounds generate distinct identities for each round: handle1 != handle2 != handle3).
- **8.6 - 8.7 Negative Tests**: PASS (idempotency key replay returns same result; distinct key on retired handle fails with 410).

---

## 7. Full Backend Regression Results

- `npm run typecheck`: PASS (0 errors)
- `npm run build`: PASS (0 errors)
- `npm run lint`: PASS (0 errors, 0 warnings)
- Vitest suite: 115 test files / 1446 tests / 100% pass rate
- GitHub Actions CI (Production SHA `e058a4749e265029271e645ca08eabcb74ab93be`): Run ID `35635498733` SUCCESS

---

## 8. Explicit Declarations (明确声明)

```text
Database migration modified: NO
Desktop source modified: NO
Scheduler authority modified: NO
Dispatcher authority modified: NO
Provider authority modified: NO
Packaging started: NO
V0.8.11 started: NO
```

---

## 9. Historical Tags Protection

Historical tags `0.7.3K` (`d3ec66605d469e5328caff2317a8605a69419b7c`), `0.7.3J`, `0.7.3I` and prior tags were NOT modified or moved.

---

## 10. Verification Statement

```text
At no point may AgentHub expose an actionable Review
for a runtime Task whose authoritative Task.status is not REVIEWING.

Every revision round owns a distinct durable review authority identity,
even when provider output and evidence are byte-for-byte identical.
```

---

PENDING INDEPENDENT AUDIT
