/**
 * Artist Hub Sync-Worker (Cloudflare Workers + KV)
 *
 * - Verbindet Instagram, TikTok und SoundCloud per OAuth und speichert die Tokens in KV.
 * - Ruft täglich (Cron) die Kennzahlen ab und legt sie im selben Format ab wie die App:
 *   entries["<plattform>|<metrik>|<YYYY-MM-DD>"] = Zahl
 * - Die App holt die Daten über GET /data (Bearer APP_KEY).
 *
 * Secrets: APP_KEY, IG_CLIENT_ID, IG_CLIENT_SECRET, TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, SC_CLIENT_ID, SC_CLIENT_SECRET
 * Vars:    APP_ORIGIN (für CORS), APP_URL (Rücksprung nach dem Verbinden)
 * KV:      HUB
 */

const TZ = 'Europe/Berlin';
const PROVIDERS = ['instagram', 'tiktok', 'soundcloud'];

// ---------------------------------------------------------------------------
// Datum & Hilfen
// ---------------------------------------------------------------------------
export function localDate(ts = Date.now(), offsetDays = 0) {
  const d = new Date(ts + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Unix-Sekunden für 00:00 Uhr Ortszeit des Datums */
export function localMidnight(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const part = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' })
    .formatToParts(new Date(guess)).find((p) => p.type === 'timeZoneName').value; // z. B. "GMT+1"
  const mm = part.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  const offMin = mm ? (mm[1] === '-' ? -1 : 1) * (Number(mm[2]) * 60 + Number(mm[3] || 0)) : 0;
  return Math.floor((guess - offMin * 60000) / 1000);
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

const html = (title, body, status = 200) =>
  new Response(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#121211;color:#f0efec;max-width:520px;margin:0 auto;padding:32px 16px}a{color:#3987e5}</style></head><body>${body}</body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// Toleriert versehentliche Leerzeichen/Zeilenumbrüche beim Einfügen des Secrets
const appKey = (env) => (env.APP_KEY || '').trim();
function authorized(req, env) {
  const h = req.headers.get('authorization') || '';
  return !!appKey(env) && safeEqual(h.replace(/^(Bearer\s+)+/i, '').trim(), appKey(env));
}
function cors(env) {
  return {
    'access-control-allow-origin': env.APP_ORIGIN || '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}
function randomString(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256b64url(s) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return btoa(String.fromCharCode(...h)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getJSON(env, key, fallback) {
  const v = await env.HUB.get(key);
  return v ? JSON.parse(v) : fallback;
}
const putJSON = (env, key, val, opts) => env.HUB.put(key, JSON.stringify(val), opts);

async function http(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = typeof body === 'object' ? (body.error?.message || body.error_description || body.message || JSON.stringify(body)) : String(body);
    throw new Error(`HTTP ${res.status} ${new URL(url).host}: ${String(msg).slice(0, 300)}`);
  }
  return body;
}
const form = (obj) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(obj).toString() });

// ---------------------------------------------------------------------------
// Provider: Instagram (Instagram API mit Instagram Login, Creator-/Business-Konto)
// ---------------------------------------------------------------------------
// Zwei Modi:
//  - "unified" (IG_CONFIG_ID gesetzt): neue Apps ab Okt. 2026. Facebook Login for Business mit Konfiguration,
//    liefert ein System-User-Token ohne Ablauf; Aufrufe über graph.facebook.com.
//  - "legacy": Instagram Login (instagram.com/oauth), für ältere Apps.
const IG_VER = (env) => env.IG_GRAPH_VERSION || 'v25.0';
const instagram = {
  configured: (env) => !!(env.IG_CLIENT_ID && env.IG_CLIENT_SECRET),
  authUrl(env, redirect, state) {
    if (env.IG_CONFIG_ID) {
      const u = new URL(`https://www.facebook.com/${IG_VER(env)}/dialog/oauth`);
      u.search = new URLSearchParams({
        client_id: env.IG_CLIENT_ID, redirect_uri: redirect, state, config_id: env.IG_CONFIG_ID,
        response_type: 'code', override_default_response_type: 'true',
      });
      return u.toString();
    }
    const u = new URL('https://www.instagram.com/oauth/authorize');
    u.search = new URLSearchParams({
      client_id: env.IG_CLIENT_ID, redirect_uri: redirect, response_type: 'code', state,
      scope: 'instagram_business_basic,instagram_business_manage_insights',
    });
    return u.toString();
  },
  async exchange(env, code, redirect) {
    if (env.IG_CONFIG_ID) {
      const base = `https://graph.facebook.com/${IG_VER(env)}`;
      const r = await http(`${base}/oauth/access_token?${new URLSearchParams({
        client_id: env.IG_CLIENT_ID, client_secret: env.IG_CLIENT_SECRET, redirect_uri: redirect, code,
      })}`);
      const t = encodeURIComponent(r.access_token);
      let igId = '';
      try {
        const a = await http(`${base}/me/assigned_instagram_accounts?fields=id,username&access_token=${t}`);
        igId = a.data?.[0]?.id || '';
      } catch (e) { /* Fallback unten */ }
      if (!igId) {
        try {
          const pages = await http(`${base}/me/accounts?fields=instagram_business_account&access_token=${t}`);
          igId = (pages.data || []).map((p) => p.instagram_business_account?.id).find(Boolean) || '';
        } catch (e) { /* egal */ }
      }
      if (!igId) throw new Error('Kein Instagram-Konto im Token gefunden. Prüfe: Konto im Business-Portfolio, Berechtigungen business_management + instagram_basic in der Konfiguration.');
      return { mode: 'unified', access_token: r.access_token, ig_id: igId, expires_at: r.expires_in ? Date.now() + r.expires_in * 1000 : null };
    }
    const short = await http('https://api.instagram.com/oauth/access_token', form({
      client_id: env.IG_CLIENT_ID, client_secret: env.IG_CLIENT_SECRET, grant_type: 'authorization_code', redirect_uri: redirect, code,
    }));
    const long = await http(`https://graph.instagram.com/access_token?${new URLSearchParams({
      grant_type: 'ig_exchange_token', client_secret: env.IG_CLIENT_SECRET, access_token: short.access_token,
    })}`);
    return { mode: 'legacy', access_token: long.access_token, expires_at: Date.now() + (long.expires_in || 5184000) * 1000, refreshed_at: Date.now(), user_id: String(short.user_id || '') };
  },
  async refresh(env, tok) {
    if (tok.mode === 'unified') return tok; // System-User-Token läuft nicht ab
    // Langzeit-Token gilt 60 Tage; wöchentlich verlängern
    if (Date.now() - (tok.refreshed_at || 0) < 7 * 86400000) return tok;
    const r = await http(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: tok.access_token })}`);
    return { ...tok, access_token: r.access_token, expires_at: Date.now() + (r.expires_in || 5184000) * 1000, refreshed_at: Date.now() };
  },
  async fetch(env, tok, now) {
    const t = encodeURIComponent(tok.access_token);
    let base, id, me;
    if (tok.mode === 'unified') {
      base = `https://graph.facebook.com/${IG_VER(env)}`;
      id = tok.ig_id;
      me = await http(`${base}/${id}?fields=username,followers_count&access_token=${t}`);
    } else {
      base = 'https://graph.instagram.com';
      me = await http(`${base}/me?fields=user_id,username,followers_count&access_token=${t}`);
      id = me.user_id || me.id;
    }
    const today = localDate(now), yesterday = localDate(now, -1);
    const out = [{ m: 'followers', d: today, v: me.followers_count }];
    const ins = await http(`${base}/${id}/insights?${new URLSearchParams({
      metric: 'views,total_interactions', period: 'day', metric_type: 'total_value',
      since: String(localMidnight(yesterday)), until: String(localMidnight(today)), access_token: tok.access_token,
    })}`);
    for (const row of ins.data || []) {
      const v = row.total_value?.value;
      if (typeof v !== 'number') continue;
      if (row.name === 'views') out.push({ m: 'views', d: yesterday, v });
      if (row.name === 'total_interactions') out.push({ m: 'interactions', d: yesterday, v });
    }
    return { values: out, account: me.username };
  },
};

// ---------------------------------------------------------------------------
// Provider: TikTok (Login Kit + Display API)
// ---------------------------------------------------------------------------
const tiktok = {
  configured: (env) => !!(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET),
  authUrl(env, redirect, state) {
    const u = new URL('https://www.tiktok.com/v2/auth/authorize/');
    u.search = new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY, response_type: 'code', redirect_uri: redirect, state,
      scope: 'user.info.basic,user.info.stats,video.list',
    });
    return u.toString();
  },
  tokenFrom(r) {
    if (r.error) throw new Error(`TikTok: ${r.error_description || r.error}`);
    return {
      access_token: r.access_token, refresh_token: r.refresh_token, open_id: r.open_id,
      expires_at: Date.now() + (r.expires_in || 86400) * 1000,
      refresh_expires_at: Date.now() + (r.refresh_expires_in || 31536000) * 1000,
    };
  },
  async exchange(env, code, redirect) {
    return this.tokenFrom(await http('https://open.tiktokapis.com/v2/oauth/token/', form({
      client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: redirect,
    })));
  },
  async refresh(env, tok) {
    if (tok.expires_at - Date.now() > 10 * 60000) return tok;
    return this.tokenFrom(await http('https://open.tiktokapis.com/v2/oauth/token/', form({
      client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: tok.refresh_token,
    })));
  },
  async fetch(env, tok, now, meta) {
    const auth = { authorization: `Bearer ${tok.access_token}` };
    const info = await http('https://open.tiktokapis.com/v2/user/info/?fields=display_name,follower_count,likes_count,video_count', { headers: auth });
    if (info.error && info.error.code !== 'ok') throw new Error(`TikTok: ${info.error.message || info.error.code}`);
    const u = info.data.user;
    const today = localDate(now), yesterday = localDate(now, -1);
    const out = [{ m: 'followers', d: today, v: u.follower_count }, { m: 'likes', d: today, v: u.likes_count }];

    // Video-Aufrufe: Summe view_count aller Videos; Tageswert = Differenz zum Vortag
    let total = 0, cursor, pages = 0, complete = true;
    do {
      const r = await http('https://open.tiktokapis.com/v2/video/list/?fields=id,view_count', {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(cursor ? { max_count: 20, cursor } : { max_count: 20 }),
      });
      for (const v of r.data?.videos || []) total += v.view_count || 0;
      cursor = r.data?.has_more ? r.data.cursor : undefined;
      if (++pages >= 50 && cursor) { complete = false; break; }
    } while (cursor);

    if (complete) {
      const prev = meta.tiktokViews;
      if (prev && prev.d < today) {
        const days = Math.round((Date.parse(today) - Date.parse(prev.d)) / 86400000);
        const delta = total - prev.total;
        if (days === 1 && delta >= 0) out.push({ m: 'views', d: yesterday, v: delta });
      }
      if (!prev || prev.d < today) meta.tiktokViews = { d: today, total };
    }
    return { values: out, account: u.display_name };
  },
};

