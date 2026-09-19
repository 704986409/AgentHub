# AgentHub Backend 0.7.3 Lifecycle Public Contract

## Entities and authority

`Intake` records a human request and its authoritative `leadAgentId`. `Plan` owns immutable `PlanVersion` proposals. Each version contains durable `PlanTask` nodes and directed dependency edges. `Task` and `Assignment` remain runtime entities and may be linked to a plan task without changing standalone-task compatibility. The Backend owns every lifecycle transition; a human actor supplies approval decisions and an AgentHub Agent supplies lead identity.

## Public routes

- `POST /api/v1/intakes` — `{ projectId, createdBy, goal, leadAgentId }` → `IntakeDto`.
- `GET /api/v1/intakes` — current intake snapshot.
- `POST /api/v1/plans` — `{ intakeId, leadAgentId, summary, tasks[{clientId,parentClientId,title,description,acceptanceCriteria,requiredCapabilities,requiredSpecialties}], dependencies[{prerequisiteClientId,dependentClientId}] }` → `PlanDto` version 1 in `WAITING_APPROVAL`.
- `GET /api/v1/plans` and `GET /api/v1/plans/:planId` — current plan/version/aggregate snapshot.
- `POST /api/v1/plans/:planId/approve`, `/request-changes`, `/reject` — `{ planVersion, actorId, summary }`, bound to the exact version.
- `POST /api/v1/plans/:planId/start` — `{ planVersion }`; only an approved exact version may enter `EXECUTING`.
- `GET /api/v1/state` now includes `intakes`, `plans`, `planTasks`, and `planDependencies` in addition to the 0.7.2E fields.

All mutations require the existing `Idempotency-Key`. The existing idempotency store rejects same-key/different-body reuse and safely replays the original result. Approval with a stale version returns conflict; it never applies to the latest version silently.

## States and invariants

Plan states are explicit and are never encoded in `TaskStatus`: `DRAFT`, `WAITING_APPROVAL`, `APPROVED`, `CHANGES_REQUESTED`, `REJECTED`, `CANCELLED`, `EXECUTING`, `REVIEWING`, `COMPLETED`, `FAILED`. A plan version is immutable and identified by `(planId, version, proposalHash)`. The service rejects unknown lead agents, missing projects, duplicate/self edges, unknown nodes, and cyclic dependency graphs. Dispatch/start is denied until the exact version is approved. `REQUEST_CHANGES` records a plan revision requirement and is not execution retry or review revision.

`PlanAggregateDto` is Backend-computed and exposes total, pending, blocked, eligible, running, reviewing, completed, failed, and canonical plan state. A client never derives lifecycle completion by counting children.

## Snapshot and events

`GET /api/v1/state` is sufficient to rebuild current lifecycle projection after reconnect. Durable lifecycle mutations publish safe public events (`IntakeCreated`, `PlanProposed`, `PlanApprovalDecision`, `PlanStarted`) through the existing realtime channel. Payloads contain IDs and public summaries only; runtime paths, commands, environments, session IDs, hashes of private profiles, and secrets are not exposed.

## Compatibility and persistence

Standalone task creation/execution/review, Agent management, provider catalog, and existing event envelopes remain compatible. The existing bounded `settings` table stores a lifecycle snapshot; existing 0.7.2E tasks remain standalone and are not fabricated into plans. Lifecycle snapshots are restored by the Backend on restart.

