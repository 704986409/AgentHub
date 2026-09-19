# AgentHub Backend 0.7.3A Lifecycle Orchestration Contract

0.7.3A closes the unsealed 0.7.3 lifecycle gaps. Backend remains the sole lifecycle authority; Desktop consumes snapshots and sends explicit human intent.

## Public contract

- `POST /api/v1/intakes` creates a lead-owned human intake.
- `POST /api/v1/plans` creates immutable version 1. Every task requires `clientId`, parent reference, title/description, acceptance criteria, capabilities, specialties, `complexity`, and `risk`.
- `POST /api/v1/plans/:planId/revisions` creates the next immutable version only from `CHANGES_REQUESTED` and the exact current version.
- Approval routes require `planVersion`, `proposalHash`, `actorId`, and `summary`. Backend creates and persists a distinct `decisionId`.
- `POST /api/v1/plans/:planId/start` requires the exact approved version/hash. It materializes one real Task per PlanTask, persists links, computes eligibility, and invokes AgentScheduler → AssignmentDispatcher → TaskLifecycleOrchestrator for eligible work.
- Existing review decisions notify the Plan coordinator. Authoritative completion unlocks dependents and triggers follow-up dispatch.
- `/api/v1/state` exposes intakes, plans with decisions/aggregate, runtime-projected planTasks, and planDependencies.

All request DTOs reject unknown keys, malformed nested arrays, NUL, invalid versions, invalid complexity/risk, and excess bounds. All mutations retain existing Idempotency-Key behavior.

## Invariants

Proposal hashes cover version, Lead, summary, immutable task definitions, parent links, complexity/risk, requirements, and dependency edges; runtime links are excluded. Parent and dependency references must exist and be acyclic; duplicate/self dependency edges fail closed.

`REQUEST_CHANGES` forbids further decisions on that version. A revision creates version N+1 and returns to `WAITING_APPROVAL`. Review `REQUEST_REVISION` remains within the existing Task lifecycle and never creates a Plan version.

Dependencies are Backend computed. A node is blocked until all prerequisite runtime Tasks are authoritatively `COMPLETED` and have no pending review. Failed prerequisites never unlock dependents. `blockedBy` order is stable by PlanTask ID.

PlanTask projection links `planTaskId → runtimeTaskId → assignmentId → agentId`. Aggregate counts are computed from runtime Task/Assignment state. Plan reaches `COMPLETED` only when every linked runtime Task is authoritatively complete and no review remains pending; terminal task failure produces Plan `FAILED`.

## Persistence

The `public_lifecycle_snapshot` value uses `schemaVersion: 1`. Load validates references, versions, states, proposal hashes, graphs, decisions, unique runtime mappings, and runtime Task existence. Derived eligibility, blocked lists, runtime state, aggregate, and canonical Plan state are recomputed. Any malformed or semantically invalid snapshot is ignored as a whole and emits only a safe diagnostic.

