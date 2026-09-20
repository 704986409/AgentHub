# AgentHub Backend 0.7.3D Lifecycle Contract

0.7.3D is a narrow Agent-delete authority closure on 0.7.3C. Restore validation is unchanged.

## Lead reference integrity

A hard-deleted Agent must never remain referenced by durable lifecycle authority.

```text
If Intake.leadAgentId == A OR Plan.leadAgentId == A
then DELETE A is denied.
```

`PlanLifecycleService.isLeadReferenced(agentId)` is the only read used by Agent Management. `AgentManagementService.deleteAgent()` checks that query after runtime, assignment-history, and Task-reference guards, and before pool unregister, registry delete, or `AGENT_DELETED`.

Denied delete is `AGENT_DELETE_LIFECYCLE_REFERENCE_CONFLICT` / HTTP `409` `AGENTHUB_API_CONFLICT`. The Agent, pool registration, Intake, and Plan remain. No cascade delete. No Lead reassignment.

An unreferenced, runtime-clean Agent with no assignment history and no Task reference remains deletable.

Every Plan state is a live reference until a later archival contract exists.

## Preserved contracts

`createPlan()` still requires `Plan.leadAgentId == Intake.leadAgentId`. Restore still fail-closes a missing Lead. Suspended Task states, materialization uniqueness, review gate, START concurrency, and HTTP DTO strictness are unchanged.

`/api/v1/health` reports `0.7.3D`.
