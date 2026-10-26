// Disposable in-memory PostgreSQL only; never reads production credentials.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(path.resolve(process.argv[2] ?? 'node_modules'), '.feedback-qa.cjs'));
const { PGlite } = require('@electric-sql/pglite');
const db = new PGlite();
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
  await db.exec(await readFile(path.join(directory,'../migrations/0023_feedback_reports.sql'),'utf8'));
  await db.exec(await readFile(path.join(directory,'feedback_reports.sql'),'utf8'));
  assert.equal((await db.query('select count(*)::integer as count from public.feedback_reports')).rows[0].count, 0);
  assert.equal((await db.query('select count(*)::integer as count from auth.users')).rows[0].count, 0);
  console.log('PASS feedback leases, payload identity, fixed retry sender, sent receipts, per-user hour/day limits, ACLs/RLS, expiry and deletion');
  console.log('NOT TESTED: simultaneous PostgreSQL sessions, production Auth, provider delivery');
} catch (error) {
  console.error(`FAIL feedback: ${error.message}`);
  if (error.where) console.error(error.where);
  process.exitCode=1;
} finally { await db.close(); }