// ---------------------------------------------------------------------------
// Provider: SoundCloud (OAuth 2.1 mit PKCE, Artist Pro nötig)
// ---------------------------------------------------------------------------
const soundcloud = {
  configured: (env) => !!(env.SC_CLIENT_ID && env.SC_CLIENT_SECRET),
  pkce: true,
  authUrl(env, redirect, state, challenge) {
    const u = new URL('https://secure.soundcloud.com/authorize');
    u.search = new URLSearchParams({
      client_id: env.SC_CLIENT_ID, redirect_uri: redirect, response_type: 'code', state,
      code_challenge: challenge, code_challenge_method: 'S256',
    });
    return u.toString();
  },
  tokenFrom(r) {
    return { access_token: r.access_token, refresh_token: r.refresh_token, expires_at: Date.now() + (r.expires_in || 3600) * 1000 };
  },
  async exchange(env, code, redirect, verifier) {
    return this.tokenFrom(await http('https://secure.soundcloud.com/oauth/token', form({
      grant_type: 'authorization_code', client_id: env.SC_CLIENT_ID, client_secret: env.SC_CLIENT_SECRET,
      redirect_uri: redirect, code_verifier: verifier, code,
    })));
  },
  async refresh(env, tok) {
    if (tok.expires_at - Date.now() > 5 * 60000) return tok;
    // Refresh-Token ist nur einmal gültig → neues sofort speichern (macht der Aufrufer)
    return this.tokenFrom(await http('https://secure.soundcloud.com/oauth/token', form({
      grant_type: 'refresh_token', client_id: env.SC_CLIENT_ID, client_secret: env.SC_CLIENT_SECRET, refresh_token: tok.refresh_token,
    })));
  },
  async fetch(env, tok, now) {
    const headers = { authorization: `OAuth ${tok.access_token}`, accept: 'application/json; charset=utf-8' };
    const me = await http('https://api.soundcloud.com/me', { headers });
    let plays = 0, likes = 0, url = 'https://api.soundcloud.com/me/tracks?linked_partitioning=true&limit=200', pages = 0;
    while (url && pages++ < 20) {
      const r = await http(url, { headers });
      const list = Array.isArray(r) ? r : r.collection || [];
      for (const t of list) { plays += t.playback_count || 0; likes += t.likes_count ?? t.favoritings_count ?? 0; }
      url = Array.isArray(r) ? null : r.next_href;
    }
    const today = localDate(now);
    return {
      values: [{ m: 'followers', d: today, v: me.followers_count }, { m: 'plays', d: today, v: plays }, { m: 'likes', d: today, v: likes }],
      account: me.username,
    };
  },
};

