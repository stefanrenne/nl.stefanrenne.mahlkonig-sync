#!/usr/bin/env node
// Probe the Mahlkönig Sync cloud API to answer the open questions in docs/sync-api.md.
//
// Read-only: it logs in and runs a handful of shot-history queries (about 7 requests).
// Credentials come from MK_EMAIL / MK_PASSWORD / MK_STORE_ID, or are asked for
// interactively (the password is not echoed). They are never written to disk or printed.
//
// The Store ID is optional. The login response carries the account's company id
// (details.comp), and the official dashboards accept that instead: the admin dashboard lists
// stores with POST /admin-service/store/query-managed {companyId}, and the chart app sends
// the shot-history query with either storeId or companyId. Store names and ids found that
// way are printed to the console only; the report aliases them.
//
// The output (probe-output/probe-<timestamp>.json, gitignored) is redacted: personal and
// hardware identifiers are replaced by stable aliases such as "<id:3>", so equal values
// stay recognisable without revealing them. Look through it before sharing it anyway.
//
// Usage:
//   node scripts/probe.mjs
//   node scripts/probe.mjs --bad-login   # also try one deliberately wrong password (Q1)

import { mkdir, writeFile } from 'node:fs/promises';

const BASE_URL = 'https://sync.mahlkoenig.com';
const AUTH_PATH = '/api/security-service/auth/token';
const QUERY_PATH = '/api/dashboard-service/shot-history/query';
// Found in the admin dashboard bundle (admin.sync.mahlkoenig.com, config.base.json + services).
const REFRESH_PATH = '/api/security-service/auth/refresh'; // GET, Bearer <refresh_token>
const STORES_PATH = '/api/admin-service/store/query-managed';
const DEVICES_PATH = '/api/admin-service/device/query';
const TOKEN_KEYS = ['access_token', 'accessToken', 'token', 'id_token', 'jwt'];

// Keys whose values identify a person, account or device. Matched case-insensitively.
const REDACT_KEYS = new Set([
  'user', 'username', 'email', 'mail', 'name', 'firstname', 'lastname', 'fullname',
  'phone', 'address', 'street', 'city', 'zip', 'postalcode',
  'serial', 'serialnumber', 'storeid', 'companyid', 'regionid', 'userid', 'accountid',
  'deviceid', 'grinderid', 'brewerid', 'bindingcode', 'hmihwproductid', 'macaddress', 'mac', 'ip',
  'password', 'secret', 'access_token', 'accesstoken', 'refresh_token', 'refreshtoken',
  'token', 'id_token', 'idtoken', 'jwt', 'sub', 'comp', 'storeids', 'deviceids', 'companyids',
]);
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const SENSITIVE_HEADERS = new Set(['set-cookie', 'cookie', 'authorization']);

const aliases = new Map();
function alias(value, kind = 'id') {
  const key = `${typeof value}:${value}`;
  if (!aliases.has(key)) aliases.set(key, `<${kind}:${aliases.size + 1}>`);
  return aliases.get(key);
}

function redact(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  if (REDACT_KEYS.has(key.toLowerCase())) return alias(value);
  if (typeof value === 'string' && JWT_RE.test(value) && value.length > 40) return alias(value, 'jwt');
  if (typeof value === 'string' && EMAIL_RE.test(value)) return alias(value, 'email');
  return value;
}

function parseJwt(token) {
  try {
    return token.split('.').slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

function decodeJwt(token) {
  try {
    const [header, payload] = parseJwt(token);
    const claims = {};
    for (const [k, v] of Object.entries(payload)) {
      // Keep timing claims readable, alias everything else.
      claims[k] = ['exp', 'iat', 'nbf', 'auth_time'].includes(k) ? v : redact(v, 'sub');
    }
    const lifetimeSeconds = typeof payload.exp === 'number' && typeof payload.iat === 'number'
      ? payload.exp - payload.iat : null;
    return { header, claims, lifetimeSeconds };
  } catch {
    return null;
  }
}

// Describe a value's shape without its content: key names, types and string lengths.
function shape(value) {
  if (Array.isArray(value)) return value.length ? [shape(value[0]), `…${value.length} items`] : [];
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]));
  }
  if (typeof value === 'string') return `string(${value.length})`;
  return value === null ? 'null' : typeof value;
}

