// Local, disposable PostgreSQL/WASM validation; never connects to Supabase.
// Usage: node supabase/tests/run-screen-time-grants.mjs /absolute/path/to/node_modules
// Install @electric-sql/pglite in a temporary directory, not the mobile app.
// This exercises real PostgreSQL SQL/roles/RLS, but its single connection cannot
// prove concurrent lock behavior. Run the two-session checks in the README too.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(path.resolve(process.argv[2] ?? 'node_modules'), '.grant-qa.cjs'));
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const db = new PGlite({ extensions: { pgcrypto } });
let step = 'bootstrap';
try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create schema extensions;
    create extension pgcrypto with schema extensions;
    create publication supabase_realtime;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  const migrationDirectory = path.join(testDirectory, '..', 'migrations');
  const migrations = (await readdir(migrationDirectory))
    .filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 16).sort();
  for (const name of migrations) {
    step = name;
    if (name.startsWith('0016_')) {
      // Even a permissive project default must not expose the new tables.
      await db.exec('alter default privileges in schema public grant all on tables to anon, authenticated, service_role');
    }
    await db.exec(await readFile(path.join(migrationDirectory, name), 'utf8'));
    console.log(`PASS migration ${name}`);
  }
  const originalActivation = (await db.query('select activated_at::text from public.screen_time_grant_config')).rows;
  step = 'rollback-only grant fixtures';
  await db.exec(await readFile(path.join(testDirectory, 'screen_time_grants.sql'), 'utf8'));
  const after = (await db.query(`select
    (select count(*) from auth.users)::integer as users,
    (select count(*) from public.time_requests)::integer as requests,
    (select count(*) from public.screen_time_grants)::integer as grants`)).rows[0];
  assert.deepEqual(after, { users: 0, requests: 0, grants: 0 });
  assert.deepEqual((await db.query('select activated_at::text from public.screen_time_grant_config')).rows, originalActivation);
  console.log('PASS grant ownership, expiry, replay, overlap, status, ACLs, RLS, and complete fixture rollback');
  console.log('NOT TESTED: concurrent connections, Supabase production, Apple entitlements, or device re-blocking');
} catch (error) {
  console.error(`FAIL ${step}: ${error.message}`);
  if (error.detail) console.error(error.detail);
  if (error.where) console.error(error.where);
  process.exitCode = 1;
} finally {
  await db.close();
}
