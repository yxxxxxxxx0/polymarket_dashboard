-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketId" TEXT NOT NULL,
    "conditionId" TEXT,
    "tokenId" TEXT NOT NULL,
    "outcomeName" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "size" REAL NOT NULL,
    "entryPrice" REAL NOT NULL,
    "currentPrice" REAL,
    "tradeMode" TEXT NOT NULL DEFAULT 'PAPER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OpenOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "exchangeOrderId" TEXT,
    "marketId" TEXT NOT NULL,
    "conditionId" TEXT,
    "tokenId" TEXT NOT NULL,
    "outcomeName" TEXT,
    "side" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "size" REAL NOT NULL,
    "remainingSize" REAL NOT NULL,
    "tradeMode" TEXT NOT NULL DEFAULT 'PAPER',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StopLossRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketId" TEXT NOT NULL,
    "conditionId" TEXT,
    "tokenId" TEXT NOT NULL,
    "outcomeName" TEXT NOT NULL,
    "currentPrice" REAL,
    "stopPercentage" REAL,
    "sideCurrentlyHeld" TEXT NOT NULL,
    "positionSize" REAL NOT NULL,
    "entryPrice" REAL NOT NULL,
    "stopPrice" REAL NOT NULL,
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
    CONSTRAINT "StopLossRule_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StopLossTriggerLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleId" TEXT NOT NULL,
    "attemptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "referencePrice" REAL,
    "executablePrice" REAL,
    "size" REAL,
    "tradeMode" TEXT NOT NULL DEFAULT 'PAPER',
    "success" BOOLEAN NOT NULL,
    "message" TEXT NOT NULL,
    "rawResponse" TEXT,
    CONSTRAINT "StopLossTriggerLog_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "StopLossRule" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TradeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketId" TEXT NOT NULL,
    "conditionId" TEXT,
    "tokenId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "size" REAL NOT NULL,
    "tradeMode" TEXT NOT NULL DEFAULT 'PAPER',
    "source" TEXT NOT NULL,
    "exchangeOrderId" TEXT,
    "rawResponse" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Position_marketId_idx" ON "Position"("marketId");

-- CreateIndex
CREATE INDEX "Position_tokenId_idx" ON "Position"("tokenId");

-- CreateIndex
CREATE INDEX "OpenOrder_marketId_idx" ON "OpenOrder"("marketId");

-- CreateIndex
CREATE INDEX "OpenOrder_tokenId_idx" ON "OpenOrder"("tokenId");

-- CreateIndex
CREATE INDEX "StopLossRule_tokenId_idx" ON "StopLossRule"("tokenId");

-- CreateIndex
CREATE INDEX "StopLossRule_status_idx" ON "StopLossRule"("status");

-- CreateIndex
CREATE INDEX "StopLossTriggerLog_ruleId_idx" ON "StopLossTriggerLog"("ruleId");

-- CreateIndex
CREATE INDEX "TradeLog_marketId_idx" ON "TradeLog"("marketId");

-- CreateIndex
CREATE INDEX "TradeLog_tokenId_idx" ON "TradeLog"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "AppSetting_key_key" ON "AppSetting"("key");
