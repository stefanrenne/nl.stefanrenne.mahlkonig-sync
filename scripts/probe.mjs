#!/usr/bin/env node
// Probe the Mahlkönig Sync mobile API (the one the app uses) to answer the open questions in
// TODO.md and docs/sync-api.md, and run the app's own SyncClient against the live cloud.
//
// Read-only: it logs in and makes about 15 requests. Credentials come from MK_EMAIL /
// MK_PASSWORD, or are asked for interactively (the password is not echoed). They are never
// written to disk or printed.
//
// The report (probe-output/probe-<timestamp>.json, gitignored) is redacted: personal and hardware
// identifiers are replaced by stable aliases such as "<id:3>", so equal values stay recognisable
// without revealing them. Look through it before sharing it anyway.
//
// Usage (Node 24 or later: it imports lib/SyncClient.mts directly):
//   node scripts/probe.mjs
//   node scripts/probe.mjs --bad-login   # also try one deliberately wrong password (Q1)

import { mkdir, writeFile } from 'node:fs/promises';
import { SyncClient } from '../lib/SyncClient.mts';

const BASE_URL = 'https://sync.mahlkoenig.com/api';
const DAY_MS = 24 * 60 * 60_000;
const PURGE_BELOW_G = 5;

// Keys whose values identify a person, account or device. Matched case-insensitively, plus any
// key ending in a device/user/organisation id (toBrewerId, fromDeviceId, …).
const REDACT_KEYS = new Set([
  'user', 'username', 'email', 'mail', 'name', 'firstname', 'lastname', 'fullname',
  'phone', 'address', 'street', 'city', 'zip', 'postalcode', 'serial', 'serialnumber',
  'bindingcode', 'hmihwproductid', 'macaddress', 'mac', 'ip', 'key', 'profileid',
  'password', 'secret', 'access_token', 'accesstoken', 'refresh_token', 'refreshtoken',
  'token', 'id_token', 'idtoken', 'jwt', 'sub', 'comp',
]);
const ID_KEY_RE = /(device|grinder|brewer|store|company|region|user|profile|account)ids?$/i;
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
  if (REDACT_KEYS.has(key.toLowerCase()) || ID_KEY_RE.test(key)) return alias(value);
  if (typeof value === 'string' && JWT_RE.test(value) && value.length > 40) return alias(value, 'jwt');
  if (typeof value === 'string' && EMAIL_RE.test(value)) return alias(value, 'email');
  return value;
}

function decodeJwt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return {
      claims: Object.keys(payload),
      lifetimeSeconds: typeof payload.exp === 'number' && typeof payload.iat === 'number' ? payload.exp - payload.iat : null,
    };
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

// Every leaf path across all records, with types, how often present, and up to 8 distinct
// example values (already redacted records only).
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
  for (const [k, v] of headers) out[k] = SENSITIVE_HEADERS.has(k) ? '<redacted>' : v;
  return out;
}

async function request(path, body, token, method = 'POST') {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const started = Date.now();
  let res;
  try {
    res = await fetch(BASE_URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    return { networkError: String(err?.cause ?? err), ms: Date.now() - started };
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, ms: Date.now() - started, headers: interestingHeaders(res.headers), json, text: json === undefined ? text.slice(0, 500) : undefined };
}

function itemsOf(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.items)) return json.items;
  return null;
}

// The mobile app's query shape for grind-event/find and device-event/brew-event/find.
function eventQuery(deviceId, days) {
  return {
    deviceDateRange: { from: new Date(Date.now() - days * DAY_MS).toISOString(), to: new Date(Date.now() + 5 * 60_000).toISOString() },
    orderBy: 'deviceDate', orderDir: 'DESC', loadDevice: false,
    deviceIds: [deviceId], storeIds2: null, storeIds: null, regionIds: null, companyIds: null,
  };
}

