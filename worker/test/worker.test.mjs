// Ausführen: node --test worker/test/
// Testet Worker-Logik mit simulierten Plattform-APIs (keine echten Netzaufrufe).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { sync, localDate, localMidnight } from '../src/index.js';

function kv() {
  const m = new Map();
  return {
    m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
  };
}
const ENV = () => ({
  HUB: kv(), APP_KEY: 'test-key-123', APP_ORIGIN: 'https://ruppivandaline-efn.github.io', APP_URL: 'https://example.org/app/',
  IG_CLIENT_ID: 'ig', IG_CLIENT_SECRET: 'igs', TIKTOK_CLIENT_KEY: 'tk', TIKTOK_CLIENT_SECRET: 'tks', SC_CLIENT_ID: 'sc', SC_CLIENT_SECRET: 'scs',
});
const res = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let calls = [];
let tiktokViews = [100, 250];
function mockFetch(url, init = {}) {
  calls.push({ url: String(url), init });
  const u = new URL(url);
  if (u.host === 'api.instagram.com') return res({ access_token: 'short', user_id: 17841 });
  if (u.host === 'graph.instagram.com' && u.pathname === '/access_token') return res({ access_token: 'long', expires_in: 5184000 });
  if (u.host === 'graph.instagram.com' && u.pathname === '/me') return res({ user_id: '17841', username: 'ruppi', followers_count: 2121 });
  if (u.host === 'graph.instagram.com' && u.pathname.endsWith('/insights')) return res({ data: [{ name: 'views', total_value: { value: 930 } }, { name: 'total_interactions', total_value: { value: 71 } }] });
  if (u.host === 'open.tiktokapis.com' && u.pathname === '/v2/oauth/token/') return res({ access_token: 'tt', refresh_token: 'ttr', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'o1' });
  if (u.host === 'open.tiktokapis.com' && u.pathname === '/v2/user/info/') return res({ data: { user: { display_name: 'Ruppi', follower_count: 4244, likes_count: 60505 } }, error: { code: 'ok' } });
  if (u.host === 'open.tiktokapis.com' && u.pathname === '/v2/video/list/') {
    const body = JSON.parse(init.body);
    if (!body.cursor) return res({ data: { videos: [{ id: '1', view_count: tiktokViews[0] }], has_more: true, cursor: 5 } });
    return res({ data: { videos: [{ id: '2', view_count: tiktokViews[1] }], has_more: false } });
  }
  if (u.host === 'secure.soundcloud.com') return res({ access_token: 'sca', refresh_token: 'scr' + Math.random(), expires_in: 3600 });
  if (u.host === 'api.soundcloud.com' && u.pathname === '/me') return res({ username: 'ruppi', followers_count: 1541 });
  if (u.host === 'api.soundcloud.com' && u.pathname === '/me/tracks') {
    if (!u.searchParams.get('page')) return res({ collection: [{ playback_count: 1000, likes_count: 50 }], next_href: 'https://api.soundcloud.com/me/tracks?page=2' });
    return res({ collection: [{ playback_count: 500, favoritings_count: 20 }], next_href: null });
  }
  return res({ error: 'unexpected ' + url }, 500);
}
globalThis.fetch = mockFetch;

const call = (env, path, init = {}) => worker.fetch(new Request('https://hub.example.workers.dev' + path, init), env, { waitUntil() {} });

test('Datumshilfen: Berliner Mitternacht (Winterzeit = UTC+1)', () => {
  assert.equal(localMidnight('2026-11-20'), Date.UTC(2026, 10, 19, 23) / 1000);
  assert.equal(localMidnight('2026-07-01'), Date.UTC(2026, 5, 30, 22) / 1000);
  assert.equal(localDate(Date.UTC(2026, 10, 19, 23, 30)), '2026-11-20');
});

