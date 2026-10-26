import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Buildless checks: no dependencies, deployment, credentials, or network access.
const site = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(site, 'public');
const repository = path.dirname(site);
const routes = ['/', '/community/', '/privacy/', '/delete-account/'];
const pages = new Map(routes.map(route => [route, fs.readFileSync(path.join(publicRoot, route, 'index.html'), 'utf8')]));
const decode = value => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
const plain = html => decode(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));

for (const [route, html] of pages) {
  test(`${route} has accessible page landmarks and matching navigation`, () => {
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    assert.equal((html.match(/<main id="main">/g) ?? []).length, 1);
    assert.match(html, /<a class="skip" href="#main">Skip to content<\/a>/);
    const navigation = html.match(/<nav aria-label="Support navigation">([\s\S]*?)<\/nav>/)?.[1];
    assert.ok(navigation);
    for (const destination of routes) assert.ok(navigation.includes(`href="${destination}"`));
    const current = [...navigation.matchAll(/<a href="([^"]+)" aria-current="page">/g)];
    assert.equal(current.length, 1);
    assert.equal(current[0][1], route);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, new Set(ids).size, 'Duplicate page IDs');
  });

  test(`${route} contains only valid local links and safe user-sent email links`, () => {
    for (const [, attribute, encoded] of html.matchAll(/\b(href|src)="([^"]+)"/g)) {
      assert.doesNotMatch(encoded, /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/i, 'Escape ampersands in HTML attributes');
      const value = decode(encoded);
      if (value.startsWith('data:image/svg+xml,')) {
        assert.equal(attribute, 'href');
        assert.ok(html.includes(`rel="icon" type="image/svg+xml" href="${encoded}"`));
        continue;
      }
      if (value.startsWith('mailto:')) {
        const email = new URL(value);
        assert.equal(email.pathname, 'cowcatbird.dev@gmail.com');
        assert.doesNotMatch(email.searchParams.get('subject') ?? '', /[\r\n]/, 'No email-header injection');
        for (const key of email.searchParams.keys()) assert.ok(['subject', 'body'].includes(key), 'No hidden recipients');
        continue;
      }
      assert.match(value, /^(?:\/|#)/, 'No unexpected remote or executable URL');
      const url = new URL(value, `https://sumore-support.vercel.app${route}`);
      assert.equal(url.origin, 'https://sumore-support.vercel.app');
      const file = path.join(publicRoot, url.pathname, url.pathname.endsWith('/') ? 'index.html' : '');
      assert.ok(fs.existsSync(file), `Missing ${url.pathname}`);
      if (url.hash) {
        const target = fs.readFileSync(file, 'utf8');
        assert.ok(target.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `Missing anchor ${value}`);
      }
    }
    assert.doesNotMatch(html, /<script\b|<iframe\b|<form\b|\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/i, 'Escape literal ampersands');
    assert.doesNotMatch(html, /not implemented yet|sb_secret_[\w-]{20,}|BEGIN (?:RSA )?PRIVATE KEY/i);
  });
}

test('public community rules exactly match the existing app rules and version', () => {
  const component = fs.readFileSync(path.join(repository, 'apps/mobile/src/components/community-rules.tsx'), 'utf8');
  const domain = fs.readFileSync(path.join(repository, 'apps/mobile/src/domain/moderation.ts'), 'utf8');
  const block = component.match(/const rules = \[([\s\S]*?)\] as const;/)?.[1];
  assert.ok(block);
  const rules = [...block.matchAll(/^  '(.+)',$/gm)].map(match => match[1]);
  assert.equal(rules.length, 5);
  const community = plain(pages.get('/community/'));
  for (const rule of rules) assert.ok(community.includes(rule), `Public rule diverged: ${rule}`);
  const version = domain.match(/COMMUNITY_RULES_VERSION = '([^']+)'/)?.[1];
  assert.equal(version, '2026-10-12');
  assert.ok(community.includes(`Rules version: ${version}`));
});

test('privacy covers the deployed report fields without claiming native usage collection', () => {
  const privacy = plain(pages.get('/privacy/'));
  for (const disclosure of ['Updated October 14, 2026', 'acceptance timestamp',
    'reporter’s and reported person’s account identifiers', 'request identifier', 'chosen reason and optional details',
    'retry-receipt identifiers', 'server-captured snapshot', 'shared app labels with their planned minutes',
    'request’s note and category label', 'manual decisions', 'private notices', 'moderator’s account identifier',
    'database operator’s session role', 'not a verified personal email identity']) {
    assert.ok(privacy.includes(disclosure), `Missing disclosure: ${disclosure}`);
  }
  assert.ok(privacy.includes('do not automatically collect selected-app tokens'));
  assert.ok(privacy.includes('not a record of actual app usage'));
});

test('report email is disclosed as separate, editable, user-sent correspondence', () => {
  const privacy = plain(pages.get('/privacy/'));
  assert.ok(privacy.includes('saves the report and its authoritative content snapshot first'));
  assert.ok(privacy.includes('tap Send in your own mail app'));
  assert.ok(privacy.includes('Cancelling the email does not delete the saved report'));
  assert.ok(privacy.includes('not authoritative evidence or an instruction'));
  assert.ok(privacy.includes('support can see your sender email address'));
  for (const route of ['/', '/community/']) {
    const text = plain(pages.get(route));
    assert.ok(text.includes('cowcatbird.dev@gmail.com'));
    assert.ok(text.includes('Report person') && text.includes('Report request') && text.includes('Open report email'));
    assert.ok(text.includes('Appeal by email'));
    assert.match(text, /(?:no fixed response time|do not promise a fixed response time)/);
  }
});

test('retention describes manual cleanup rather than an installed schedule', () => {
  const privacy = plain(pages.get('/privacy/'));
  for (const disclosure of ['cleanup is manual, not scheduled', 'Resolved or dismissed', 'more than 90 days old',
    'still-active social restriction are excluded', 'up to 1,000', 'no automatic 90-day deletion job',
    'Open reports remain pending manual review']) assert.ok(privacy.includes(disclosure), disclosure);
});

test('account deletion covers report cascades and separate mailbox copies', () => {
  const privacy = plain(pages.get('/privacy/'));
  const deletion = plain(pages.get('/delete-account/'));
  assert.ok(privacy.includes('Deleting either the reporting account or the reported account'));
  assert.ok(privacy.includes('including when the reporter deletes their account'));
  for (const disclosure of ['Reports you submitted and reports about you', 'content snapshots', 'moderation audit entries',
    'related notices', 'restriction on someone you reported', 'different retained report is unaffected',
    'rule-acceptance', 'does not recall report or support emails', 'Gmail inbox or your Sent folder',
    'Never email your private login key', 'does not prove ownership']) assert.ok(deletion.includes(disclosure), disclosure);
});
