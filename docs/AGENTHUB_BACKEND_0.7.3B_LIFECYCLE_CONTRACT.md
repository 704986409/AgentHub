# AgentHub Backend 0.7.3B Lifecycle Contract

0.7.3B is a narrow reconciliation closure on 0.7.3A. Backend remains the sole lifecycle authority.

## Suspended runtime states

`PlanTaskRuntimeState` distinguishes suspended work from terminal failure:

```text
PENDING | BLOCKED | ELIGIBLE | RUNNING | REVIEWING | WAITING_INPUT | PAUSED | COMPLETED | FAILED
```

Authoritative mapping:

- `TaskStatus.BLOCKED`, `WAITING_DEPENDENCY`, and `WAITING_APPROVAL` project as `BLOCKED`
- `WAITING_INPUT` projects as `WAITING_INPUT`
- `PAUSED` projects as `PAUSED`
- `PENDING` projects as `PENDING`
- `FAILED` and `CANCELLED` remain terminal `FAILED`
- `CREATED` / `QUEUED` are `ELIGIBLE` only when the dependency gate is satisfied

Suspended states are never `FAILED` and never `ELIGIBLE`. They are not schedulable. A Plan does not become `FAILED` only because a Task is blocked, waiting, or paused.

`eligibleTasks()` requires dependency `ELIGIBLE`, a mapped runtime Task, and the Scheduler schedulability rule: `CREATED` or `QUEUED` with no `assignedAgentId` and no `assignmentId`. Scheduler behavior is unchanged.

A prerequisite in `BLOCKED`, `WAITING_INPUT`, `WAITING_DEPENDENCY`, `PAUSED`, or `REVIEWING` keeps dependents blocked. Follow-up dispatch does not auto-resume suspended work.

## Materialization identity

`(planId, planVersion, planTaskId)` maps to at most one runtime Task across retry, restart, partial persistence, and a new HTTP Idempotency-Key.

Durable identity is stored as:

- Task origin columns `origin_plan_id`, `origin_plan_version`, `origin_plan_task_id` with a partial unique index
- `plan_task_materializations` primary key `(plan_id, plan_version, plan_task_id)` and unique `runtime_task_id`

`materializeRuntimeTask` reuses a durable mapping when present, creates a Task only when none exists, and fails closed on ambiguity or a missing mapped Task. Public mapping for durable ambiguity is `AGENTHUB_API_RUNTIME_RECONCILIATION_REQUIRED` / 503.

## Persistence authority

Restore revalidates every Intake and Plan before it becomes Backend truth:

- project exists
- lead agent exists
- `lead.projectId == intake.projectId`
- `plan.projectId == intake.projectId`
- `plan.leadAgentId == intake.leadAgentId`
- `lead.projectId == plan.projectId`

Runtime links still require a unique existing Task, a boolean `reviewPending`, and agreement with materialization identity. One malformed lifecycle snapshot is rejected as a whole.

Lifecycle JSON remains `schemaVersion: 1`. HTTP routes are unchanged from 0.7.3A. `/api/v1/health` reports `0.7.3B`.
