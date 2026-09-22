-- 0003_enable_rls.sql
-- Row level security for the public Data API.
--
-- web/src/lib/supabase.ts has claimed since day one that every table sits
-- behind RLS with a public SELECT policy and no INSERT policy. Until this
-- migration that was a description of intent, not implementation: 0001 created
-- the tables and never enabled RLS or wrote a single policy.
--
-- It matters because the anon key ships to every browser the moment the
-- frontend deploys. Anything that key can do, anyone can do. Read-only is the
-- entire requirement.
--
-- Ingestion is unaffected. It connects as the table owner over DATABASE_URL,
-- and an owner bypasses RLS unless FORCE ROW LEVEL SECURITY is set. The
-- append-only guarantee stays exactly where it already lives: in db.py, which
-- never issues an UPDATE or DELETE against price_observations.

-- Supabase provisions anon and authenticated; a plain Postgres (the one CI
-- runs the write-path tests against) does not. Creating them when absent keeps
-- this migration runnable anywhere, and is a no-op on Supabase.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
    END IF;
END
$$;

ALTER TABLE retailers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores             ENABLE ROW LEVEL SECURITY;
ALTER TABLE products           ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_observations ENABLE ROW LEVEL SECURITY;

-- A table with RLS enabled and no policy denies everything, so each one needs
-- an explicit read policy. FOR SELECT only: there is deliberately no INSERT,
-- UPDATE or DELETE policy anywhere in this file. Adding one later is the only
-- way the anon key could ever write, which makes that an obvious thing to
-- refuse in review rather than an accident.
CREATE POLICY "public read" ON retailers
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "public read" ON stores
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "public read" ON products
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "public read" ON price_observations
    FOR SELECT TO anon, authenticated USING (true);

-- Privileges are the second lock, and both have to allow an operation for it
-- to succeed: RLS decides which rows, GRANT decides which verbs. REVOKE first
-- so the result does not depend on whatever the project was created with.
DO $$
BEGIN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon, authenticated', current_schema());
END
$$;

REVOKE ALL ON retailers, stores, products, price_observations
    FROM anon, authenticated;

GRANT SELECT ON retailers, stores, products, price_observations
    TO anon, authenticated;
