# AgentHub Backend 0.7.3B Migration

0.7.3A is historical. This release does not move `0.7.2E`, `0.7.3`, or `0.7.3A`.

## SQL

Migration `6` / `plan_task_materialization_identity` adds nullable Task origin columns and `plan_task_materializations`.

Valid 0.7.3A data is preserved. Unambiguous `runtimeLinks` are derived into materialization rows and Task origin identity on restore without rematerializing or changing `runtimeTaskId`. Ambiguous old mappings fail closed. The migration is idempotent and does not wipe lifecycle snapshots.

Lifecycle JSON remains `schemaVersion: 1`. Standalone Tasks keep null origin columns.

## Restore

Intake and Plan authority relationships are revalidated before a snapshot becomes Backend truth. A missing project, missing lead, or forged project/lead/intake/plan relationship rejects the lifecycle snapshot as a whole and emits only a safe diagnostic.
