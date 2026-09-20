# AgentHub Backend 0.7.3C Migration

0.7.3B is historical. This release does not move `0.7.2E`, `0.7.3`, `0.7.3A`, or `0.7.3B`.

No SQL schema migration is required. Lifecycle JSON remains `schemaVersion: 1`.

Online `createPlan()` now enforces the same Lead equality restore already required:

```text
input.leadAgentId == intake.leadAgentId
```

Valid 0.7.3B snapshots continue to restore. A snapshot that already stored a Plan Lead different from its Intake Lead remains rejected as corrupt. The write path does not auto-repair historical mismatch.
