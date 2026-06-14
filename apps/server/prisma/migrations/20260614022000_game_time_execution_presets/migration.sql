ALTER TABLE "StopLossRule" ADD COLUMN "disableMaxSpread" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StopLossRule" ADD COLUMN "aggressivePnLProtection" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StopLossRule" ADD COLUMN "aggressiveBreakout" BOOLEAN NOT NULL DEFAULT false;
