-- 请求状态与短期租约复用日记录，不增加业务表，不改动已有点位。
ALTER TABLE "DailySignal" ADD COLUMN "runtime" JSONB NOT NULL DEFAULT '{}';