test('geschützte Endpunkte verlangen APP_KEY, CORS-Header gesetzt', async () => {
  const env = ENV();
  assert.equal((await call(env, '/data')).status, 401);
  const ok = await call(env, '/data', { headers: { authorization: 'Bearer test-key-123' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://ruppivandaline-efn.github.io');
  assert.equal((await call(env, '/data', { method: 'OPTIONS' })).status, 204);
  assert.equal((await call(env, '/auth/instagram/start?key=falsch')).status, 401);
});

test('OAuth-Flow für alle drei Plattformen, danach Daten im App-Format', async () => {
  const env = ENV();
  for (const p of ['instagram', 'tiktok', 'soundcloud']) {
    const start = await call(env, `/auth/${p}/start?key=test-key-123`);
    assert.equal(start.status, 302, p);
    const loc = new URL(start.headers.get('location'));
    const state = loc.searchParams.get('state');
    assert.ok(state);
    assert.equal(loc.searchParams.get('redirect_uri'), `https://hub.example.workers.dev/auth/${p}/callback`);
    if (p === 'soundcloud') assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
    const cb = await call(env, `/auth/${p}/callback?code=abc&state=${state}`);
    const text = await cb.text();
    assert.equal(cb.status, 200, text);
    assert.match(text, /Erster Abruf erfolgreich/);
    // State nur einmal verwendbar
    assert.equal((await call(env, `/auth/${p}/callback?code=abc&state=${state}`)).status, 400);
  }
  const data = await (await call(env, '/data', { headers: { authorization: 'Bearer test-key-123' } })).json();
  const keys = Object.keys(data.entries);
  const today = localDate(), y = localDate(Date.now(), -1);
  assert.equal(data.entries[`instagram|followers|${today}`], 2121);
  assert.equal(data.entries[`instagram|views|${y}`], 930);
  assert.equal(data.entries[`instagram|interactions|${y}`], 71);
  assert.equal(data.entries[`tiktok|followers|${today}`], 4244);
  assert.equal(data.entries[`soundcloud|plays|${today}`], 1500);
  assert.equal(data.entries[`soundcloud|likes|${today}`], 70);
  assert.ok(keys.every((k) => /^(instagram|tiktok|soundcloud)\|[a-z]+\|\d{4}-\d{2}-\d{2}$/.test(k)));

  const st = await (await call(env, '/status', { headers: { authorization: 'Bearer test-key-123' } })).json();
  assert.ok(Object.values(st.providers).every((p) => p.linked && p.configured && p.last.ok));
  // Secrets tauchen nirgends in Antworten auf
  assert.ok(!JSON.stringify(st).includes('igs') && !JSON.stringify(data).includes('long'));
});

test('TikTok: Tagesaufrufe = Differenz der Gesamtaufrufe zum Vortag', async () => {
  const env = ENV();
  await env.HUB.put('tokens:tiktok', JSON.stringify({ access_token: 'tt', refresh_token: 'r', expires_at: Date.now() + 86400000 }));
  const day1 = Date.UTC(2026, 10, 18, 5), day2 = Date.UTC(2026, 10, 19, 5);
  tiktokViews = [100, 250];
  await sync(env, 'tiktok', day1);
  tiktokViews = [180, 300];
  await sync(env, 'tiktok', day2);
  const data = JSON.parse(await env.HUB.get('data'));
  assert.equal(data.entries['tiktok|views|2026-11-18'], 130);
  assert.equal(data.entries['tiktok|views|2026-11-17'], undefined);
});

test('SoundCloud: abgelaufener Token wird erneuert und neuer Refresh-Token gespeichert', async () => {
  const env = ENV();
  await env.HUB.put('tokens:soundcloud', JSON.stringify({ access_token: 'old', refresh_token: 'r1', expires_at: Date.now() - 1000 }));
  calls = [];
  const r = await sync(env, 'soundcloud');
  assert.ok(r.soundcloud.ok);
  const tok = JSON.parse(await env.HUB.get('tokens:soundcloud'));
  assert.notEqual(tok.refresh_token, 'r1');
  const refreshCall = calls.find((c) => c.url.includes('oauth/token'));
  assert.match(refreshCall.init.body, /grant_type=refresh_token/);
});

test('Fehler einer Plattform blockiert die anderen nicht', async () => {
  const env = ENV();
  await env.HUB.put('tokens:instagram', JSON.stringify({ access_token: 'x', refreshed_at: Date.now() }));
  await env.HUB.put('tokens:soundcloud', JSON.stringify({ access_token: 'y', refresh_token: 'r', expires_at: Date.now() + 3600000 }));
  const orig = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).includes('graph.instagram.com') ? res({ error: { message: 'Token abgelaufen' } }, 400) : orig(url, init));
  const r = await sync(env);
  globalThis.fetch = orig;
  assert.equal(r.instagram.ok, false);
  assert.match(r.instagram.error, /Token abgelaufen/);
  assert.equal(r.soundcloud.ok, true);
  assert.equal(r.tiktok.linked, false);
});
