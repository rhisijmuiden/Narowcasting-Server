'use strict';
// YouTube and Facebook accounts for outputs. Both are linked with a device code: the panel shows a
// short code that the user enters on google.com/device or facebook.com/device, so no public HTTPS
// address is needed. Tokens stay in the database and are never sent to the browser.
//
// YouTube: a Google Cloud OAuth client of type "TVs and Limited Input devices" with the YouTube
// Data API v3 enabled. Facebook: a Meta app with Facebook Login for Devices switched on.
const store = require('./store');

// Overridable for tests.
const GOOGLE_OAUTH = process.env.BK_GOOGLE_OAUTH_URL || 'https://oauth2.googleapis.com';
const YOUTUBE_API = process.env.BK_YOUTUBE_API_URL || 'https://www.googleapis.com/youtube/v3';
const GRAPH = process.env.BK_FACEBOOK_GRAPH_URL || 'https://graph.facebook.com/v19.0';
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';
const FACEBOOK_SCOPE = 'public_profile,publish_video,pages_show_list,pages_read_engagement,pages_manage_posts';

const pending = new Map(); // linking id -> { provider, deviceCode, interval, expiresAt, state, error, accountId }

function keys() {
  return store.getSection('connections');
}

async function request(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const e = data.error;
    const msg = (e && (e.message || e.error_user_msg || (typeof e === 'string' && (data.error_description || e)))) || data.error_description || `HTTP ${res.status}`;
    const err = new Error(String(msg));
    err.status = res.status;
    err.code = (e && (e.errors && e.errors[0] && e.errors[0].reason)) || (typeof e === 'string' ? e : e && e.code);
    err.data = data;
    throw err;
  }
  return data;
}
const form = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v != null));

// ---------- linking ----------
async function startLinking(provider) {
  const k = keys();
  let p;
  if (provider === 'youtube') {
    if (!k.googleClientId || !k.googleClientSecret) throw new Error('Enter the Google client ID and secret first');
    const d = await request(`${GOOGLE_OAUTH}/device/code`, { method: 'POST', body: form({ client_id: k.googleClientId, scope: YOUTUBE_SCOPE }) });
    p = { provider, deviceCode: d.device_code, userCode: d.user_code, url: d.verification_url || d.verification_uri, interval: d.interval || 5, expiresAt: Date.now() + d.expires_in * 1000 };
  } else if (provider === 'facebook') {
    if (!k.facebookAppId || !k.facebookClientToken) throw new Error('Enter the Facebook app ID and client token first');
    const d = await request(`${GRAPH}/device/login`, { method: 'POST', body: form({ access_token: `${k.facebookAppId}|${k.facebookClientToken}`, scope: FACEBOOK_SCOPE }) });
    p = { provider, deviceCode: d.code, userCode: d.user_code, url: d.verification_uri, interval: d.interval || 5, expiresAt: Date.now() + d.expires_in * 1000 };
  } else throw new Error('Unknown provider');
  const id = store.id();
  Object.assign(p, { id, state: 'waiting' });
  pending.set(id, p);
  poll(p);
  return publicLinking(p);
}

function publicLinking(p) {
  return p && { id: p.id, provider: p.provider, userCode: p.userCode, url: p.url, state: p.state, error: p.error || null, accountId: p.accountId || null };
}

function linkingStatus(id) {
  return publicLinking(pending.get(id));
}

function cancelLinking(id) {
  const p = pending.get(id);
  if (p) p.state = 'cancelled';
  pending.delete(id);
}

// Polls the token endpoint until the user has entered the code, it expires or is cancelled.
function poll(p) {
  setTimeout(async () => {
    if (p.state !== 'waiting') return;
    if (Date.now() > p.expiresAt) { p.state = 'expired'; p.error = 'The code expired. Start again.'; return; }
    try {
      const account = p.provider === 'youtube' ? await pollGoogle(p) : await pollFacebook(p);
      if (account) {
        const existing = store.list('accounts').find((a) => a.provider === p.provider && a.externalId === account.externalId);
        const saved = existing ? store.update('accounts', existing.id, account) : store.create('accounts', account);
        p.state = 'linked';
        p.accountId = saved.id;
        setTimeout(() => pending.delete(p.id), 10 * 60 * 1000);
        return;
      }
    } catch (err) {
      if (err.slowDown) p.interval += 5;
      else { p.state = 'error'; p.error = err.message; return; }
    }
    poll(p);
  }, p.interval * 1000);
}

async function pollGoogle(p) {
  const k = keys();
  let t;
  try {
    t = await request(`${GOOGLE_OAUTH}/token`, { method: 'POST', body: form({ client_id: k.googleClientId, client_secret: k.googleClientSecret, device_code: p.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) });
  } catch (err) {
    if (err.code === 'authorization_pending') return null;
    if (err.code === 'slow_down') { err.slowDown = true; throw err; }
    if (err.code === 'access_denied') throw new Error('Access was denied on the Google page');
    throw err;
  }
  const account = { provider: 'youtube', refreshToken: t.refresh_token, accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
  const ch = await request(`${YOUTUBE_API}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${t.access_token}` } });
  const channel = ch.items && ch.items[0];
  if (!channel) throw new Error('This Google account has no YouTube channel');
  return { ...account, externalId: channel.id, name: channel.snippet.title };
}

