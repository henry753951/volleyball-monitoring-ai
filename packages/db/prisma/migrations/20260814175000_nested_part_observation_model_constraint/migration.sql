-- Nested Part observations carry a versioned descriptor recipe plus four
-- independently checksummed modalities; the legacy single-512D-model check no
-- longer describes this row.
ALTER TABLE "ReidFeatureObservation"
  DROP CONSTRAINT "ReidFeatureObservation_model_check";
