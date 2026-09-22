# AgentHub Backend 0.7.4C Completion Report

Implementation is complete for the 0.7.4C authoritative project bootstrap API. The release remains **PENDING INDEPENDENT AUDIT**. Historical tags `0.7.4`, `0.7.4A`, and `0.7.4B` were not moved.

```text
Production SHA
48a00e615322463b400dda0ec1dad4abfc8513e1

Docs/Main SHA
this docs-only commit (annotated tag 0.7.4C peels to it)

Annotated Tag Object SHA
recorded in the annotated tag after this commit

Tag Peeled SHA
this docs-only commit

CI Run ID
35705095356
url: https://github.com/704986409/AgentHub/actions/runs/35705095356

CI Head SHA
48a00e615322463b400dda0ec1dad4abfc8513e1

CI conclusion
not awaited
status at lookup: in_progress
event: push

POST /api/v1/projects added: YES
Project ID Backend-generated: YES
Strict input snapshot: YES
Idempotency enforced: YES
Replay creates duplicate: NO
Migration added: NO
Startup auto-project added: NO

Revision/Recovery changed: NO
Scheduler changed: NO
Dispatcher changed: NO
AgentPool changed: NO
Desktop changed in this Backend phase: NO

Create PASS
Replay PASS
Conflict PASS
Validation PASS
/state projection PASS
Restart persistence PASS
Full CI: not awaited
```

---

## 1. Production change

`POST /api/v1/projects` validates `{ name, description }` with `snapshotCreateProject`, then creates the row through the existing `ProjectRepository` inside `#mutate`. The repository generates `id` with `randomUUID`. The response is the existing `projectDto`. Unknown fields, including client-supplied identity and path fields, are rejected.

No migration was added. The existing `projects` table has no `UNIQUE(name)` and no repository path column. Startup does not create a project when the table is empty.

## 2. Local verification

```text
tests/project-bootstrap-0.7.4C.test.ts  PASS (B-T1..B-T7)
npm run typecheck                       PASS
npm run build                           PASS
npm run lint                            PASS
npm test                                not run locally; left to CI
```

## 3. Final

```text
PENDING INDEPENDENT AUDIT
```
