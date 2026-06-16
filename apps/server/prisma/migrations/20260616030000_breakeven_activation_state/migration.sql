-- Track when a breakeven stop first activates so the UI can show that the stop is locked.
ALTER TABLE "StopLossRule" ADD COLUMN "breakevenActivatedAt" DATETIME;
ALTER TABLE "StopLossRule" ADD COLUMN "breakevenActivatedPrice" REAL;
