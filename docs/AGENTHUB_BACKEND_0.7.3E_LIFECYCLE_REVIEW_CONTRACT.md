# AgentHub Backend 0.7.3E Lifecycle Review Projection Contract

0.7.3E is a narrow public Review identity closure on 0.7.3D. Historical tag `0.7.3D` must not move.

`/api/v1/health` reports `0.7.3E`.

## Public read

```http
GET /api/v1/reviews
```

Returns currently valid, Human-actionable **lifecycle-linked** reviews as `LifecycleReviewDto[]`.

```ts
interface LifecycleReviewDto {
  planId: string;
  planVersion: number;
  planTaskId: string;
  runtimeTaskId: string;
  assignmentId: string;
  agentId: string;
  review: ExecuteReviewReadyDto;
}
```

`review.reviewHandle` is the existing ReviewHandleStore handle (`reviewBundleSha256`). Nested `review` reuses the existing public `ExecuteReviewReadyDto`.

## Authority

- `/state` continues to publish PlanTask runtime projection, including `REVIEWING`.
- `/reviews` is the authoritative Review identity + evidence read model.
- Complete Review Evidence is not stuffed into `/state`.
- Standalone Task execute reviews remain on `POST /api/v1/tasks/:id/execute` and are not inferred by Desktop from `/reviews`.
- Expired, accepted, or unmapped handles are omitted.
- `REQUEST_REVISION` expires the old handle and registers the new bundle.
- `BLOCK` / terminal outcomes expire the handle unless `merge-denied`.
- Stale or forged PlanTask ↔ runtimeTask ↔ bundle mapping is fail-closed and omitted.

## Durability

ReviewHandleStore persists active bundles in settings key `public_review_handle_snapshot`. Backend restart restores active handles. Expired handles are not resurrected.

## Non-goals

0.7.3E does not change Plan intake/approval/start authority, mutation idempotency, or standalone execute/review-decision transport.