// Every leaf path across all records, with types and up to 8 distinct example values.
function pathSummary(records) {
  const paths = {};
  const walk = (value, path) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    const entry = (paths[path] ??= { types: new Set(), examples: new Set(), present: 0 });
    entry.present += 1;
    entry.types.add(Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);
    if (entry.examples.size < 8) entry.examples.add(JSON.stringify(value)?.slice(0, 80));
  };
  records.forEach((r) => walk(r, ''));
  return Object.fromEntries(Object.entries(paths).sort().map(([p, e]) => [p, {
    types: [...e.types], present: `${e.present}/${records.length}`, examples: [...e.examples],
  }]));
}

function interestingHeaders(headers) {
  const out = {};
  for (const [k, v] of headers) {
    out[k] = SENSITIVE_HEADERS.has(k) ? '<redacted>' : v;
  }
  return out;
}

async function request(path, body, token, method = 'POST') {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const started = Date.now();
  let res;
  try {
    res = await fetch(BASE_URL + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return { networkError: String(err?.cause ?? err), ms: Date.now() - started };
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return {
    status: res.status,
    ms: Date.now() - started,
    headers: interestingHeaders(res.headers),
    json,
    text: json === undefined ? text.slice(0, 500) : undefined,
  };
}

// scope is { storeId } or { companyId }; the chart app sends whichever it has.
function queryBody(scope, { pageSize = 1, orderBy = 'brew.cloudDate', days = 7 } = {}) {
  return {
    ...scope,
    grinderId: null,
    cloudDate: { from: new Date(Date.now() - days * 86400_000).toISOString(), to: null },
    pager: { firstResult: 0, pageSize },
    orderBy,
    orderDir: 'DESC',
  };
}

function itemsOf(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.items)) return json.items;
  return null;
}

// Plain line input instead of readline: readline redraws the whole prompt on every key,
// which the terminal pane in the Claude app renders as a repeated prompt. Hidden input
// uses raw mode, so the password is not echoed.
let pendingInput = ''; // characters typed or pasted beyond the line being asked for