async function pollFacebook(p) {
  const k = keys();
  let t;
  try {
    t = await request(`${GRAPH}/device/login_status`, { method: 'POST', body: form({ access_token: `${k.facebookAppId}|${k.facebookClientToken}`, code: p.deviceCode }) });
  } catch (err) {
    const sub = err.data && err.data.error && err.data.error.error_subcode;
    if (sub === 1349174) return null; // authorization pending
    if (sub === 1349172) { err.slowDown = true; throw err; }
    if (sub === 1349152) throw new Error('The code expired. Start again.');
    throw err;
  }
  if (!t.access_token) return null;
  const me = await request(`${GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(t.access_token)}`);
  return { provider: 'facebook', accessToken: t.access_token, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : null, externalId: me.id, name: me.name };
}

// ---------- tokens ----------
async function googleToken(account) {
  if (account.accessToken && account.expiresAt > Date.now()) return account.accessToken;
  const k = keys();
  let t;
  try {
    t = await request(`${GOOGLE_OAUTH}/token`, { method: 'POST', body: form({ client_id: k.googleClientId, client_secret: k.googleClientSecret, refresh_token: account.refreshToken, grant_type: 'refresh_token' }) });
  } catch (err) {
    throw new Error(err.code === 'invalid_grant' ? 'The YouTube link has expired. Connect the account again.' : `YouTube sign-in failed: ${err.message}`);
  }
  store.update('accounts', account.id, { accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 });
  return t.access_token;
}

// ---------- going live ----------
// Returns { url, watchUrl, ref } for the output; ref is passed back to stop().
async function goLive(output) {
  const account = store.get('accounts', output.accountId);
  if (!account) throw new Error('Choose a connected account for this output');
  return output.type === 'youtube' ? youtubeLive(output, account) : facebookLive(output, account);
}

async function youtubeLive(output, account) {
  const token = await googleToken(account);
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const yt = (path, body, method = 'POST') => request(`${YOUTUBE_API}/${path}`, { method, headers: auth, body: body && JSON.stringify(body) }).catch((err) => {
    if (err.code === 'liveStreamingNotEnabled' || err.code === 'livePermissionBlocked') throw new Error('Live streaming is not enabled on this YouTube channel. Enable it at youtube.com/features.');
    throw new Error(`YouTube: ${err.message}`);
  });
  // One reusable stream (stream key) per output; a new broadcast each time the output starts.
  let streamId = output.youtubeStreamId;
  let ingest = null;
  if (streamId) {
    const found = await yt(`liveStreams?part=cdn&id=${streamId}`, null, 'GET');
    ingest = found.items && found.items[0] && found.items[0].cdn.ingestionInfo;
  }
  if (!ingest) {
    const created = await yt('liveStreams?part=snippet,cdn,contentDetails', {
      snippet: { title: `Beeldkrant: ${output.name}` },
      cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
      contentDetails: { isReusable: true },
    });
    streamId = created.id;
    ingest = created.cdn.ingestionInfo;
    store.update('outputs', output.id, { youtubeStreamId: streamId });
  }
  const broadcast = await yt('liveBroadcasts?part=snippet,status,contentDetails', {
    snippet: { title: output.title || output.name, description: output.description || '', scheduledStartTime: new Date().toISOString() },
    status: { privacyStatus: ['public', 'unlisted', 'private'].includes(output.privacy) ? output.privacy : 'unlisted', selfDeclaredMadeForKids: false },
    contentDetails: { enableAutoStart: true, enableAutoStop: true, latencyPreference: 'normal' },
  });
  await yt(`liveBroadcasts/bind?part=id&id=${broadcast.id}&streamId=${streamId}`);
  const base = ingest.rtmpsIngestionAddress || ingest.ingestionAddress;
  return { url: `${base.replace(/\/$/, '')}/${ingest.streamName}`, watchUrl: `https://youtu.be/${broadcast.id}`, ref: broadcast.id };
}

async function facebookLive(output, account) {
  let token = account.accessToken;
  let target = 'me';
  if (output.facebookPageId) {
    const pages = await facebookPages(account);
    const page = pages.find((p) => p.id === output.facebookPageId);
    if (!page) throw new Error('This Facebook page is no longer available to the connected account');
    token = page.accessToken;
    target = page.id;
  }
  const live = await request(`${GRAPH}/${target}/live_videos`, {
    method: 'POST',
    body: form({ status: 'LIVE_NOW', title: output.title || output.name, description: output.description || '', access_token: token }),
  }).catch((err) => { throw new Error(`Facebook: ${err.message}`); });
  return { url: live.secure_stream_url || live.stream_url, watchUrl: `https://www.facebook.com/${live.id}`, ref: { id: live.id, token } };
}

async function facebookPages(account) {
  const data = await request(`${GRAPH}/me/accounts?fields=id,name,access_token&limit=100&access_token=${encodeURIComponent(account.accessToken)}`);
  return (data.data || []).map((p) => ({ id: p.id, name: p.name, accessToken: p.access_token }));
}

// Ends the broadcast or live video that goLive started. Best effort.
async function stop(output, ref) {
  if (!ref) return;
  const account = store.get('accounts', output.accountId);
  if (!account) return;
  if (output.type === 'youtube') {
    const token = await googleToken(account);
    await request(`${YOUTUBE_API}/liveBroadcasts/transition?part=status&broadcastStatus=complete&id=${ref}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  } else {
    await request(`${GRAPH}/${ref.id}`, { method: 'POST', body: form({ end_live_video: 'true', access_token: ref.token }) });
  }
}

module.exports = { startLinking, linkingStatus, cancelLinking, goLive, stop, facebookPages, YOUTUBE_SCOPE, FACEBOOK_SCOPE };
