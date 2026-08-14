-- Add user-level UI preferences (e.g. sidebar feature toggles) to profiles.
ALTER TABLE "profiles" ADD COLUMN "preferences" JSONB NOT NULL DEFAULT '{}';