const IMPL = { instagram, tiktok, soundcloud };

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------
export async function sync(env, only, now = Date.now()) {
  const data = await getJSON(env, 'data', { entries: {} });
  const meta = await getJSON(env, 'meta', { results: {} });
  const results = {};
  for (const p of only ? [only] : PROVIDERS) {
    const tok = await getJSON(env, `tokens:${p}`, null);
    if (!tok) { results[p] = { ok: false, linked: false }; continue; }
    try {
      const fresh = await IMPL[p].refresh(env, tok);
      if (fresh !== tok) await putJSON(env, `tokens:${p}`, fresh);
      const { values, account } = await IMPL[p].fetch(env, fresh, now, meta);
      let n = 0;
      for (const { m, d, v } of values) if (typeof v === 'number' && isFinite(v)) { data.entries[`${p}|${m}|${d}`] = v; n++; }
      results[p] = { ok: true, linked: true, values: n, account, at: new Date(now).toISOString() };
    } catch (e) {
      results[p] = { ok: false, linked: true, error: String(e.message || e), at: new Date(now).toISOString() };
    }
  }
  data.updated = new Date(now).toISOString();
  meta.results = { ...meta.results, ...results };
  meta.lastRun = data.updated;
  await putJSON(env, 'data', data);
  await putJSON(env, 'meta', meta);
  return results;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const c = cors(env);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });

    if (path === '/') return new Response('Artist Hub Sync läuft.', { headers: { 'content-type': 'text/plain; charset=utf-8' } });

    if (path === '/data' || path === '/status' || path === '/sync') {
      if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401, c);
      if (path === '/data' && req.method === 'GET') return json(await getJSON(env, 'data', { entries: {} }), 200, c);
      if (path === '/status' && req.method === 'GET') {
        const meta = await getJSON(env, 'meta', { results: {} });
        const providers = {};
        for (const p of PROVIDERS) providers[p] = { configured: IMPL[p].configured(env), linked: !!(await env.HUB.get(`tokens:${p}`)), last: meta.results[p] || null };
        return json({ lastRun: meta.lastRun || null, providers }, 200, c);
      }
      if (path === '/sync' && req.method === 'POST') return json(await sync(env), 200, c);
      return json({ error: 'method not allowed' }, 405, c);
    }

    const m = path.match(/^\/auth\/(instagram|tiktok|soundcloud)\/(start|callback)$/);
    if (m) {
      const [, p, step] = m;
      const impl = IMPL[p];
      const redirect = `${url.origin}/auth/${p}/callback`;
      if (!impl.configured(env)) return html('Nicht eingerichtet', `<h1>${p} ist nicht eingerichtet</h1><p>Client-ID/Secret fehlen als Worker-Secrets.</p>`, 400);

      if (step === 'start') {
        if (!appKey(env) || !safeEqual((url.searchParams.get('key') || '').trim(), appKey(env))) return html('Kein Zugriff', '<h1>Kein Zugriff</h1><p>Falscher oder fehlender Schlüssel.</p>', 401);
        const state = randomString(24);
        const verifier = impl.pkce ? randomString(48) : null;
        await putJSON(env, `state:${state}`, { p, verifier }, { expirationTtl: 600 });
        const challenge = verifier ? await sha256b64url(verifier) : undefined;
        return Response.redirect(impl.authUrl(env, redirect, state, challenge), 302);
      }

      // callback
      const err = url.searchParams.get('error') || url.searchParams.get('error_description');
      if (err) return html('Abgebrochen', `<h1>Verbindung abgebrochen</h1><p>${escapeHtml(err)}</p>`, 400);
      const state = url.searchParams.get('state') || '';
      const saved = await getJSON(env, `state:${state}`, null);
      if (!saved || saved.p !== p) return html('Ungültig', '<h1>Ungültige oder abgelaufene Anfrage</h1><p>Bitte in der App erneut auf „Verbinden“ tippen.</p>', 400);
      await env.HUB.delete(`state:${state}`);
      try {
        const tok = await impl.exchange(env, url.searchParams.get('code') || '', redirect, saved.verifier);
        await putJSON(env, `tokens:${p}`, tok);
        const r = await sync(env, p);
        const info = r[p]?.ok ? `Erster Abruf erfolgreich (${r[p].values} Werte${r[p].account ? `, Konto ${escapeHtml(r[p].account)}` : ''}).` : `Verbunden, aber der erste Abruf schlug fehl: ${escapeHtml(r[p]?.error || '')}`;
        return html('Verbunden', `<h1>${p} verbunden ✓</h1><p>${info}</p><p><a href="${escapeHtml(env.APP_URL || '/')}">Zurück zur App</a></p>`);
      } catch (e) {
        return html('Fehler', `<h1>Verbindung fehlgeschlagen</h1><p>${escapeHtml(String(e.message || e))}</p>`, 502);
      }
    }

    return json({ error: 'not found' }, 404, c);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sync(env));
  },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
