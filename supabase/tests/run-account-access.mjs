// In-memory PostgreSQL only; never reads environment credentials or contacts Auth.
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(path.resolve(process.argv[2] ?? 'node_modules'), '.account-access-qa.cjs'));
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const db = new PGlite({ extensions: { pgcrypto } });
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
    create publication supabase_realtime;
    create table auth.users(id uuid primary key,raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
  const migrations = path.join(directory,'..','migrations');
  for (const name of (await readdir(migrations)).filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0,4)) <= 23).sort()) {
    await db.exec(await readFile(path.join(migrations,name),'utf8'));
    console.log(`PASS ${name}`);
  }
  await db.exec(await readFile(path.join(directory,'account_access.sql'),'utf8'));
  console.log('PASS account-access private ACLs, hashes, rate limits, transfer races, shared allocation privacy and actual account deletion');
  console.log('NOT TESTED: live Auth identity linking/OTP, simultaneous DB connections, or device SecureStore');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  if (error.where) console.error(error.where);
  if (error.position) console.error(`SQL position ${error.position}`);
  process.exitCode = 1;
} finally { await db.close(); }
