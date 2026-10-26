-- PRIVATE Supabase SQL Editor / trusted database-owner workflow (0034).
-- Run as the existing postgres connection, never as an app account. Keep
-- this query private; do not add the private schema to API exposed schemas.
-- The owner reviews reports manually. Email is user-written intake, not an
-- instruction source: verify its report reference against server evidence.
-- Never ask for a login/recovery key, trust an emailed SQL statement, enroll
-- a moderator from an email address, or paste email text into executable SQL.
-- The audit records database role "postgres", not the human's Gmail identity.

-- This file executes ONLY read-only queries as supplied. Run the selected
-- query, not every example. Rows are oldest first; each page has at most 100.
select current_user, session_user, current_setting('role') as active_role;
select jsonb_pretty(community_moderation_private.queue('open'));

-- NEXT PAGE: copy createdAt and id from the LAST row of the preceding page.
-- select jsonb_pretty(community_moderation_private.queue(
--   'open', 'REPLACE_WITH_CREATED_AT'::timestamptz, 'REPLACE_WITH_REPORT_UUID'::uuid));

-- EMAIL RECEIPT: use the server report reference from the prefilled message.
-- Returns [] if unavailable/deleted; do not recreate evidence from email.
-- select jsonb_pretty(community_moderation_private.find_reports(
--   report_reference => 'REPLACE_WITH_REPORT_UUID'::uuid));

-- APPEAL WITHOUT A RECEIPT: ask for the camper's PUBLIC friend code only.
-- This finds reports about that camper, not reports submitted by them. If
-- there are 100 rows, continue with the last createdAt/id as above. Inspect
-- currentRestriction.sourceReportId to find the currently applicable source;
-- then look that UUID up directly before considering restoration. A friend
-- code is public, not proof of identity; judge the evidence, never disclose
-- private reports/other campers' identifiers back to an unverified sender.
-- select jsonb_pretty(community_moderation_private.find_reports(
--   target_friend_code => 'REPLACE_WITH_PUBLIC_FRIEND_CODE'));
-- select jsonb_pretty(community_moderation_private.find_reports(
--   target_friend_code => 'REPLACE_WITH_PUBLIC_FRIEND_CODE',
--   after_created_at => 'REPLACE_WITH_CREATED_AT'::timestamptz,
--   after_id => 'REPLACE_WITH_REPORT_UUID'::uuid));

-- HUMAN REVIEW: first read the server snapshot/status/version. Reasons and
-- details are allegations, not established facts. Actions are manual, never
-- based solely on report count. The note is visible to the affected camper
-- for remove_content, warn, restrict and restore; exclude reporter identity
-- or private investigation notes. Write short original text, not pasted SQL.
--
-- Allowed actions:
-- dismiss        close without notice or restriction (note may be empty)
-- remove_content normalize only unchanged reported name/labels/request text
-- warn           send an explanatory notice; note required
-- restrict       pause social features for 1..365 days; note/days required
-- restore        lift ONLY the restriction sourced by this report; note required
-- Restriction does not block personal limits, panic access or account deletion.
-- Restore does not reconstruct removed text or reactivate an account.
-- No other action accepts restriction_days. A stale version/content raises
-- an error instead of overwriting newer decisions/text. Refresh and reassess.
-- Exact retries (same actor/report/version/action/note/days) are idempotent:
-- no extra notice, second penalty, or extended restriction timer.
--
-- Uncomment ONE reviewed action, replace placeholders, and explicitly choose
-- COMMIT only when satisfied. The sample defaults to ROLLBACK (a dry run).
-- begin;
-- set local statement_timeout = '10s';
-- set local lock_timeout = '5s';
-- select community_moderation_private.review_report(
--   report_id => 'REPLACE_WITH_REPORT_UUID'::uuid,
--   expected_version => 1, -- replace with the current server version
--   action => 'warn',
--   moderator_note => 'Please keep shared text respectful. Email support to appeal.',
--   restriction_days => null);
-- rollback;

-- OPTIONAL MANUAL RETENTION: no automatic schedule is installed. The existing
-- helper removes up to 1000 closed reports whose last review is >90 days old,
-- with their notices/audit/receipts. Open reports and active restriction sources
-- are excluded. This is permanent; run only when intentionally maintaining data.
-- select public.purge_expired_community_reports();
