# AgentHub Backend 0.7.3O Completion Report

Implementation is complete for the 0.7.3O Recovered Review Re-Revision and Durable Non-Completed Outcome fix. The release remains **PENDING INDEPENDENT AUDIT**. 0.7.3L, 0.7.3M, and 0.7.3N remain **NOT SEALED**.

```text
AgentHub Backend 0.7.3O
PENDING INDEPENDENT AUDIT

Base (0.7.3N docs/main):
85e8c66ca83d878a1eb23574e8c03ac528f2ca53

Production:
0d79df858c6dd7b07f7085817b7fb9b2988e8902

Docs/main:
this docs-only commit (annotated tag 0.7.3O peels to it)

Tag:
0.7.3O

Tag object:
recorded in the annotated tag after this commit; exact object/peeled values are in the coding-agent completion message

Tag peeled:
this docs-only commit

Production CI:
35648589533
url: https://github.com/704986409/AgentHub/actions/runs/35648589533

event:
push

head_sha:
0d79df858c6dd7b07f7085817b7fb9b2988e8902

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
src/orchestration/TaskLifecycleOrchestrator.ts
src/runtime/AgentPool.ts
tests/api-v0.7.2.test.ts
tests/plan-api-0.7.3A.test.ts
tests/plan-review-revision-recovery-0.7.3O.test.ts (NEW)
```

---

## 2. Recovered Review REQUEST_REVISION

`#revise()` now establishes same-assignment runtime ownership before retiring the current Review:

```text
validate Review / Task / Assignment / Agent / profile / workspace
→ if AgentPool is already OWNED for this assignment, keep it
→ otherwise AgentPool.start for the same task, assignment, agent, spec, and profile
→ only after that ownership check succeeds:
   retire Review, advance round, persistRevisionDispatch, REVISION_REQUIRED, IMPLEMENTING, provider turn
```

`AgentPool.start` accepts the existing workspace path so the same provider session can be rebuilt. It does not call the Scheduler, create an Assignment, or create a Task.

If the agent is disabled, the profile no longer matches, the workspace changed, the assignment is not ACTIVE, the task is not REVIEWING, or the provider runtime cannot start, the request fails before `retireForRevision`. The current Review stays active, the task stays `REVIEWING`, and recovery does not enter `TURN_STARTED`.

---

## 3. Durable Non-Completed Outcomes

`prepareReviewFromRecoveredDispatch` still requires the durable `TURN_COMPLETED` identity. It then converges the stored `turnResult` without calling Provider code:

```text
COMPLETED → review preparation → REVIEWING → REVIEW_READY
FAILED → finalizeFailed
BLOCKED → suspend BLOCKED
NEEDS_INPUT → suspend WAITING_INPUT
protocol-invalid → existing invalid-turn convergence (BLOCKED)
```

On this recovered path, missing old runtime ownership is not treated as a shutdown failure. A live same-process turn still shuts down through `RuntimeGuard`.

---

## 4. Targeted Test Results

`tests/plan-review-revision-recovery-0.7.3O.test.ts`

```text
Test Files  1 passed
Tests       3 passed
```

1. Recovered second Review can `REQUEST_REVISION` again. Third Review differs, task / assignment / agent stay the same, and the new provider turn runs once. PASS
2. When the restarted pool cannot own the same agent, `REQUEST_REVISION` fails. The current Review stays active, the task stays `REVIEWING`, `revision_round` stays 2, and the stage does not become `TURN_STARTED`. PASS
3. Durable `FAILED` and `NEEDS_INPUT` converge after a full restart with no additional provider turn, no new task, and no new assignment. The old Review stays expired. PASS

Local `npm run typecheck`: PASS
Local `npm run build`: PASS
Local `npm run lint`: PASS

Full `npm test` was not run locally. Production CI run `35648589533` was `in_progress` when this report was written and was not awaited.

---

## 5. Explicit Scope

```text
Desktop source modified: NO
Scheduler authority modified: NO
Dispatcher authority modified: NO
New Assignment created for revision: NO
New Runtime Task created for revision: NO
Provider replay on TURN_COMPLETED recovery: NO
Database migration modified: NO
Packaging started: NO
V0.8.11 started: NO
```

PENDING INDEPENDENT AUDIT
