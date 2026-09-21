# AgentHub Backend 0.7.3N Completion Report

Implementation is complete for the 0.7.3N Standalone Revision Recovery and TURN_COMPLETED Restart fix. The release remains **PENDING INDEPENDENT AUDIT**. 0.7.3L and 0.7.3M remain **NOT SEALED**.

```text
AgentHub Backend 0.7.3N
PENDING INDEPENDENT AUDIT

Base (0.7.3M docs/main):
256505ccddba51b0a7fc9c0f6532cec0c596457b

Production:
bb76a708c35a6bf8bb8e87a8e6eea3ce3f325566

Docs/main:
this docs-only commit (annotated tag 0.7.3N peels to it)

Tag:
0.7.3N

Tag object:
recorded in the annotated tag after this commit; exact object/peeled values are in the coding-agent completion message

Tag peeled:
this docs-only commit

Production CI:
35646415031
url: https://github.com/704986409/AgentHub/actions/runs/35646415031

event:
push

head_sha:
bb76a708c35a6bf8bb8e87a8e6eea3ce3f325566

status at tag time:
in_progress

conclusion:
not awaited

Database migration modified:
NO
```

---

## 1. Modified Files (Production Commit)

```text
package.json
package-lock.json
src/api/AgentHubHttpServer.ts
src/application/AgentHubApplication.ts
src/application/createLocalAgentHubApplication.ts
src/lifecycle/plan-execution-coordinator.ts
src/lifecycle/plan-execution-recovery.ts
src/orchestration/TaskLifecycleOrchestrator.ts
tests/api-v0.7.2.test.ts
tests/plan-api-0.7.3A.test.ts
tests/plan-review-revision-recovery-0.7.3N.test.ts (NEW)
```

---

## 2. Standalone Initial Dispatch Recovery Row

`POST /api/v1/tasks/:id/execute` now follows the same recovery order as plan execution when `assignmentRecovery` is present:

```text
schedule reserved
→ persistReservation(planId = null)
→ dispatcher.dispatch
→ persistDispatch
→ prepareReview
```

The row is written before `REQUEST_REVISION`. `persistRevisionDispatch` still requires that existing row and does not create a partial row, and it does not skip a missing row. A dispatch failure records `recordDispatchFailure` on the reservation row.

---

## 3. TURN_COMPLETED Review Recovery

`TURN_STARTED` with `turn_may_have_started = 1` and no active Review stays `PLAN_ASSIGNMENT_RECOVERY_REQUIRED`.

When startup sees `stage = TURN_COMPLETED`, `revision_round >= 1`, and a durable `dispatch_json`, `PlanExecutionCoordinator` calls `prepareReviewFromRecoveredDispatch`. That entry checks task `IMPLEMENTING`, assignment `ACTIVE`, identifier and profile equality, workspace identity, a readable workspace source, dispatch digest, recovery stage, exact `revision_round`, no active Review, and the stored review round. It then builds the new Review from the durable `turnResult`, moves the task to `REVIEWING`, and marks `REVIEW_READY`.

It does not call `AgentPool.start`, `AgentPool.runTurn`, `dispatcher.dispatch`, or `scheduler.scheduleTask`. A later `ACCEPT` on that `REVIEW_READY` revision does not require the previous process's `OWNED` pool. A live `OWNED` pool still uses the existing shutdown path.

---

## 4. Targeted Test Results

`tests/plan-review-revision-recovery-0.7.3N.test.ts`

```text
Test Files  1 passed (1)
Tests       2 passed (2)
```

Test 3 is included in the second test, as the fix note allows.

1. Standalone execute persists the recovery row, revision round advances to 2, the old handle is unusable, the new handle differs, task count and assignment count stay 1, and the revision provider turn runs once. ACCEPT reaches `COMPLETED` and the agent is `IDLE`. PASS
2. Full `createLocalAgentHubApplication` restart from durable `TURN_COMPLETED` restores the second Review without increasing provider `runCalls`, tasks, or assignments. The old handle stays expired. ACCEPT reaches `COMPLETED`, the review list is empty, and the agent is `IDLE`. PASS

Local `npm run typecheck`: PASS
Local `npm run build`: PASS
Local `npm run lint`: PASS

Full `npm test` was not run locally. Production CI run `35646415031` was `in_progress` when this report was written and was not awaited.

---

## 5. Explicit Scope

```text
Desktop source modified: NO
Scheduler authority modified: NO
Dispatcher authority modified: NO
New Assignment created for revision: NO
New Runtime Task created for revision: NO
Provider replay on TURN_COMPLETED recovery: NO
Packaging started: NO
V0.8.11 started: NO
```

PENDING INDEPENDENT AUDIT
