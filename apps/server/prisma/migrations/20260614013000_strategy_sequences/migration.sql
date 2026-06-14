-- CreateTable
CREATE TABLE "StrategySequence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketId" TEXT NOT NULL,
    "conditionId" TEXT,
    "tokenId" TEXT NOT NULL,
    "outcomeName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "activationCondition" TEXT NOT NULL DEFAULT 'PARENT_FULL_FILL',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_StopLossRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleType" TEXT NOT NULL DEFAULT 'STOP_LOSS',
    "strategySequenceId" TEXT,
    "parentRuleId" TEXT,
    "activationCondition" TEXT,
    "marketId" TEXT NOT NULL,
    "conditionId" TEXT,
    "tokenId" TEXT NOT NULL,
    "outcomeName" TEXT NOT NULL,
    "currentPrice" REAL,
    "lastEvaluatedPrice" REAL,
    "lastUpdatedAt" DATETIME,
    "stopPercentage" REAL,
    "sideCurrentlyHeld" TEXT NOT NULL,
    "positionSize" REAL NOT NULL,
    "entryPrice" REAL NOT NULL,
    "stopPrice" REAL NOT NULL,
    "hardStopPrice" REAL,
    "softStopPrice" REAL,
    "useOfiConfirmationForSoftStop" BOOLEAN NOT NULL DEFAULT true,
    "useOfiConfirmationForHardStop" BOOLEAN NOT NULL DEFAULT false,
    "highestPriceSinceEntry" REAL,
    "trailingPercentage" REAL,
    "referencePrice" REAL,
    "breakoutPercentage" REAL,
    "breakoutPrice" REAL,
    "breakoutReferenceSource" TEXT,
    "breakoutSizeUsd" REAL,
    "useOfiConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "ofiBuyThreshold" REAL,
    "usePriceSlopeConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "priceSlopeThreshold" REAL,
    "maxSpread" REAL,
    "breakevenEnabled" BOOLEAN NOT NULL DEFAULT false,
    "breakevenTriggerPrice" REAL,
    "breakevenBuffer" REAL NOT NULL DEFAULT 0,
    "takeProfitPrice" REAL,
    "triggeredPrice" REAL,
    "orderSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "orderId" TEXT,
    "filledShareAmount" REAL,
    "averageFillPrice" REAL,
    "activatedAt" DATETIME,
    "filledAt" DATETIME,
    "cancelledAt" DATETIME,
    "triggerType" TEXT NOT NULL,
    "executionType" TEXT NOT NULL,
    "slippageLimit" REAL NOT NULL,
    "maxSellSize" REAL NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "triggeredAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'ENABLED',
    "positionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StopLossRule_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StopLossRule_strategySequenceId_fkey" FOREIGN KEY ("strategySequenceId") REFERENCES "StrategySequence" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "StopLossRule_parentRuleId_fkey" FOREIGN KEY ("parentRuleId") REFERENCES "StopLossRule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_StopLossRule" ("breakevenBuffer", "breakevenEnabled", "breakevenTriggerPrice", "breakoutPercentage", "breakoutPrice", "breakoutReferenceSource", "breakoutSizeUsd", "conditionId", "createdAt", "currentPrice", "enabled", "entryPrice", "executionType", "hardStopPrice", "highestPriceSinceEntry", "id", "lastEvaluatedPrice", "lastUpdatedAt", "marketId", "maxSellSize", "maxSpread", "ofiBuyThreshold", "orderId", "orderSubmitted", "outcomeName", "positionId", "positionSize", "priceSlopeThreshold", "referencePrice", "ruleType", "sideCurrentlyHeld", "slippageLimit", "softStopPrice", "status", "stopPercentage", "stopPrice", "takeProfitPrice", "tokenId", "trailingPercentage", "triggerType", "triggeredAt", "triggeredPrice", "updatedAt", "useOfiConfirmation", "useOfiConfirmationForHardStop", "useOfiConfirmationForSoftStop", "usePriceSlopeConfirmation")
SELECT "breakevenBuffer", "breakevenEnabled", "breakevenTriggerPrice", "breakoutPercentage", "breakoutPrice", "breakoutReferenceSource", "breakoutSizeUsd", "conditionId", "createdAt", "currentPrice", "enabled", "entryPrice", "executionType", "hardStopPrice", "highestPriceSinceEntry", "id", "lastEvaluatedPrice", "lastUpdatedAt", "marketId", "maxSellSize", "maxSpread", "ofiBuyThreshold", "orderId", "orderSubmitted", "outcomeName", "positionId", "positionSize", "priceSlopeThreshold", "referencePrice", "ruleType", "sideCurrentlyHeld", "slippageLimit", "softStopPrice", "status", "stopPercentage", "stopPrice", "takeProfitPrice", "tokenId", "trailingPercentage", "triggerType", "triggeredAt", "triggeredPrice", "updatedAt", "useOfiConfirmation", "useOfiConfirmationForHardStop", "useOfiConfirmationForSoftStop", "usePriceSlopeConfirmation" FROM "StopLossRule";
DROP TABLE "StopLossRule";
ALTER TABLE "new_StopLossRule" RENAME TO "StopLossRule";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

CREATE INDEX "StrategySequence_marketId_idx" ON "StrategySequence"("marketId");
CREATE INDEX "StrategySequence_status_idx" ON "StrategySequence"("status");
CREATE INDEX "StopLossRule_tokenId_idx" ON "StopLossRule"("tokenId");
CREATE INDEX "StopLossRule_status_idx" ON "StopLossRule"("status");
CREATE INDEX "StopLossRule_strategySequenceId_idx" ON "StopLossRule"("strategySequenceId");
CREATE INDEX "StopLossRule_parentRuleId_idx" ON "StopLossRule"("parentRuleId");
