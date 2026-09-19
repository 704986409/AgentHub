# AgentHub Backend 0.7.3 Migration

The existing validated `settings(key, value, updated_at)` table stores a `public_lifecycle_snapshot` after the sealed 0.7.2E schema; no schema migration is required. Existing projects, Agents, Tasks, Assignments, events, and Codex sessions are unchanged. Existing Tasks remain standalone and are never assigned a synthetic Plan.

The lifecycle service persists current Intake and Plan snapshots as validated JSON owned by Backend. On restart the service restores only that snapshot; malformed lifecycle storage is ignored and does not become frontend truth. Existing API clients continue to use the prior Task, Review, Agent, and Provider routes without lifecycle fields.

Rollback requires the normal database backup/restore procedure. The migration is forward-only and does not move or rewrite the historical `0.7.2E` tag.
