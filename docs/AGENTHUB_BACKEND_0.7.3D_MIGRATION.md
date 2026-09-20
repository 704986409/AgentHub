# AgentHub Backend 0.7.3D Migration

0.7.3C is historical. This release does not move `0.7.2E`, `0.7.3`, `0.7.3A`, `0.7.3B`, or `0.7.3C`.

No SQL schema migration is required. Lifecycle JSON remains `schemaVersion: 1`.

Public Agent delete now refuses any Agent still referenced as Intake Lead or Plan Lead. Valid 0.7.3C snapshots continue to restore. A snapshot that already points at a missing Lead remains rejected as corrupt. Restore is not auto-repaired.
