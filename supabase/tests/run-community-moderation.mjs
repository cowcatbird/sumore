// Disposable real PostgreSQL only: private Unix socket, no TCP or credentials.
// node supabase/tests/run-community-moderation.mjs /opt/homebrew/opt/postgresql@17/bin
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDatabaseOwnerChecks } from './community-owner-checks.mjs';

const pgBin = process.argv[2];
assert(pgBin && path.isAbsolute(pgBin), 'Provide an absolute PostgreSQL binary directory');
const ownerMode = process.argv[3];
assert([undefined, '--owner-upgrade', '--owner-path'].includes(ownerMode), 'Unknown fixture mode');
process.umask(0o077);
const directory = await mkdtemp(path.join(os.tmpdir(), 'sumore-moderation.'));
const cluster = path.join(directory, 'pg');
const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const ownerMigration = ownerMode ? await readFile(path.join(migrations, '0034_database_owner_moderation.sql'), 'utf8') : null;
const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TMPDIR: directory };
const args = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', directory, '-p', '55433', '-U', 'postgres', '-d', 'postgres'];
const active = new Set();
let started = false;
let step = 'bootstrap';
function command(executable, argv, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { env, cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
    active.add(child);
    const timeout = setTimeout(() => child.kill('SIGTERM'), 15_000);
    let output = ''; let errors = '';
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', value => { errors += value; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timeout); active.delete(child);
      if (code === 0) resolve(output.trim()); else reject(new Error(`${path.basename(executable)} exited ${code}: ${errors}`));
    });
    child.stdin.end(input);
  });
}
const sql = text => command(path.join(pgBin, 'psql'), args, text);
const lit = value => value === null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${lit(JSON.stringify(value))}::jsonb`;
const identity = actor => `set local role authenticated; set local request.jwt.claim.sub=${lit(actor.id)};`;
const rpc = async (actor, expression) => JSON.parse(await sql(`begin; ${identity(actor)} select to_jsonb(${expression}); commit;`));
const denied = (actor, expression, pattern) => assert.rejects(() => rpc(actor, expression), pattern);
const accept = actor => rpc(actor, `public.accept_community_rules('2026-10-12','${actor.id}')`);
const status = actor => rpc(actor, `public.get_my_moderation_status('${actor.id}')`);
const join = (actor, peer, suffix = '_v5') => rpc(actor, `public.join_shared_circle${suffix}(${lit(peer.code)})`);
const report = (actor, target, requestId = null, reason = 'offensive_content', details = '', clientId = randomUUID()) =>
  rpc(actor, `public.submit_circle_report('${actor.id}','${actor.group}','${target.id}',${lit(requestId)},${lit(reason)},${lit(details)},'${clientId}')`);
const review = (mod, receipt, version, action, note = '', days = null) =>
  rpc(mod, `public.review_moderation_report('${mod.id}','${receipt.reportId}',${version},${lit(action)},${lit(note)},${days ?? 'null'})`);
async function hold(actor, expression) {
  const child=spawn(path.join(pgBin,'psql'),args,{env,cwd:directory,stdio:['pipe','pipe','pipe']});
  active.add(child);
  let output=''; let errors=''; let releaseBarrier;
  const barrier=new Promise((resolve,reject)=>{
    releaseBarrier=resolve; child.on('error',reject);
    child.on('close',code=>{if(!output.includes('MODERATION_BARRIER')) reject(new Error(`Missing barrier: ${code} ${errors}`));});
  });
  child.stdout.on('data',value=>{output+=value;if(output.includes('MODERATION_BARRIER')) releaseBarrier();});
  child.stderr.on('data',value=>{errors+=value;});
  const done=new Promise((resolve,reject)=>child.on('close',code=>{
    active.delete(child);if(code===0) resolve();else reject(new Error(errors));
  }));
  const timeout=setTimeout(()=>child.kill('SIGTERM'),12_000);
  child.stdin.write(`begin; ${actor ? identity(actor) : ''} select ${expression};\n\\echo MODERATION_BARRIER\n`);
  await barrier;
  return async()=>{child.stdin.end('commit;\n');try{await done;}finally{clearTimeout(timeout);}};
}
async function waitForLock(application) {
  for(let n=0;n<80;n++) {
    if(await sql(`select exists(select 1 from pg_stat_activity where application_name=${lit(application)} and wait_event_type='Lock');`)==='t') return;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw new Error('Second independent connection did not wait on moderation lock');
}
async function user(name, accepted = false) {
  const id = randomUUID();
  await sql(`insert into auth.users(id,raw_user_meta_data) values('${id}',${json({ display_name: name, is_moderator: true })});`);
  const actor = { id, name, code: await sql(`select friend_code from public.profiles where id='${id}';`) };
  actor.group = (await rpc(actor, "public.get_circle_shop_v5('UTC')")).id;
  if (accepted) await accept(actor);
  return actor;
}
async function fixtureRows() {
  const tables = JSON.parse(await sql(`select jsonb_agg(tablename order by tablename) from pg_tables where schemaname='public';`));
  const rows = {};
  for (const table of tables) {
    assert.match(table, /^[a-z_]+$/);
    rows[table] = JSON.parse(await sql(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from public.${table} t;`));
  }
  return rows;
}
try {
  await command(path.join(pgBin, 'initdb'), ['-D', cluster, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--locale=C', '--encoding=UTF8']);
  await command(path.join(pgBin, 'pg_ctl'), ['-D', cluster, '-l', path.join(directory, 'postgres.log'), '-o',
    `-h '' -k ${directory} -p 55433 -c shared_buffers=32MB -c max_connections=12 -c log_statement=none`, '-w', 'start']);
  started = true;
  await sql(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
    create publication supabase_realtime;
    create table auth.users(id uuid primary key,raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
  for (const name of (await readdir(migrations)).filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 32).sort()) {
    step = name;
    if (name.startsWith('0016_')) await sql('alter default privileges in schema public grant all on tables to anon,authenticated,service_role;');
    await sql(await readFile(path.join(migrations, name), 'utf8'));
  }
  step = 'migration preserves all existing data and repeats safely';
  const a = await user('Scunthorpe camper'); const b = await user('Classic camper'); const c = await user('Review owner');
  await join(b, a); b.group = a.group;
  const oldGrant = await rpc(a, `public.use_panic_button('${a.id}')`);
  const before = await fixtureRows();
  const migration = await readFile(path.join(migrations, '0033_community_moderation.sql'), 'utf8');
  await sql(migration);
  if (ownerMode === '--owner-path') await sql(ownerMigration);
  const after = await fixtureRows();
  for (const [table, rows] of Object.entries(before)) assert.deepEqual(after[table], rows);
  assert.equal(await sql('select count(*) from public.community_moderators;'), '0');
  await sql(migration); if (ownerMode === '--owner-path') await sql(ownerMigration);
  assert.deepEqual(await fixtureRows(), after);
  assert.equal(await sql(`select balance from public.camp_groups where id='${a.group}';`), '0');
  console.log('PASS migration and reapply preserve every prior row, zero balance, grant and empty moderator roster');

  step = 'consent, account binding, signup filter and old-client gating';
  assert.equal((await status(a)).acceptedRulesVersion, null);
  assert.equal((await status(a)).isModerator, false);
  await denied(a, `public.get_my_moderation_status('${b.id}')`, /account changed/);
  await denied(a, `public.accept_community_rules('wrong','${a.id}')`, /latest community rules/);
  for (const expression of [
    "public.update_my_profile_name('New camper')", "public.update_my_profile('New camper','old_handle')",
    "public.update_group_policy('Title','Body')",
    'public.create_circle_invite()', `public.join_shared_circle('${c.code}')`,
    `public.join_shared_circle_v4('${c.code}')`, `public.join_shared_circle_v5('${c.code}')`,
    `public.add_friend_by_code('${c.code}')`, "public.redeem_circle_invite('bad')",
    `public.respond_to_circle_invite('${randomUUID()}',true)`,
    "public.create_time_request(15::smallint,'Hello','Apps')",
    `public.set_shared_app_limits('[{"label":"Social","minutes":15}]',15,'${a.id}')`,
    `public.decide_time_request('${randomUUID()}','approved')`,
  ]) await denied(a, expression, /accept the community rules/);
  await assert.rejects(() => user('fucking camper'), /change this wording/);
  const d = await user('Dickinson and Scunthorpe', true);
  assert.equal((await accept(a)).acceptedRulesVersion, '2026-10-12'); await accept(b); await accept(c);
  await rpc(a, "public.update_my_profile_name('Scunthorpe camper')");
  await denied(a, "public.update_my_profile_name('YOU FUCK')", /change this wording/);
  await denied(a, "public.update_group_policy('Title','kill yourself')", /change this wording/);
  await denied(a, "public.create_time_request(15::smallint,'kill yourself','Apps')", /change this wording/);
  await denied(a, `public.set_shared_app_limits('[{"label":"FUCK","minutes":15}]',15,'${a.id}')`, /change this wording/);
  await rpc(a, `public.set_shared_daily_total(90,'${a.id}')`);
  console.log('PASS owner binding, whole-token filter, signup metadata rejection, all supported legacy social gates and personal total');

  step = 'private table ACLs and helper endpoints';
  for (const table of ['community_moderators','community_reports','community_report_receipts','community_rule_acceptances','community_restrictions','community_notices','community_moderation_audit']) {
    await assert.rejects(() => sql(`begin; ${identity(a)} select * from public.${table}; commit;`), /permission denied/);
    await assert.rejects(() => sql(`begin; ${identity(a)} delete from public.${table}; commit;`), /permission denied/);
  }
  for (const name of ['community_base_update_my_profile_name(text)','community_base_join_shared_circle_v5(text)',
    'community_base_create_time_request(smallint,text,text)','circle_create_request_legacy(smallint,text,text)',
    'community_is_moderator(uuid)','community_assert_social(uuid)']) {
    assert.equal(await sql(`select has_function_privilege('authenticated',${lit('public.' + name)},'EXECUTE');`), 'f');
    assert.equal(await sql(`select has_function_privilege('anon',${lit('public.' + name)},'EXECUTE');`), 'f');
  }
  for (const table of ['profiles','circles','circle_members','circle_invites','camp_groups','camp_group_members','shared_app_limits','time_requests','request_recipients']) {
    assert.equal(await sql(`select has_any_column_privilege('authenticated','public.${table}','UPDATE');`), 'f');
    assert.equal(await sql(`select has_any_column_privilege('authenticated','public.${table}','INSERT');`), 'f');
  }
  await denied(a, `public.get_moderation_queue('${a.id}')`, /Moderator access/);
  await assert.rejects(() => sql(`set role anon; select public.get_my_moderation_status('${a.id}');`), /permission denied/);
  console.log('PASS private report/admin tables, no privilege from metadata, no private helper/direct-column bypass');

  step = 'authoritative report snapshot, dedupe, noncurrent and unreadable request denial';
  await rpc(b, `public.set_shared_app_limits('[{"label":"Social feed","minutes":30}]',30,'${b.id}')`);
  const clientId = randomUUID(); const first = await report(a,b,null,'offensive_content','Name and label\nMore context\there',clientId);
  assert.equal((await report(a,b,null,'offensive_content','Name and label\nMore context\there',clientId)).reportId, first.reportId);
  const aliasId=randomUUID(); assert.equal((await report(a,b,null,'offensive_content','Name and label\nMore context\there',aliasId)).reportId, first.reportId);
  await assert.rejects(() => report(a,b,null,'spam','Changed',clientId), /already used/);
  await assert.rejects(() => report(a,d), /no longer in your circle/);
  await assert.rejects(() => report(a,a), /no longer in your circle/);
  await assert.rejects(() => report(a,b,randomUUID()), /not available/);
  await assert.rejects(() => report(a,b,null,'other','x'.repeat(501)), /500/);
  assert.equal(await sql('select count(*) from public.community_restrictions;'), '0');
  await sql(`insert into public.community_moderators(user_id) values('${c.id}');`);
  const queue = await rpc(c, `public.get_moderation_queue('${c.id}')`);
  assert.equal(queue.length,1); assert.equal(queue[0].snapshot.displayName,b.name);
  assert.deepEqual(queue[0].snapshot.sharedLabels,[{label:'Social feed',minutes:30}]);
  assert.equal(JSON.stringify(queue).includes(a.id),false);
  assert.equal(JSON.stringify(queue).includes(b.code),false);
  await denied(a, `public.review_moderation_report('${a.id}','${first.reportId}',1,'dismiss','',null)`, /Moderator access/);
  console.log('PASS authoritative minimum snapshot, retry/dedupe, target/privacy validation and no automatic restrictions');

  step = 'compare-before-remove, moderator idempotency and audit';
  await rpc(b, "public.update_my_profile_name('Updated camper')");
  assert.equal((await report(a,b,null,'offensive_content','Name and label\nMore context\there',aliasId)).reportId, first.reportId);
  await assert.rejects(() => review(c,first,1,'remove_content'), /content has changed/);
  assert.equal(await sql(`select display_name from public.profiles where id='${b.id}'`),'Updated camper');
  const fresh = await report(a,b);
  const removed = await review(c,fresh,1,'remove_content');
  assert.equal(removed.version,2); assert.equal(removed.status,'resolved');
  assert.deepEqual(await review(c,fresh,1,'remove_content'),removed);
  await assert.rejects(() => review(c,fresh,1,'warn','Be kind'), /report changed/);
  assert.equal(await sql(`select display_name from public.profiles where id='${b.id}'`),'Camper');
  assert.equal(await sql(`select apps is null and total_daily_minutes=30 from public.shared_app_limits where user_id='${b.id}'`),'t');
  assert.equal(await sql(`select count(*) from public.community_moderation_audit where report_id='${fresh.reportId}'`),'1');
  assert.equal((await status(b)).notices.length,1);
  console.log('PASS changed content protected, precise removal preserves minutes, stable retries, private notice + audit');

  step = 'request reporting/removal and no mutation of grant/decision';
  const requestId = await rpc(b,"public.create_time_request(15::smallint,'Need a moment','Social')");
  const requestReport = await report(a,b,requestId,'harassment','Request note');
  await review(c,requestReport,1,'remove_content','Please keep requests kind.');
  assert.equal(await sql(`select reason is null and category_label='Selected apps' and status='pending' from public.time_requests where id='${requestId}'`),'t');
  await rpc(a,`public.decide_time_request('${requestId}','approved')`);
  const approvedGrant = await rpc(b,`public.claim_screen_time_grant('${requestId}')`);
  assert.equal(Date.parse(approvedGrant.expiresAt)-Date.parse(approvedGrant.startedAt),15*60_000);
  console.log('PASS exact readable request report and text-only removal preserve approval/grant');

  step = 'restriction scope, retry cannot extend expiry, restore and old endpoint protection';
  const restrictReport = await report(a,b,null,'harassment');
  const restricted = await review(c,restrictReport,1,'restrict','Repeated harassment. Email support to appeal.',7);
  const restriction = (await status(b)).restriction;
  assert.ok(restriction); assert.equal(restricted.version,2);
  await review(c,restrictReport,1,'restrict','Repeated harassment. Email support to appeal.',7);
  assert.deepEqual((await status(b)).restriction,restriction);
  await assert.rejects(() => review(c,restrictReport,1,'restrict','Repeated harassment. Email support to appeal.',30), /report changed/);
  for (const expression of ["public.update_my_profile('Bad','ignored')",'public.create_circle_invite()',
    `public.join_shared_circle('${d.code}')`,`public.add_friend_by_code('${d.code}')`,
    "public.create_time_request(15::smallint,'Hi','Apps')",`public.decide_time_request('${randomUUID()}','approved')`,
    `public.set_shared_app_limits('[{"label":"Hi","minutes":5}]',5,'${b.id}')`])
    await denied(b,expression,/Social features are restricted/);
  await assert.rejects(() => join(d,b),/circle is unavailable/);
  await rpc(b,`public.set_shared_daily_total(60,'${b.id}')`);
  await rpc(b,`public.set_shared_app_limits(null,60,'${b.id}')`);
  assert.equal((await rpc(b,'public.get_active_screen_time_grant()')).grantId,approvedGrant.grantId);
  assert.equal((await accept(b)).restriction.reason,restriction.reason);
  await report(b,a,null,'other','Still able to report');
  await review(c,restrictReport,2,'restore','Your appeal was accepted.');
  assert.equal((await status(b)).restriction,null);
  await rpc(b,"public.update_my_profile_name('Restored camper')");
  console.log('PASS manual social-only restriction, no auth ban/grant loss, personal total + reports + consent usable, retry + restore');

  step = 'restricted zero-balance panic, leave/block and account deletion';
  const secondRestriction = await report(a,b,null,'spam');
  await review(c,secondRestriction,1,'restrict','Pause social sharing for a day.',1);
  await sql(`with sampled as materialized(select clock_timestamp() as at)
    update public.screen_time_grants set started_at=sampled.at-interval '16 minutes',expires_at=sampled.at-interval '1 minute'
    from sampled where requester_id='${b.id}';`);
  const emergency = await rpc(b,`public.use_panic_button('${b.id}')`);
  assert.equal(emergency.shop.balance,0); assert.equal(emergency.grant.source,'panic');
  assert.equal((await rpc(a,'public.get_active_screen_time_grant()')).grantId,oldGrant.grant.grantId);
  const peerBalance = await sql(`select balance from public.camp_groups where id='${a.group}'`);
  const left = await rpc(b,`public.block_circle_person('${a.id}','${a.group}','${b.id}')`);
  assert.equal(left.leftCircle,true); assert.equal(left.circleShop.balance,0);
  assert.equal((await rpc(b,'public.get_active_screen_time_grant()')).grantId,emergency.grant.grantId);
  await rpc(b,'public.delete_my_account()');
  assert.equal(await sql(`select count(*) from auth.users where id='${b.id}'`),'0');
  assert.equal(await sql(`select count(*) from public.community_reports where target_user_id='${b.id}' or reporter_id='${b.id}'`),'0');
  assert.equal(await sql(`select count(*) from public.community_restrictions where user_id='${b.id}'`),'0');
  assert.equal(await sql(`select balance from public.camp_groups where id='${a.group}'`),peerBalance);
  assert.equal((await rpc(a,'public.get_active_screen_time_grant()')).grantId,oldGrant.grant.grantId);
  console.log('PASS zero-balance panic, block/leave, deletion cleanup and peer balances/grants preserved');

  step = 'five unique reports per day; reports never automatically restrict';
  await join(d,a); d.group=a.group;
  for (let n=0;n<5;n++) {
    await rpc(d,`public.update_my_profile_name('Test name ${n}')`);
    await report(a,d);
  }
  await rpc(d,"public.update_my_profile_name('Sixth name')");
  await assert.rejects(() => report(a,d),/several reports today/);
  assert.equal((await status(d)).restriction,null);

  step='real concurrent moderation vs content write, deterministic stale review and bounded retention';
  const openReports=await rpc(c,`public.get_moderation_queue('${c.id}')`);
  const pending=openReports.find(item=>item.targetUserId===d.id);
  assert.ok(pending);
  const releaseReview=await hold(c,`public.review_moderation_report('${c.id}','${pending.id}',1,'warn','Please stay kind.\nAppeal by email.',null)`);
  const application=`mod_wait_${randomUUID().replaceAll('-','')}`;
  const waiting=sql(`set application_name=${lit(application)};begin; ${identity(d)}
    select public.update_my_profile_name('Concurrency camper'); commit;`).then(()=>({ok:true}),error=>({error}));
  try {await waitForLock(application);} finally {await releaseReview();}
  assert.deepEqual(await waiting,{ok:true});
  await assert.rejects(()=>review(c,{reportId:pending.id},1,'dismiss'),/report changed/);
  assert.equal(await sql(`select count(*) from public.community_moderation_audit where report_id='${pending.id}'`),'1');

  // Account deletion locks its profile first. Review waits there BEFORE
  // taking a report lock, allowing the delete cascade to finish, not deadlock.
  const deleting=await user('Deleting camper',true);await join(deleting,a);deleting.group=a.group;
  const deletionReport=await report(d,deleting);
  const releaseDelete=await hold(deleting,'public.delete_my_account()');
  const deletionApplication=`delete_wait_${randomUUID().replaceAll('-','')}`;
  const waitingReview=sql(`set application_name=${lit(deletionApplication)};begin; ${identity(c)}
    select public.review_moderation_report('${c.id}','${deletionReport.reportId}',1,'warn','Be kind',null);commit;`)
    .then(()=>({ok:true}),error=>({error}));
  try {await waitForLock(deletionApplication);}finally{await releaseDelete();}
  assert.match((await waitingReview).error?.message ?? '',/Report unavailable/);

  // Service-only cleanup deletes closed reports based on review time, not
  // original submission time; recent actions and open reports remain.
  await denied(a,'public.purge_expired_community_reports()',/permission denied/);
  await sql(`update public.community_reports set created_at=clock_timestamp()-interval '100 days' where id='${pending.id}';`);
  assert.equal(await sql('set role service_role;select public.purge_expired_community_reports();'),'0');
  await sql(`update public.community_moderation_audit set created_at=clock_timestamp()-interval '91 days' where report_id='${pending.id}';`);
  assert.equal(await sql('set role service_role;select public.purge_expired_community_reports();'),'1');
  assert.equal(await sql(`select count(*) from public.community_notices where report_id='${pending.id}'`),'0');
  assert.equal(await sql(`select count(*) from public.community_moderation_audit where report_id='${pending.id}'`),'0');
  assert.ok((await rpc(c,`public.get_moderation_queue('${c.id}')`)).length>0);
  console.log('PASS real concurrent write/review and account-delete races, no deadlock, retention ACL and cascades');

  step='continued abuse remains reportable and reporter deletion cannot orphan restrictions';
  const reporter=await user('Temporary reporter',true); const target=await user('Reported camper',true);
  await join(target,reporter);target.group=reporter.group;
  const laterReporter=await user('Later reporter',true);await join(laterReporter,reporter);laterReporter.group=reporter.group;
  const reportedClientId=randomUUID();
  const warnedReport=await report(reporter,target,null,'harassment','First incident',reportedClientId);
  await review(c,warnedReport,1,'warn','Please keep your circle kind.');
  // Exact retries are receipts, but a NEW submission after the report has
  // been resolved, or with new details/reason, must remain a new open item.
  assert.equal((await report(reporter,target,null,'harassment','First incident',reportedClientId)).reportId,warnedReport.reportId);
  const continued=await report(reporter,target,null,'harassment','Second incident');
  assert.notEqual(continued.reportId,warnedReport.reportId);
  assert.equal((await report(reporter,target,null,'harassment','Second incident')).reportId,continued.reportId);
  const differentReason=await report(reporter,target,null,'spam','Second incident');
  assert.notEqual(differentReason.reportId,continued.reportId);
  const differentDetails=await report(reporter,target,null,'harassment','Third incident');
  assert.notEqual(differentDetails.reportId,continued.reportId);
  const afterClosed=await report(reporter,target,null,'harassment','First incident');
  assert.notEqual(afterClosed.reportId,warnedReport.reportId);
  assert.equal(await sql(`select status from public.community_reports where id='${afterClosed.reportId}'`),'open');
  const targetGrant=await rpc(target,`public.use_panic_button('${target.id}')`);
  await review(c,continued,1,'restrict','Repeated harassment. Email support to appeal.',7);
  assert.ok((await status(target)).restriction);
  const laterSource=await report(laterReporter,target,null,'harassment','A separate subsequent incident');
  await review(c,laterSource,1,'restrict','A newer restriction with retained evidence.',2);
  await rpc(reporter,'public.delete_my_account()');
  assert.equal((await status(target)).restriction?.reason,'A newer restriction with retained evidence.');
  await denied(target,"public.update_my_profile_name('Still restricted')",/Social features are restricted/);
  await rpc(laterReporter,'public.delete_my_account()');
  assert.equal((await status(target)).restriction,null);
  assert.equal((await status(target)).notices.length,0);
  assert.equal(await sql(`select count(*) from public.community_reports where reporter_id='${reporter.id}'`),'0');
  assert.equal(await sql(`select count(*) from public.community_restrictions where user_id='${target.id}'`),'0');
  await rpc(target,"public.update_my_profile_name('Able to share again')");
  assert.equal((await rpc(target,'public.get_active_screen_time_grant()')).grantId,targetGrant.grant.grantId);
  assert.equal((await rpc(target,"public.get_circle_shop_v5('UTC')")).balance,0);
  console.log('PASS new incidents/details/reasons are not masked by dedupe, exact retries stable, source deletion lifts only its restriction');

  step='keyset pagination reaches later resolved reports and supports restoration beyond page one';
  const paginationIds=Array.from({length:205},()=>randomUUID());
  const extraReportId=randomUUID();
  await sql(`insert into public.community_reports(id,reporter_id,target_user_id,client_report_id,kind,reason,details,snapshot,status,version,action,created_at) values
    ${paginationIds.map(id=>`('${id}','${a.id}','${d.id}','${randomUUID()}','person','other','Pagination fixture',
      '{"displayName":"Historic camper","sharedLabels":[]}','resolved',2,'warn','2025-01-01T00:00:00Z')`).join(',')};
    insert into public.community_reports(id,reporter_id,target_user_id,client_report_id,kind,reason,details,snapshot)
    values('${extraReportId}','${a.id}','${d.id}','${randomUUID()}','person','other','Later appeal',
      '{"displayName":"Concurrency camper","sharedLabels":[]}');`);
  await review(c,{reportId:extraReportId},1,'restrict','A later restriction must remain reachable.',7);
  await denied(c,`public.get_moderation_queue('${c.id}','resolved',now(),null)`,/both fields/);
  await denied(c,`public.get_moderation_queue('${c.id}','resolved',null,'${randomUUID()}')`,/both fields/);
  await denied(c,`public.get_moderation_queue('${c.id}','resolved','infinity','${randomUUID()}')`,/both fields/);
  const allPages=[];let cursor=null;let pages=0;
  while(pages<5) {
    const page=await rpc(c,`public.get_moderation_queue('${c.id}','resolved',${lit(cursor?.createdAt??null)},${lit(cursor?.id??null)})`);
    if(page.length===0)break;
    pages++;allPages.push(...page);cursor=page.at(-1);
    if(page.length<100)break;
  }
  assert.ok(pages>=3);assert.equal(new Set(allPages.map(item=>item.id)).size,allPages.length);
  for(const id of [...paginationIds,extraReportId])assert.ok(allPages.some(item=>item.id===id));
  assert.equal(allPages.slice(0,100).some(item=>item.id===extraReportId),false);
  await review(c,{reportId:extraReportId},2,'restore','Appeal accepted from a later queue page.');
  assert.equal((await status(d)).restriction,null);
  assert.equal(await sql("select to_regprocedure('public.get_moderation_queue(uuid,text)') is null"),'t');
  assert.equal(await sql("select has_function_privilege('authenticated','public.get_moderation_queue(uuid,text,timestamptz,uuid)','EXECUTE')"),'t');
  assert.equal(await sql("select has_function_privilege('anon','public.get_moderation_queue(uuid,text,timestamptz,uuid)','EXECUTE')"),'f');
  console.log('PASS equal-timestamp keyset pagination, complete nonduplicated traversal, later-page restore, cursor validation and ACL');
  const completed=await fixtureRows(); await sql(migration);
  if (ownerMode === '--owner-path') await sql(ownerMigration);
  assert.deepEqual(await fixtureRows(),completed);
  assert.equal(await sql("select to_regprocedure('public.get_moderation_queue(uuid,text)') is null"),'t');
  console.log('PASS rate limiting without auto-punishment and final migration reapply after real actions');
  if (ownerMigration) {
    step = '0034 database-owner moderation upgrade and invariants';
    const previous = await fixtureRows();
    const publicFunctions = await sql(`select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';`);
    await sql(ownerMigration);
    const upgraded = await fixtureRows();
    for (const [table, rows] of Object.entries(previous)) {
      assert.deepEqual(upgraded[table].map(row => Object.fromEntries(Object.keys(rows[0] ?? row).map(key => [key, row[key]]))), rows);
    }
    const laterFunctions = JSON.parse(await sql(`select jsonb_object_agg(p.oid::regprocedure::text,pg_get_functiondef(p.oid))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';`));
    const expectedChanges = ['community_guard_content()', 'review_moderation_report(uuid,uuid,integer,text,text,integer)'];
    for (const [name, definition] of Object.entries(JSON.parse(publicFunctions))) {
      if (!expectedChanges.includes(name)) assert.equal(laterFunctions[name], definition, name);
    }
    await runDatabaseOwnerChecks({ sql, lit, json, rpc, identity, user, accept, join, report, review, status,
      hold, waitForLock, fixtureRows, migration: ownerMigration, appModerator: c });
  }
  console.log('PASS all disposable community moderation fixtures; no hosted service or real user touched');
} catch(error) {
  console.error(`FAIL ${step}: ${error.stack ?? error.message}`); process.exitCode=1;
} finally {
  for (const child of active) child.kill('SIGTERM');
  if(started) await command(path.join(pgBin,'pg_ctl'),['-D',cluster,'-m','immediate','-w','stop']).catch(error=>console.error(error.message));
  console.log(`Disposable fixture retained at ${directory}`);
}
