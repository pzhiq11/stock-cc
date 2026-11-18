-- CreateTable
CREATE TABLE "AppSetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "lastStock" TEXT NOT NULL DEFAULT '002281.SZ',
    "prefs" JSONB NOT NULL DEFAULT '{}',
    "llm" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Watchlist" (
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Watchlist_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "DailySignal" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "tradeDate" TEXT NOT NULL,
    "highPoints" JSONB NOT NULL DEFAULT '[]',
    "lowPoints" JSONB NOT NULL DEFAULT '[]',
    "strategy" JSONB NOT NULL DEFAULT '{}',
    "coverage" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DailySignal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DailySignal_high_quota" CHECK (CASE WHEN jsonb_typeof("highPoints") = 'array' THEN jsonb_array_length("highPoints") <= 3 ELSE false END),
    CONSTRAINT "DailySignal_low_quota" CHECK (CASE WHEN jsonb_typeof("lowPoints") = 'array' THEN jsonb_array_length("lowPoints") <= 3 ELSE false END)
);

-- CreateTable
CREATE TABLE "AnalysisReport" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "tradeDate" TEXT NOT NULL,
    "targetDate" TEXT,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "inputSummary" JSONB NOT NULL DEFAULT '{}',
    "evaluation" JSONB,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailySignal_tradeDate_idx" ON "DailySignal"("tradeDate");

-- CreateIndex
CREATE UNIQUE INDEX "DailySignal_symbol_tradeDate_key" ON "DailySignal"("symbol", "tradeDate");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisReport_idempotencyKey_key" ON "AnalysisReport"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisReport_symbol_tradeDate_type_version_key" ON "AnalysisReport"("symbol", "tradeDate", "type", "version");

-- CreateIndex
CREATE INDEX "AnalysisReport_createdAt_idx" ON "AnalysisReport"("createdAt");
