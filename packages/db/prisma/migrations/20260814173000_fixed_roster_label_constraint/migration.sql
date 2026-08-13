-- Fixed roster identities are team-stable slots.  Physical L/R is resolved from
-- the observation's court side and must not be persisted in the slot label.
ALTER TABLE "ReidIdentity"
  DROP CONSTRAINT "ReidIdentity_label_check";

ALTER TABLE "ReidIdentity"
  ADD CONSTRAINT "ReidIdentity_label_check" CHECK ("label" ~ '^S[1-6]$');
