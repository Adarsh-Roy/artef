-- `GET /assets/:sha` is unauthenticated by design (§5.4): the request comes from
-- a frame sandboxed without `allow-same-origin`, which sends no cookies, so the
-- route has no workspace to narrow the lookup with and matches on the hash
-- alone. The primary key is (workspace_id, sha256), and a btree cannot serve a
-- predicate on its second column, so that lookup was scanning the whole table —
-- once per image, on every artifact view, forever. The composite key stays as it
-- is: it is what makes dedup per-workspace and keeps a deleted workspace from
-- taking another workspace's assets with it (§3).
CREATE INDEX "assets_sha256_idx" ON "assets" USING btree ("sha256");
