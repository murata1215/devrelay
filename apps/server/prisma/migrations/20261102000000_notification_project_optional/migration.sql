-- 2026-11-02: iPhone SE3 FCM 無音故障の再発防止サイクル。
-- トークン削除・配信先0件スキップ時の Notification（type='error'）は特定の
-- Project に紐づかないため、projectId を必須から任意に変更する。
ALTER TABLE "Notification" ALTER COLUMN "projectId" DROP NOT NULL;
