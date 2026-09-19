# AgentHub Backend 0.7.3A Migration

0.7.3 was not sealed. 0.7.3A corrects its public lifecycle input and orchestration contract without moving the historical `0.7.3` tag.

No SQL schema migration is required. The existing `settings` table stores `public_lifecycle_snapshot` with `schemaVersion: 1`. 0.7.3A requires Plan task `complexity` and `risk`, adds immutable decision identity and revision history, and validates the entire stored snapshot before restoration. Invalid 0.7.3 lifecycle JSON is ignored fail-closed; standalone Projects, Agents, Tasks, Assignments, events, sessions, and provider runtime state remain intact.

Existing standalone Task/Review/Agent/Provider APIs remain compatible. Historical standalone Tasks are not assigned synthetic Plans. Runtime links restored from lifecycle storage must point to real Tasks; missing or duplicate links invalidate the lifecycle snapshot.