function ask(question, { hidden = false } = {}) {
  const { stdin, stdout } = process;
  stdout.write(question);
  return new Promise((resolve) => {
    let buffer = '';
    const raw = hidden && stdin.isTTY;
    const consume = () => {
      while (pendingInput) {
        const ch = pendingInput[0];
        pendingInput = pendingInput.slice(1);
        if (ch === '\u0003') { stdout.write('\n'); process.exit(130); }
        if (ch === '\r' || ch === '\n') {
          if (ch === '\r' && pendingInput[0] === '\n') pendingInput = pendingInput.slice(1);
          return true;
        }
        if (ch === '\u007f' || ch === '\b') buffer = buffer.slice(0, -1);
        else buffer += ch;
      }
      return false;
    };
    const finish = () => {
      stdin.off('data', onData);
      if (raw) stdin.setRawMode(false);
      stdin.pause();
      if (raw) stdout.write('\n');
      resolve(buffer.trim());
    };
    const onData = (chunk) => {
      pendingInput += chunk;
      if (consume()) finish();
    };
    if (consume()) { resolve(buffer.trim()); return; }
    if (raw) stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function main() {
  const email = process.env.MK_EMAIL || await ask('Sync e-mail: ');
  const password = process.env.MK_PASSWORD || await ask('Sync password: ', { hidden: true });
  const storeInput = process.env.MK_STORE_ID ?? await ask('Store ID (leave empty if unknown): ');
  let storeId = storeInput ? Number.parseInt(storeInput, 10) : null;
  if (!email || !password || (storeInput && !Number.isInteger(storeId))) {
    console.error('E-mail and password are required; the Store ID, if given, must be a number.');
    process.exit(1);
  }

  const report = { probedAt: new Date().toISOString(), node: process.version, steps: {} };
  const log = (msg) => console.log(`• ${msg}`);

  // Q1: what a rejected login looks like (opt-in, to avoid tripping lockouts).
  if (process.argv.includes('--bad-login')) {
    const bad = await request(AUTH_PATH, { username: email, password: `${password}-wrong` });
    report.steps.badLogin = { status: bad.status, headers: bad.headers, body: redact(bad.json ?? bad.text) };
    log(`wrong password → HTTP ${bad.status}`);
  }

  // Q1/Q2: login response shape and token lifetime.
  const login = await request(AUTH_PATH, { username: email, password });
  const tokenKey = TOKEN_KEYS.find((k) => login.json?.[k]);
  const token = tokenKey ? login.json[tokenKey] : undefined;
  report.steps.login = {
    status: login.status,
    ms: login.ms,
    networkError: login.networkError,
    headers: login.headers,
    bodyShape: shape(login.json ?? login.text),
    // Non-secret scalar fields (expires_in, token_type, …) shown as-is; secrets aliased.
    body: redact(login.json ?? login.text),
    tokenKey: tokenKey ?? null,
    jwt: token ? decodeJwt(token) : null,
  };
  log(`login → HTTP ${login.status ?? login.networkError}, token key: ${tokenKey ?? 'NOT FOUND'}`);
  if (!token) {
    await save(report);
    console.error('No token, stopping. The report above shows the login response shape.');
    process.exit(1);
  }

  // Q2: the refresh endpoint (the admin dashboard calls it with the refresh token).
  // Run last, because in the previous run the access token stopped working after it.
  let lastAcceptedQuery = null;
  async function runRefresh() {
    const refreshToken = login.json.refresh_token;
    if (!refreshToken) return;
    if (lastAcceptedQuery) {
      const before = await request(QUERY_PATH, lastAcceptedQuery, token);
      log(`access token just before refresh → HTTP ${before.status ?? before.networkError}`);
    }
    const refresh = await request(REFRESH_PATH, undefined, refreshToken, 'GET');
    report.steps.refresh = {
      status: refresh.status,
      networkError: refresh.networkError,
      bodyShape: shape(refresh.json ?? refresh.text),
      body: redact(refresh.json ?? refresh.text),
      newAccessToken: refresh.json?.access_token ? refresh.json.access_token !== token : null,
      newRefreshToken: refresh.json?.refresh_token ? refresh.json.refresh_token !== refreshToken : null,
    };
    log(`refresh → HTTP ${refresh.status ?? refresh.networkError}`);
    if (lastAcceptedQuery && refresh.json?.access_token) {
      const old = await request(QUERY_PATH, lastAcceptedQuery, token);
      const fresh = await request(QUERY_PATH, lastAcceptedQuery, refresh.json.access_token);
      report.steps.refresh.oldTokenAfterRefresh = old.status;
      report.steps.refresh.newTokenAfterRefresh = fresh.status;
      log(`after refresh: old token → HTTP ${old.status}, refreshed token → HTTP ${fresh.status}`);
    }
  }

  // Q8: the company id, and the stores it manages.
  const companyId = login.json.details?.comp;
  report.steps.companyId = { present: companyId != null, type: typeof companyId };
  let devicesRaw = [];
  if (companyId != null) {
    const stores = await request(STORES_PATH, {
      companyId, orderBy: 'info.name', orderDir: 'ASC', loadRegion: true,
      pager: { firstResult: 0, pageSize: 20 },
    }, token);
    const storeItems = itemsOf(stores.json);
    report.steps.stores = {
      status: stores.status,
      networkError: stores.networkError,
      envelope: stores.json && !Array.isArray(stores.json) ? Object.keys(stores.json) : null,
      count: storeItems?.length ?? null,
      records: storeItems ? redact(storeItems) : redact(stores.json ?? stores.text),
    };
    log(`stores for company → HTTP ${stores.status ?? stores.networkError}, ${storeItems?.length ?? 'no'} items`);
    if (storeItems?.length) {
      console.log('• stores (shown here only, not in the report):');
      for (const st of storeItems) console.log(`    storeId ${st.storeId}: ${st.info?.name ?? '?'}`);
      if (storeId === null && storeItems.length === 1 && Number.isInteger(storeItems[0].storeId)) {
        storeId = storeItems[0].storeId;
        log('using the only store for the store-based queries');
      }
    }

    // Q9: the grinders (and scales) registered to the company.
    const devices = await request(DEVICES_PATH, {
      companyId, loadStore: true, loadStatus: true, loadBindings: true,
      pager: { firstResult: 0, pageSize: 20 },
    }, token);
    devicesRaw = itemsOf(devices.json) ?? [];
    report.steps.devices = {
      status: devices.status,
      networkError: devices.networkError,
      envelope: devices.json && !Array.isArray(devices.json) ? Object.keys(devices.json) : null,
      count: itemsOf(devices.json)?.length ?? null,
      records: itemsOf(devices.json) ? redact(devicesRaw) : redact(devices.json ?? devices.text),
    };
    log(`devices for company → HTTP ${devices.status ?? devices.networkError}, ${devicesRaw.length} items`);
  }

  if (storeId === null && companyId == null) {
    await save(report);
    console.log('No store id and no company id, so the shot-history queries were skipped.');
    return;
  }

  // Q8/Q9: which scope does the shot-history query accept for this account? A home account
  // can have no store (its grinder hangs off the company), and the company alone gave 403.
  const grinderId = devicesRaw.find((d) => d?.type && d.type !== 'scale')?.deviceId ?? null;
  const variants = [
    ...(storeId !== null ? [['store', { storeId }, null]] : []),
    ['company', { companyId }, null],
    ...(grinderId != null ? [
      ['companyAndGrinder', { companyId }, grinderId],
      ['grinderOnly', {}, grinderId],
      ['companyAndGrinderAsString', { companyId }, String(grinderId)],
    ] : []),
    ['companyAsString', { companyId: String(companyId) }, null],
  ];
  report.steps.scopeVariants = {};
  let accepted = null;
  for (const [name, scope, gid] of variants) {
    const body = { ...queryBody(scope), grinderId: gid };
    const res = await request(QUERY_PATH, body, token);
    const items = itemsOf(res.json);
    report.steps.scopeVariants[name] = {
      request: redact(body),
      status: res.status,
      count: items?.length ?? null,
      body: items ? undefined : redact(res.json ?? res.text),
    };
    log(`shot-history with ${name} → HTTP ${res.status ?? res.networkError}${items ? `, ${items.length} items` : ''}`);
    if (!accepted && res.status === 200) {
      accepted = { name, scope, gid };
      lastAcceptedQuery = body;
    }
  }
  if (!accepted) {
    await runRefresh();
    await save(report);
    console.log('No scope was accepted by the shot-history query, so the detail queries were skipped.');
    return;
  }
  log(`using "${accepted.name}" for the detail queries`);
  const qb = (opts) => ({ ...queryBody(accepted.scope, opts), grinderId: accepted.gid });

  const queries = [
    // Q4/Q11/Q12: recent records, to see grinds without a brew and how they sort.
    ['byBrew20', qb({ pageSize: 20 })],
    // Q4: is sorting on the grind accepted, and does it return grinds the brew sort hides?
    ['byGrind20', qb({ pageSize: 20, orderBy: 'grind.cloudDate' })],
    // Q10: is a large page accepted?
    ['byBrew200', qb({ pageSize: 200, days: 30 })],
  ];

  for (const [name, body] of queries) {
    const res = await request(QUERY_PATH, body, token);
    const items = itemsOf(res.json);
    report.steps[name] = {
      request: redact(body),
      status: res.status,
      ms: res.ms,
      networkError: res.networkError,
      headers: res.headers,
      envelope: Array.isArray(res.json) ? 'array' : res.json && typeof res.json === 'object'
        ? { keys: Object.keys(res.json), nonItems: redact(Object.fromEntries(
          Object.entries(res.json).filter(([k]) => k !== 'items'))) }
        : res.text,
      count: items?.length ?? null,
    };
    log(`${name} → HTTP ${res.status ?? res.networkError}, ${items?.length ?? 'no'} items`);
    if (!items) continue;

    report.steps[name].timeline = items.map((r) => ({
      grindAt: r?.grind?.cloudDate ?? null,
      brewAt: r?.brew?.cloudDate ?? null,
      hasGrind: r?.grind != null,
      hasBrew: r?.brew != null,
      grindSeconds: typeof r?.grind?.payload?.durationActual === 'number' ? r.grind.payload.durationActual / 1000 : null,
      doseGrams: typeof r?.grind?.payload?.weightActual === 'number' ? r.grind.payload.weightActual / 1000 : null,
      grindEventUuid: r?.grind?.eventUuid ? alias(r.grind.eventUuid, 'uuid') : null,
      grinder: r?.grind?.deviceId != null ? alias(r.grind.deviceId) : null,
    }));
    if (name === 'byBrew20' || name === 'byGrind20') {
      report.steps[name].records = redact(items.slice(0, 5));
    }
    if (name === 'byBrew200') {
      report.steps[name].paths = pathSummary(items.map((r) => redact(r)));
    }
  }

  await runRefresh();
  await save(report);
}

async function save(report) {
  const dir = new URL('../probe-output/', import.meta.url);
  await mkdir(dir, { recursive: true });
  const file = new URL(`probe-${report.probedAt.replace(/[:.]/g, '-')}.json`, dir);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nReport written to ${file.pathname}`);
}

main().catch((err) => {
  console.error('Probe failed:', err?.message ?? err);
  process.exit(1);
});
