-- Migration: init_toolchain
--
-- Purpose: prove the migration toolchain end-to-end (apply on `supabase db
-- reset`, feed `supabase gen types typescript`) WITHOUT introducing any real
-- application schema. Per ADR 0003, `supabase/migrations/*.sql` is the SOLE
-- source of DDL — no dashboard edits. Real tables (households, weeks,
-- proposals, reactions, grocery items, ...) land in their own feature slices.
--
-- This is intentionally a near no-op: it leaves a comment marker on the
-- `public` schema so the migration has an observable, idempotent effect and
-- something exists for the toolchain to round-trip on a clean reset.

comment on schema public is
  'Dinner & Groceries — application schema. DDL is managed exclusively via '
  'supabase/migrations/*.sql (ADR 0003). Toolchain bootstrap migration: '
  'init_toolchain.';