function deviceUnionQuery(deviceClass) {
  return {
    pager: null, keyword: null, orderBy: 'change.date', orderDir: 'DESC',
    loadStore: true, loadBindings: true, excludeTypes: ['xenia'], deviceClasses: [deviceClass],
  };
}

const distinct = (values) => [...new Set(values.map((v) => (v === undefined ? '<missing>' : v)))];
const countBy = (values) => values.reduce((acc, v) => ({ ...acc, [String(v)]: (acc[String(v)] ?? 0) + 1 }), {});

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
  if (!email || !password) {
    console.error('E-mail and password are required.');
    process.exit(1);
  }

  const report = { probedAt: new Date().toISOString(), node: process.version, steps: {} };
  const log = (msg) => console.log(`• ${msg}`);

  // Q1: what a rejected login looks like (opt-in, to avoid tripping lockouts).
  if (process.argv.includes('--bad-login')) {
    const bad = await request('/security-service/auth/token', { username: email, password: `${password}-wrong` });
    report.steps.badLogin = { status: bad.status, body: redact(bad.json ?? bad.text) };
    log(`wrong password → HTTP ${bad.status ?? bad.networkError}`);
  }

  // Login: shape and token lifetime.
  const login = await request('/security-service/auth/token', { username: email, password });
  const token = login.json?.access_token;
  report.steps.login = {
    status: login.status, networkError: login.networkError,
    bodyShape: shape(login.json ?? login.text), jwt: token ? decodeJwt(token) : null,
  };
  log(`login → HTTP ${login.status ?? login.networkError}${token ? '' : ' (no access_token)'}`);
  if (!token) {
    await save(report);
    process.exit(1);
  }
  const companyId = login.json.details?.comp;

  // The account.
  const profile = await request('/mobile-service/profile/my-profile', undefined, token, 'GET');
  report.steps.profile = { status: profile.status, companyType: profile.json?.company?.type ?? null, shape: shape(profile.json) };

  // Devices: the mobile list per class (Q9: does GRINDER work for pairing?) and the admin list
  // the app uses for pairing today.
  const devices = {};
  for (const deviceClass of ['GRINDER', 'SCALE']) {
    const res = await request('/mobile-service/device-union/query', deviceUnionQuery(deviceClass), token);
    const items = itemsOf(res.json) ?? [];
    devices[deviceClass] = items;
    report.steps[`deviceUnion${deviceClass}`] = { status: res.status, count: items.length, records: redact(items) };
    log(`device-union ${deviceClass} → HTTP ${res.status ?? res.networkError}, ${items.length} devices`);
  }
  const admin = await request('/admin-service/device/query', { companyId, loadStatus: true, loadBindings: true, pager: { firstResult: 0, pageSize: 50 } }, token);
  const adminItems = itemsOf(admin.json) ?? [];
  report.steps.adminDevices = { status: admin.status, count: adminItems.length, types: adminItems.map((d) => d.type) };
  log(`admin device/query → HTTP ${admin.status ?? admin.networkError}, ${adminItems.length} devices`);

  const grinderIds = distinct([...devices.GRINDER, ...adminItems.filter((d) => d.type !== 'scale')].map((d) => d.deviceId)).filter((id) => id !== '<missing>');
  const scaleIds = distinct(devices.SCALE.map((d) => d.deviceId)).filter((id) => id !== '<missing>');

  // Per grinder: the status block and 7 days of grinds (Q6 value sets, unweighed grinds, purges).
  report.steps.grinders = [];
  for (const grinderId of grinderIds) {
    const status = await request(`/mobile-service/device/?key=${encodeURIComponent(grinderId)}`, undefined, token, 'GET');
    const grinds = await request('/mobile-service/grind-event/find', eventQuery(grinderId, 7), token);
    const events = itemsOf(grinds.json) ?? [];
    const payloads = events.map((e) => e.payload ?? {});
    const weights = payloads.map((p) => p.weightActual);
    report.steps.grinders.push({
      grinder: alias(grinderId),
      status: { http: status.status, record: redact(status.json?.status ?? null) },
      grinds: {
        http: grinds.status,
        count7d: events.length,
        count24h: events.filter((e) => Date.now() - Date.parse(e.deviceDate) <= DAY_MS).length,
        unweighed: weights.filter((w) => w === 0).length,
        purgesBelow5g: weights.filter((w) => typeof w === 'number' && w > 0 && w < PURGE_BELOW_G * 1000).length,
        triggerMode: countBy(payloads.map((p) => p.triggerMode)),
        recipeMode: countBy(payloads.map((p) => p.recipeMode)),
        recipeType: countBy(payloads.map((p) => p.recipeType)),
        filterType: countBy(payloads.map((p) => p.filterType)),
        successful: countBy(payloads.map((p) => p.successful)),
        paths: pathSummary(events.map((e) => redact(e))),
      },
    });
    log(`grinder ${alias(grinderId)}: ${events.length} grinds in 7 days (${weights.filter((w) => w === 0).length} unweighed), `
      + `triggerMode ${JSON.stringify(countBy(payloads.map((p) => p.triggerMode)))}`);
  }

  // Per scale: 7 days of shots, every field (where does the official app's brew time target come from?).
  report.steps.scales = [];
  for (const scaleId of scaleIds) {
    const brews = await request('/mobile-service/device-event/brew-event/find', eventQuery(scaleId, 7), token);
    const events = itemsOf(brews.json) ?? [];
    report.steps.scales.push({
      scale: alias(scaleId),
      http: brews.status,
      count7d: events.length,
      stopType: countBy(events.map((e) => e.payload?.stopType)),
      paths: pathSummary(events.map((e) => redact(e))),
      newest: redact(events[0] ?? null),
    });
    log(`scale ${alias(scaleId)}: ${events.length} shots in 7 days`);
  }

  // Recipes and the on-target bands (for the brew time deviation and the colour rule).
  const recipes = await request('/mobile-service/cloud-recipe/query', { pager: null, status: ['PUBLISHED'], orderBy: 'change.date', orderDir: 'DESC' }, token);
  report.steps.recipes = { status: recipes.status, paths: pathSummary((itemsOf(recipes.json) ?? []).map((r) => redact(r))) };
  const thresholds = await request('/mobile-service/recipe-threshold/?key', undefined, token, 'GET');
  report.steps.recipeThreshold = { status: thresholds.status, body: thresholds.json ?? thresholds.text };
  const lastEvents = await request('/mobile-service/stats/event/last-events', { limitToCurrentDevice: true }, token);
  report.steps.lastEvents = { status: lastEvents.status, shape: shape(lastEvents.json) };

  // The app's own client, end to end, against the live cloud.
  const client = new SyncClient({ email, password });
  const clientRun = {};
  try {
    await client.login();
    const grinders = await client.listGrinders();
    const scales = await client.listScales();
    clientRun.grinders = grinders.length;
    clientRun.scales = scales.length;
    if (grinders[0]) {
      const now = Date.now();
      clientRun.grinds24h = (await client.findGrindEvents(grinders[0].deviceId, new Date(now - DAY_MS), new Date(now + 5 * 60_000))).length;
      clientRun.statusKeys = Object.keys((await client.getDevice(grinders[0].deviceId)).status?.status ?? {});
      const binding = await client.getScaleBinding(grinders[0].deviceId);
      clientRun.pairedScale = binding !== null;
      if (binding?.brewerId != null) {
        clientRun.shots24h = (await client.findBrewEvents(binding.brewerId, new Date(now - DAY_MS), new Date(now + 5 * 60_000))).length;
      }
    }
    clientRun.ok = true;
  } catch (error) {
    clientRun.ok = false;
    clientRun.error = `${error?.name}: ${error?.message}`;
  }
  report.steps.syncClient = clientRun;
  log(`app SyncClient → ${clientRun.ok ? 'ok' : `failed (${clientRun.error})`}: ${JSON.stringify(clientRun)}`);

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
