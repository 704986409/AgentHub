# AgentHub Backend 0.7.3M Completion Report

Implementation is complete for the 0.7.3M Revision In-Flight Durable Recovery fix. The release remains **PENDING INDEPENDENT AUDIT**. 0.7.3L remains **NOT SEALED**.

```text
AgentHub Backend 0.7.3M
PENDING INDEPENDENT AUDIT

Base (0.7.3L docs/main):
e90e281e11d4e650a398e026ba5a9fe849b0b860

Production:
51c4ae4c11312b37d72283dd17eee893671b1d87

Docs/main:
this docs-only commit (annotated tag 0.7.3M peels to it)

Tag:
0.7.3M

Tag object:
recorded in the annotated tag after this commit; exact object/peeled values are in the coding-agent completion message

Tag peeled:
this docs-only commit

Exact Production CI:
35641882396
url: https://github.com/704986409/AgentHub/actions/runs/35641882396

event:
push

head_sha:
51c4ae4c11312b37d72283dd17eee893671b1d87

status:
completed

conclusion:
success

job:
test success (17m 38s)

steps:
npm ci success
npm run typecheck success
npm run build success
npm run lint success
npm test success

Health version:
0.7.3M
```

---

## 1. Modified Files (Production Commit)

```text
package.json
package-lock.json
src/api/AgentHubHttpServer.ts
src/application/createLocalAgentHubApplication.ts
src/database/migrations.ts
src/lifecycle/plan-execution-recovery.ts
src/orchestration/TaskLifecycleOrchestrator.ts
tests/api-v0.7.2.test.ts
tests/codex-session-store.test.ts
tests/database-migration-v6-to-v7-0.7.3K.test.ts
tests/database.test.ts
tests/plan-api-0.7.3A.test.ts
tests/plan-review-revision-recovery-0.7.3M.test.ts (NEW)
```

---

## 2. Root Cause

After `REQUEST_REVISION`, 0.7.3L retires the old Review and moves the task to `IMPLEMENTING`, but `revisionBundleToDispatch(bundle, round)` existed only in process memory. `assignment_dispatch_recovery.dispatch_json` could still be the first-round initial dispatch. A restart could treat the in-flight revision as that old dispatch.

---

## 3. How Revision Dispatch Is Durable

`TaskLifecycleOrchestrator.#revise()` order:

```text
retire old Review + clear reviewPending + advance round
→ revisionBundleToDispatch(bundle, round)
→ PlanExecutionRecoveryService.persistRevisionDispatch
→ REVISION_REQUIRED
→ IMPLEMENTING
→ revision provider turn
→ persistDispatch (TURN_COMPLETED, same revision_round, new turn digest)
→ prepare review
→ markReviewReady (REVIEW_READY)
```

`persistRevisionDispatch` updates the existing `assignment_dispatch_recovery` row before the task is `IMPLEMENTING`. Schema migration 8 adds `revision_round INTEGER NOT NULL DEFAULT 0`. The row stores taskId, assignmentId, planId, revision round, reservationSha256, dispatchSha256, providerId, agentId, executionProfileSha256, workspace identity, and stage. The in-flight stage is `TURN_STARTED` with `turn_may_have_started = 1`. No second recovery store is introduced.

---

## 4. How Startup Distinguishes Initial and Revision Dispatch

`inspect()` reads `revision_round` and stage from the same recovery row. `revision_round = 0` is the initial dispatch. `revision_round >= 1` is that revision generation, and `dispatch_json` is the persisted revision identity, not the first-round digest.

If stage is `TURN_STARTED`, `turn_may_have_started = 1`, and there is no active Review, startup returns `PLAN_ASSIGNMENT_RECOVERY_REQUIRED`. It does not resume the provider, does not rebuild the old Review, and does not fall back to the initial dispatch. `turn_may_have_started` is unchanged.

A same-process residue whose stage is `TURN_COMPLETED` can still prepare the current revision review. After that review is active, stage becomes `REVIEW_READY`, so a later restart does not treat the finished revision as in-flight.

---

## 5. Targeted Test Results

```text
npx vitest run tests/plan-review-revision-recovery-0.7.3M.test.ts
Test Files  1 passed (1)
Tests       3 passed (3)

1. persists revision round 2 dispatch before the provider turn finishes — PASS
2. startup recovery keeps the revision dispatch and does not replay the provider — PASS
3. recovers a completed revision turn into a new review and accepts it — PASS

npx vitest run tests/plan-review-revision-identity-0.7.3L.test.ts
Test Files  1 passed (1)
Tests       9 passed (9)

npx vitest run tests/plan-real-dispatch-recovery-0.7.3J.test.ts
Test Files  1 passed (1)
Tests       15 passed (15)
```

Local `npm run typecheck`: PASS
Local `npm run build`: PASS
Local `npm run lint`: PASS

Full `npm test` was not run locally. Production CI run `35641882396` ran `npm test` and succeeded.

---

## 6. Explicit Scope

```text
Desktop source modified: NO
Scheduler authority modified: NO
Dispatcher authority modified: NO
New Assignment created for revision: NO
New Runtime Task created for revision: NO
Packaging started: NO
V0.8.11 started: NO
```

PENDING INDEPENDENT AUDIT
