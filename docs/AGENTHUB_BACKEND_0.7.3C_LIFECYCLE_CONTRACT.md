# AgentHub Backend 0.7.3C Lifecycle Contract

0.7.3C is a narrow write-path closure on 0.7.3B. Backend remains the sole lifecycle authority. Restore validation is unchanged.

## Lead identity

Intake owns the Lead identity for the Plan lifecycle.

```text
Plan.leadAgentId == Intake.leadAgentId
```

`createPlan()` rejects a submitted Lead that differs from the Intake Lead, including a same-project alternate Lead, before allocating durable Plan state. The mismatch is `PLAN_CONFLICT` / HTTP `409`. The submitted Lead is not rewritten to the Intake Lead.

Restore continues to reject a persisted Plan whose Lead does not equal the Intake Lead. Tampered snapshots stay fail-closed. No Lead handoff API exists in this release.

## Preserved 0.7.3B contracts

Suspended Task states remain non-terminal, non-schedulable, not `ELIGIBLE`, and not `FAILED`. Scheduler truth remains `isRuntimeTaskSchedulable`. Materialization uniqueness, persistence relationship validation, review gate, START concurrency, and HTTP DTO strictness are unchanged.

Lifecycle JSON remains `schemaVersion: 1`. `/api/v1/health` reports `0.7.3C`.
