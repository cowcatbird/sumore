// Shared by --owner-upgrade (real 0033 records) and --owner-path (the full
// preexisting 0033 regression suite also runs against the 0034 shared core).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function runDatabaseOwnerChecks(h) {
  const { sql, lit, rpc, identity, user, join, report, review, status, hold, waitForLock, fixtureRows, migration, appModerator } = h;
  const privateSchema = 'community_moderation_private';
  const owner = async expression => JSON.parse(await sql(`select to_jsonb(${expression});`));
  const reviewExpression = (receipt, version, action, note = '', days = null) =>
    `${privateSchema}.review_report('${receipt.reportId}',${version},${lit(action)},${lit(note)},${days ?? 'null'})`;
  const ownerReview = (...args) => owner(reviewExpression(...args));
  const find = (receipt = null, code = null, cursor = null) => owner(`${privateSchema}.find_reports(${lit(receipt?.reportId ?? null)},${lit(code)},${lit(cursor?.createdAt ?? null)},${lit(cursor?.id ?? null)})`);

  const roster = await sql('select coalesce(jsonb_agg(to_jsonb(t) order by user_id),\'[]\') from public.community_moderators t;');
  assert.equal(await sql(`select bool_and(database_operator is null) from public.community_moderation_audit;`), 't');
  assert.equal(await sql(`select nspowner::regrole from pg_namespace where nspname='${privateSchema}';`), 'postgres');
  const functions = JSON.parse(await sql(`select jsonb_agg(p.oid::regprocedure::text) from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='${privateSchema}';`));
  assert.equal(functions.length, 7);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(await sql(`select has_schema_privilege('${role}','${privateSchema}','USAGE') or has_schema_privilege('${role}','${privateSchema}','CREATE');`), 'f');
    for (const fn of functions) assert.equal(await sql(`select has_function_privilege('${role}',${lit(fn)},'EXECUTE');`), 'f', `${role} ${fn}`);
    for (const expression of [`${privateSchema}.queue()`, `${privateSchema}.find_reports('${randomUUID()}')`,
      reviewExpression({reportId: randomUUID()},1,'dismiss'), `${privateSchema}.is_database_owner()`]) {
      await assert.rejects(() => sql(`set role ${role}; select ${expression};`), /permission denied/);
    }
  }
  assert.equal(await sql(`select has_function_privilege('authenticated','public.review_moderation_report(uuid,uuid,integer,text,text,integer)','EXECUTE');`), 't');
  // Check all ACL grantees, including PUBLIC (OID 0), not just named API roles.
  assert.equal(await sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
    lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where n.nspname='${privateSchema}' and a.grantee<>p.proowner;`), '0');
  console.log('PASS owner-only schema/functions, no PUBLIC/API/service-role grants or app enrollment');

  // A definer function owned by postgres cannot make an untrusted connection
  // look like postgres. This disposable adapter is not part of the migration.
  await sql(`create role authenticator;
    grant authenticated to authenticator;
    create function public.fixture_owner_probe() returns boolean language sql security definer set search_path=''
      as $$select ${privateSchema}.is_database_owner()$$;
    grant execute on function public.fixture_owner_probe() to authenticator,authenticated;`);
  assert.equal(await sql(`select ${privateSchema}.is_database_owner();`), 't');
  assert.equal(await sql(`set role postgres;select ${privateSchema}.is_database_owner();`), 't');
  assert.equal(await sql('set role authenticated;select public.fixture_owner_probe();'), 'f');
  assert.equal(await sql(`set session authorization authenticator;select public.fixture_owner_probe();`), 'f');
  assert.equal(await sql(`set session authorization authenticator;set role authenticated;
    set request.jwt.claim.role='postgres';set app.moderation_owner='true';set application_name='postgres';
    select public.fixture_owner_probe();`), 'f');
  await assert.rejects(() => sql('set session authorization authenticator;set role postgres;'), /permission denied/);
  await sql('drop function public.fixture_owner_probe();');
  console.log('PASS real session_user/authenticator, SET ROLE authenticated and spoofed claims/GUCs cannot confer owner access');

  const reporter = await user('Owner path reporter', true);
  const target = await user('Owner path camper', true);
  await join(target, reporter); target.group = reporter.group;
  await rpc(target, `public.set_shared_app_limits('[{"label":"Videos","minutes":45}]',45,'${target.id}')`);
  const first = await report(reporter,target,null,'harassment','First owner-reviewed incident');
  const queue = await owner(`${privateSchema}.queue()`);
  const appQueue = await rpc(appModerator,`public.get_moderation_queue('${appModerator.id}')`);
  assert.deepEqual(queue,appQueue);
  assert.equal((await find(first))[0].id,first.reportId);
  assert.equal((await find(null,target.code.toLowerCase()))[0].id,first.reportId);
  assert.deepEqual(await find(first,reporter.code),[]);
  assert.deepEqual(await find({reportId:randomUUID()}),[]);
  await assert.rejects(() => find(), /Provide a report/);
  const serialized = JSON.stringify(await find(first));
  for (const secret of [reporter.id, reporter.code, target.code, 'reporter_id', 'client_report_id', 'login_key', 'push_token']) assert.equal(serialized.includes(secret), false);
  await assert.rejects(() => owner(`${privateSchema}.queue('invalid')`),/Invalid report status/);
  await assert.rejects(() => owner(`${privateSchema}.queue('open',now(),null)`),/both fields/);
  await assert.rejects(() => find(first,null,{createdAt:'infinity',id:randomUUID()}),/both fields/);
  await assert.rejects(() => ownerReview(first,1,'restrict','',1),/Explain this decision/);
  await assert.rejects(() => ownerReview(first,1,'restrict','Reason',0),/1 to 365/);
  await assert.rejects(() => ownerReview(first,1,'warn','Reason',1),/Only restrictions/);
  await assert.rejects(() => ownerReview(first,1,'unknown'),/Choose a moderation/);

  await rpc(target,"public.update_my_profile_name('Changed name')");
  await assert.rejects(() => ownerReview(first,1,'remove_content'),/content has changed/);
  assert.equal(await sql(`select count(*) from public.community_moderation_audit where report_id='${first.reportId}'`),'0');
  const dismissed = await ownerReview(first,1,'dismiss');
  assert.deepEqual(await ownerReview(first,1,'dismiss'),dismissed);
  await assert.rejects(() => review(appModerator,first,1,'dismiss'),/report changed/);
  assert.equal((await find(first))[0].reviewHistory[0].databaseOperator,'postgres');
  assert.equal((await find(first))[0].reviewHistory[0].actorType,'database_owner');

  const request = await rpc(target,"public.create_time_request(15::smallint,'Request context','Videos')");
  const requestReport = await report(reporter,target,request,'harassment','Reported request');
  const removal = await report(reporter,target,null,'offensive_content','Remove old text');
  const restricted = await report(reporter,target,null,'spam','Repeated unwanted contact');
  const targetGrant = await rpc(target,`public.use_panic_button('${target.id}')`);
  const result = await ownerReview(restricted,1,'restrict','Stop unwanted contact. Email support to appeal.',7);
  const initialRestriction = (await status(target)).restriction;
  assert.ok(initialRestriction);
  assert.deepEqual(await ownerReview(restricted,1,'restrict','Stop unwanted contact. Email support to appeal.',7),result);
  assert.deepEqual((await status(target)).restriction,initialRestriction);
  await assert.rejects(() => ownerReview(restricted,1,'restrict','Stop unwanted contact. Email support to appeal.',8),/report changed/);
  await assert.rejects(() => rpc(target,"public.update_my_profile_name('Camper')"),/Social features are restricted/);
  await assert.rejects(() => sql(`begin;${identity(target)} set local app.moderation_owner='true';
    set local request.jwt.claim.role='postgres';select public.update_my_profile_name('Camper');commit;`),/Social features are restricted/);
  // Test the trigger itself through a throwaway definer adapter: no direct
  // table grants exist in production, but even an upstream definer write must
  // not acquire an owner exemption from current_user=postgres alone.
  await sql(`create function public.fixture_normalize_request(target_request uuid) returns void language sql security definer set search_path=''
    as $$update public.time_requests set reason=null,category_label='Selected apps' where id=target_request$$;
    grant execute on function public.fixture_normalize_request(uuid) to authenticated;`);
  await assert.rejects(() => rpc(target,`public.fixture_normalize_request('${request}')`),/Social features are restricted/);
  await sql('drop function public.fixture_normalize_request(uuid);');

  // Removal is possible even with both an active restriction and missing
  // consent. It resets only captured shared text; personal limits/grants stay.
  await sql(`delete from public.community_rule_acceptances where user_id='${target.id}';`);
  await ownerReview(removal,1,'remove_content');
  await ownerReview(requestReport,1,'remove_content','Keep request notes respectful.');
  assert.equal(await sql(`select display_name from public.profiles where id='${target.id}'`),'Camper');
  assert.equal(await sql(`select apps is null and total_daily_minutes=45 from public.shared_app_limits where user_id='${target.id}'`),'t');
  assert.equal(await sql(`select reason is null and category_label='Selected apps' and status='pending' and minutes=15
    from public.time_requests where id='${request}'`),'t');
  assert.equal((await rpc(target,'public.get_active_screen_time_grant()')).grantId,targetGrant.grant.grantId);
  assert.equal(await sql(`select count(*) from public.community_moderation_audit where moderator_id is not null and database_operator is not null;`),'0');
  await assert.rejects(() => rpc(target,`public.review_moderation_report('${target.id}','${restricted.reportId}',2,'restore','Please',null)`),/Moderator access/);
  console.log('PASS redacted lookup, shared app/owner queue, operator audit, stable retries, changed-content protection, restricted/unaccepted removal');

  // A newer source restriction must not be lifted via an older receipt.
  const otherReporter = await user('Second owner reporter',true);
  const secondSource = randomUUID();
  await sql(`insert into public.community_reports(id,reporter_id,target_user_id,client_report_id,kind,reason,details,snapshot)
    values('${secondSource}','${otherReporter.id}','${target.id}','${randomUUID()}','person','harassment','Later independent incident',
      '{"displayName":"Camper","sharedLabels":[]}');`);
  await ownerReview({reportId:secondSource},1,'restrict','A newer restriction.',2);
  await assert.rejects(() => ownerReview(restricted,2,'restore','Old appeal'),/does not match/);
  assert.equal((await find(restricted))[0].currentRestriction.sourceReportId,secondSource);
  const restored = await ownerReview({reportId:secondSource},2,'restore','Appeal accepted.');
  assert.deepEqual(await ownerReview({reportId:secondSource},2,'restore','Appeal accepted.'),restored);
  assert.equal((await status(target)).restriction,null);
  assert.equal((await rpc(target,'public.get_active_screen_time_grant()')).grantId,targetGrant.grant.grantId);

  const concurrentTarget = await user('Concurrent owner target',true);
  await join(concurrentTarget,otherReporter);concurrentTarget.group=otherReporter.group;
  const concurrent = await report(otherReporter,concurrentTarget,null,'harassment');
  const releaseOwner = await hold(null,reviewExpression(concurrent,1,'warn','Please stay kind.'));
  const application = `owner_review_${randomUUID().replaceAll('-','')}`;
  const waitingReview = sql(`set application_name=${lit(application)};begin;${identity(appModerator)}
    select public.review_moderation_report('${appModerator.id}','${concurrent.reportId}',1,'dismiss','',null);commit;`)
    .then(()=>({ok:true}),error=>({error}));
  try { await waitForLock(application); } finally { await releaseOwner(); }
  assert.match((await waitingReview).error?.message ?? '',/report changed/);
  assert.equal(await sql(`select count(*) from public.community_moderation_audit where report_id='${concurrent.reportId}'`),'1');

  const deletion = await report(otherReporter,concurrentTarget,null,'spam','Delete race');
  const releaseDelete = await hold(concurrentTarget,'public.delete_my_account()');
  const deleteApplication = `owner_delete_${randomUUID().replaceAll('-','')}`;
  const waitingOwner = sql(`set application_name=${lit(deleteApplication)};select ${reviewExpression(deletion,1,'warn','Be kind.')};`)
    .then(()=>({ok:true}),error=>({error}));
  try { await waitForLock(deleteApplication); } finally { await releaseDelete(); }
  assert.match((await waitingOwner).error?.message ?? '',/Report unavailable/);
  assert.deepEqual(await find(deletion),[]);
  console.log('PASS exact-source restore, owner/app concurrent review and account-deletion race without deadlock');

  const raceReporter = await user('Content race reporter',true);
  const raceTarget = await user('Content race target',true);
  await join(raceTarget,raceReporter);raceTarget.group=raceReporter.group;
  const nameRace = await report(raceReporter,raceTarget);
  const releaseName = await hold(raceTarget,"public.update_my_profile_name('New name survives')");
  const nameApplication = `owner_name_${randomUUID().replaceAll('-','')}`;
  const waitingName = sql(`set application_name=${lit(nameApplication)};select ${reviewExpression(nameRace,1,'remove_content')};`)
    .then(()=>({ok:true}),error=>({error}));
  try { await waitForLock(nameApplication); } finally { await releaseName(); }
  assert.match((await waitingName).error?.message ?? '',/content has changed/);
  assert.equal(await sql(`select display_name from public.profiles where id='${raceTarget.id}'`),'New name survives');
  const raceRequest = await rpc(raceTarget,"public.create_time_request(15::smallint,'Old note','Videos')");
  const requestRace = await report(raceReporter,raceTarget,raceRequest);
  await sql(`create function public.fixture_edit_request(request_id uuid) returns void language sql security definer set search_path=''
    as $$update public.time_requests set reason='A newer note' where id=request_id and requester_id=auth.uid()$$;
    grant execute on function public.fixture_edit_request(uuid) to authenticated;`);
  const releaseRequest = await hold(raceTarget,`public.fixture_edit_request('${raceRequest}')`);
  const requestApplication = `owner_request_${randomUUID().replaceAll('-','')}`;
  const waitingRequest = sql(`set application_name=${lit(requestApplication)};select ${reviewExpression(requestRace,1,'remove_content')};`)
    .then(()=>({ok:true}),error=>({error}));
  try { await waitForLock(requestApplication); } finally { await releaseRequest(); }
  assert.match((await waitingRequest).error?.message ?? '',/content has changed/);
  assert.equal(await sql(`select reason from public.time_requests where id='${raceRequest}'`),'A newer note');
  await sql('drop function public.fixture_edit_request(uuid);');
  assert.equal(await sql(`select count(*) from public.community_moderation_audit where report_id in ('${nameRace.reportId}','${requestRace.reportId}');`),'0');
  console.log('PASS independent-connection profile/request edits win safely over stale owner removal');

  const pageIds = Array.from({length:205},()=>randomUUID());
  await sql(`insert into public.community_reports(id,reporter_id,target_user_id,client_report_id,kind,reason,details,snapshot,status,version,action,created_at) values
    ${pageIds.map(id=>`('${id}','${raceReporter.id}','${raceTarget.id}','${randomUUID()}','person','other','Owner pagination fixture',
      '{"displayName":"Historic camper","sharedLabels":[]}','resolved',2,'warn','2025-02-01T00:00:00Z')`).join(',')};`);
  const all = []; let cursor = null;
  for (let n=0;n<5;n++) {
    const page = await find(null,raceTarget.code,cursor);
    all.push(...page); cursor=page.at(-1);
    if (page.length<100) break;
  }
  assert.equal(new Set(all.map(item=>item.id)).size,all.length);
  for (const id of pageIds) assert.ok(all.some(item=>item.id===id));
  assert.ok(all.length>200);
  const resolvedPages = []; cursor=null;
  for (let n=0;n<10;n++) {
    const page=await owner(`${privateSchema}.queue('resolved',${lit(cursor?.createdAt ?? null)},${lit(cursor?.id ?? null)})`);
    resolvedPages.push(...page);cursor=page.at(-1);
    if(page.length<100)break;
  }
  assert.equal(new Set(resolvedPages.map(item=>item.id)).size,resolvedPages.length);
  for (const id of pageIds)assert.ok(resolvedPages.some(item=>item.id===id));
  console.log('PASS owner queue and target appeal lookup traverse equal-timestamp pages without omissions/duplicates');

  // Reporter deletion cascades owner-authored notices/audit and lifts only
  // that report's restriction; it never deletes a target's personal grant.
  const latest = await report(otherReporter,otherReporter,null).then(()=>{throw new Error('Self report accepted');},error=>error);
  assert.match(latest.message,/no longer in your circle/);
  const manualSource = randomUUID();
  await sql(`insert into public.community_reports(id,reporter_id,target_user_id,client_report_id,kind,reason,details,snapshot)
    values('${manualSource}','${otherReporter.id}','${target.id}','${randomUUID()}','person','other','Delete source test','{"displayName":"Camper","sharedLabels":[]}');`);
  await ownerReview({reportId:manualSource},1,'restrict','Temporary social restriction.',1);
  await rpc(otherReporter,'public.delete_my_account()');
  assert.equal((await status(target)).restriction,null);
  assert.equal((await rpc(target,'public.get_active_screen_time_grant()')).grantId,targetGrant.grant.grantId);
  assert.equal(await sql(`select count(*) from public.community_moderation_audit where report_id='${manualSource}'`),'0');

  // Owner maintenance uses the existing bounded helper; no schedule is added.
  const keep = await user('Retention owner target',true);
  const oldReport = randomUUID();
  await sql(`insert into public.community_reports(id,reporter_id,target_user_id,client_report_id,kind,reason,details,snapshot)
    values('${oldReport}','${reporter.id}','${keep.id}','${randomUUID()}','person','other','Retention fixture','{"displayName":"Retention owner target","sharedLabels":[]}');`);
  await ownerReview({reportId:oldReport},1,'restrict','Retain active-source evidence.',200);
  await sql(`update public.community_reports set created_at=clock_timestamp()-interval '100 days' where id='${oldReport}';
    update public.community_moderation_audit set created_at=clock_timestamp()-interval '100 days' where report_id='${oldReport}';`);
  await owner('public.purge_expired_community_reports()');
  assert.equal((await find({reportId:oldReport})).length,1);
  await ownerReview({reportId:oldReport},2,'restore','Restriction lifted.');
  await owner('public.purge_expired_community_reports()');
  assert.equal((await find({reportId:oldReport})).length,1);
  await sql(`update public.community_moderation_audit set created_at=clock_timestamp()-interval '91 days' where report_id='${oldReport}';`);
  await owner('public.purge_expired_community_reports()');
  assert.deepEqual(await find({reportId:oldReport}),[]);
  const completed = await fixtureRows(); await sql(migration); assert.deepEqual(await fixtureRows(),completed);
  assert.equal(await sql('select coalesce(jsonb_agg(to_jsonb(t) order by user_id),\'[]\') from public.community_moderators t;'),roster);
  console.log('PASS owner audit cascades, existing bounded manual retention and migration reapply preserve every row/roster');
}
