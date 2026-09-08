/**
 * Vehicle Call Alert — wake-up server.
 *
 * A tiny Cloudflare Worker that turns "somebody scanned a QR code" into a high priority
 * Firebase push, so the Android app only has to run while a call is actually happening.
 *
 * Endpoints
 *   POST /register    { plate, token, platform }  -> remembers which phone owns a plate
 *   POST /unregister  { plate, token }            -> forgets it
 *   POST /ring        { plate }                   -> wakes that phone ("ring" push)
 *   POST /cancel      { plate }                   -> caller gave up (missed-call push)
 *   GET  /status?plate=XX                         -> { reachable: true|false }
 *   GET  /health
 *
 * Storage: one Workers KV namespace (free tier). Nothing personal is stored — only the
 * uppercase plate, the FCM token and a timestamp.
 */

const PLATE_RE = /^[A-Z0-9]{4,20}$/;
const RING_COOLDOWN_SECONDS = 4;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 180; // re-registered by the app on every launch

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }), request, env);
    }

    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'GET /health':
          return cors(json({ ok: true, service: 'vehicle-call-alert-wake' }), request, env);
        case 'GET /status':
          return cors(await status(url, env), request, env);
        case 'POST /register':
          return cors(await register(request, env), request, env);
        case 'POST /unregister':
          return cors(await unregister(request, env), request, env);
        case 'POST /ring':
          return cors(await ring(request, env, 'ring'), request, env);
        case 'POST /cancel':
          return cors(await ring(request, env, 'cancel'), request, env);
        default:
          return cors(json({ ok: false, error: 'not_found' }, 404), request, env);
      }
    } catch (err) {
      return cors(json({ ok: false, error: 'server_error', detail: String(err && err.message) }, 500), request, env);
    }
  }
};

/* ------------------------------------------------------------------ handlers */

async function register(request, env) {
  const body = await readJson(request);
  const plate = normalizePlate(body.plate);
  const token = String(body.token || '').trim();

  if (!plate) return json({ ok: false, error: 'bad_plate' }, 400);
  if (token.length < 20 || token.length > 4096) return json({ ok: false, error: 'bad_token' }, 400);

  await env.TOKENS.put(
    `plate:${plate}`,
    JSON.stringify({ token, platform: String(body.platform || 'android'), updated: Date.now() }),
    { expirationTtl: TOKEN_TTL_SECONDS }
  );
  return json({ ok: true, plate });
}

async function unregister(request, env) {
  const body = await readJson(request);
  const plate = normalizePlate(body.plate);
  if (!plate) return json({ ok: false, error: 'bad_plate' }, 400);

  const record = await readRecord(env, plate);
  // Only the phone that owns the registration may remove it.
  if (record && body.token && record.token !== body.token) {
    return json({ ok: true, plate, kept: true });
  }
  await env.TOKENS.delete(`plate:${plate}`);
  return json({ ok: true, plate });
}

async function status(url, env) {
  const plate = normalizePlate(url.searchParams.get('plate'));
  if (!plate) return json({ ok: false, error: 'bad_plate' }, 400);
  const record = await readRecord(env, plate);
  return json({ ok: true, plate, reachable: !!record });
}

async function ring(request, env, type) {
  const body = await readJson(request);
  const plate = normalizePlate(body.plate);
  if (!plate) return json({ ok: false, error: 'bad_plate' }, 400);

  const record = await readRecord(env, plate);
  if (!record) {
    // Nobody registered this plate: the owner never turned the vehicle online.
    return json({ ok: false, error: 'not_registered', reachable: false }, 404);
  }

  if (type === 'ring') {
    const cooldownKey = `cooldown:${plate}`;
    if (await env.TOKENS.get(cooldownKey)) {
      return json({ ok: true, plate, throttled: true });
    }
    await env.TOKENS.put(cooldownKey, '1', { expirationTtl: RING_COOLDOWN_SECONDS });
  }

  const result = await sendPush(env, record.token, {
    type,
    plate,
    ts: String(Date.now())
  });

  if (result.unregistered) {
    await env.TOKENS.delete(`plate:${plate}`);
    return json({ ok: false, error: 'not_registered', reachable: false }, 404);
  }
  if (!result.ok) {
    return json({ ok: false, error: 'push_failed', detail: result.detail }, 502);
  }
  return json({ ok: true, plate, sent: true });
}

/* ------------------------------------------------------------------ Firebase */

async function sendPush(env, token, data) {
  const account = serviceAccount(env);
  const accessToken = await accessTokenFor(env, account);

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: {
          token,
          data,
          android: {
            priority: 'HIGH',
            ttl: '120s'
          }
        }
      })
    }
  );

  if (response.ok) {
    return { ok: true };
  }
  const detail = await response.text();
  const unregistered =
    response.status === 404 ||
    detail.includes('UNREGISTERED') ||
    detail.includes('INVALID_ARGUMENT');
  return { ok: false, unregistered, detail: detail.slice(0, 300) };
}

function serviceAccount(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT secret is missing');
  }
  return typeof env.FIREBASE_SERVICE_ACCOUNT === 'string'
    ? JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)
    : env.FIREBASE_SERVICE_ACCOUNT;
}

/** OAuth2 access token for the FCM HTTP v1 API, cached in KV for 50 minutes. */
async function accessTokenFor(env, account) {
  const cached = await env.TOKENS.get('oauth:access_token');
  if (cached) {
    return cached;
  }

  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const header = { alg: 'RS256', typ: 'JWT' };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const key = await importPrivateKey(account.private_key);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64urlBytes(new Uint8Array(signature))}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  if (!response.ok) {
    throw new Error(`oauth failed: ${(await response.text()).slice(0, 200)}`);
  }
  const payload = await response.json();
  await env.TOKENS.put('oauth:access_token', payload.access_token, { expirationTtl: 3000 });
  return payload.access_token;
}

async function importPrivateKey(pem) {
  const body = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const binary = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    binary.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/* ------------------------------------------------------------------ helpers */

async function readRecord(env, plate) {
  const raw = await env.TOKENS.get(`plate:${plate}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (e) {
    return {};
  }
}

function normalizePlate(value) {
  const plate = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return PLATE_RE.test(plate) ? plate : '';
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function cors(response, request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
  const origin = request.headers.get('Origin') || '';
  const value = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0] || '');

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', value);
  headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, headers });
}

function base64url(text) {
  return base64urlBytes(new TextEncoder().encode(text));
}

function base64urlBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
