# AgentHub Backend 0.7.4 Completion Report

Implementation is complete for the 0.7.4 Revision Recovery State Machine. The release remains **PENDING INDEPENDENT AUDIT**. 0.7.3L, 0.7.3M, 0.7.3N, and 0.7.3O remain **NOT SEALED**. 0.7.3K remains Historical SEALED and was not moved.

```text
AgentHub Backend 0.7.4
PENDING INDEPENDENT AUDIT

Base (0.7.3O docs/main):
d183a1631f28c27a9dd073d03ca39239dd3330db

Production:
81dbf02a32c729b51fb6487bbe56d2c46261456a

Docs/main:
this docs-only commit (annotated tag 0.7.4 peels to it)

Tag:
0.7.4

Tag object:
recorded in the annotated tag after this commit; exact object/peeled values are in the coding-agent completion message

Tag peeled:
this docs-only commit

Production CI:
35652678866
url: https://github.com/704986409/AgentHub/actions/runs/35652678866

event:
push

head_sha:
81dbf02a32c729b51fb6487bbe56d2c46261456a

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
src/lifecycle/plan-execution-coordinator.ts
src/lifecycle/plan-execution-recovery.ts
src/lifecycle/plan-recovery-coordinator.ts
src/lifecycle/revision-recovery-state.ts (NEW)
src/orchestration/TaskLifecycleOrchestrator.ts
src/orchestration/lifecycle/RuntimeGuard.ts
src/runtime/AgentPool.ts
tests/api-v0.7.2.test.ts
tests/plan-api-0.7.3A.test.ts
tests/revision-recovery-state-machine-0.7.4.test.ts (NEW)
```

---

## 2. State Machine

`src/lifecycle/revision-recovery-state.ts` is the only decision function.

Durable stages map existing recovery strings: `INITIAL`, `TURN_STARTED`, `TURN_COMPLETED`, `REVIEW_READY`, `TERMINAL`, `RECONCILIATION_REQUIRED`. No schema migration. `TERMINAL` is stored in the existing stage TEXT column.

Runtime ownership is `ABSENT`, `OWNED`, `STARTING`, `STOPPING`, `FAILED`, or `AMBIGUOUS`. `AgentPool.inspectAssignmentOwnership` and `RuntimeGuard.inspectOwnership` both use `classifyRuntimeOwnership`. Lifecycle code does not scatter `state === 'OWNED'` checks.

`decideRevisionRecovery` returns `NOOP`, `RESUME_REVIEW_PREPARATION`, `CONVERGE_DURABLE_RESULT`, `KEEP_CURRENT_REVIEW`, `REBUILD_RUNTIME_FOR_REVISION`, or `RECONCILIATION_REQUIRED`.

---

## 3. Shared Convergence

Live revision and startup recovery both call `TaskLifecycleOrchestrator.consumeCompletedTurn` after durable `TURN_COMPLETED`.

`prepareReviewFromRecoveredDispatch` and the `recovered` boolean are removed. `TurnConsumptionContext` is `LIVE` or `DURABLE_RECOVERY` plus the inspected runtime ownership.

`consumeCompletedTurn` validates the durable identity, then `RuntimeGuard.ensureCleanAfterCompletedTurn`:

```text
ABSENT → continue
OWNED and exact → shutdown, then require ABSENT
STARTING / STOPPING / FAILED / AMBIGUOUS → TASK_LIFECYCLE_RUNTIME_RECONCILIATION_REQUIRED
```

That runtime code is classified as safety, so startup recovery does not retry it. A failed shutdown does not mark the assignment released while the pool stays owned.

After the runtime is clean, the same turn result converges:

```text
COMPLETED → review preparation → REVIEWING → REVIEW_READY
FAILED → task FAILED, assignment RELEASED, agent IDLE, stage TERMINAL
BLOCKED → task BLOCKED, stage TERMINAL
NEEDS_INPUT → task WAITING_INPUT, stage TERMINAL
```

`REVIEW_READY` with runtime `ABSENT` is accepted without requiring an owned pool, including revision round 0.

---

## 4. REQUEST_REVISION

`#ensureRevisionRuntime` runs before `retireForRevision`. Exact `OWNED` continues. `ABSENT` rebuilds the same task, assignment, agent, spec, and profile through `AgentPool.start`. Any other ownership fails with the current review unchanged, the task still `REVIEWING`, and no `TURN_STARTED` row.

Only after the runtime is exact `OWNED` does the coordinator retire the review, advance the round, persist `TURN_STARTED`, run one provider turn, persist `TURN_COMPLETED`, and consume it.

---

## 5. Tests

`npx vitest run tests/revision-recovery-state-machine-0.7.4.test.ts`

```text
T1 live revision REVIEWING → REQUEST_REVISION → TURN_COMPLETED → REVIEW_READY → ACCEPT → COMPLETED, pool clean
T2 restart at TURN_STARTED → reconciliation, no provider replay
T3 restart at TURN_COMPLETED + ABSENT for COMPLETED, FAILED, and NEEDS_INPUT
T4 TURN_COMPLETED + OWNED in-process → shutdown, then REVIEW_READY, pool clean
T5 recovered REVIEW_READY → REQUEST_REVISION on the same task, assignment, and agent
T6 restore failure keeps the review, REVIEWING, and the round, with no TURN_STARTED
```

`npm run typecheck`, `npm run build`, and `npm run lint` passed. The full `npm test` suite was not run locally.

---

## 6. Explicit Non-Changes

```text
Desktop: NO
Scheduler authority: NO
Dispatcher authority: NO
new assignment: NO
new runtime task: NO
provider replay on TURN_COMPLETED: NO
migration: NO
packaging: NO
V0.8.11: NO
```

PENDING INDEPENDENT AUDIT
