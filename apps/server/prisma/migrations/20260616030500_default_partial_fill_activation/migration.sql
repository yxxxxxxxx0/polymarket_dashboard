-- Safer default: activate child stops after partial fill so partially filled breakouts are protected.
UPDATE "StrategySequence" SET "activationCondition" = 'PARTIAL_FILL_ALLOWED' WHERE "activationCondition" = 'PARENT_FULL_FILL';
