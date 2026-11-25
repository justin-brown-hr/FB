#!/usr/bin/env node
// Bid Assistant relay: lets B2 (your PC) talk to B1 (Chrome on the VPS) over HTTP.
// No dependencies. Easiest: sudo bash setup.sh   (or: node server.js — token is created in token.txt)
//
// Protocol (all requests need "Authorization: Bearer <token>", JSON bodies):
//   B2  POST /api/jobs                {text}            -> {id}
//   B2  GET  /api/jobs/:id?since=N    (long-poll 25 s)  -> {id, state, status, bid, error, version}
//   B1  GET  /api/next                (long-poll 25 s)  -> {id, text}   or 204 when nothing to do
//   B1  POST /api/jobs/:id/status     {status}
//   B1  POST /api/jobs/:id/result     {bid} | {error}
//   B2  POST /api/jobs/:id/cancel     (B2 stopped waiting; a queued job is dropped)
//   any GET  /api/health                                -> {ok, b1Online, b1LastSeenSec, queued}
// state: queued -> working -> done | error

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const WAIT_MS = 25000;            // long-poll length
const PICKUP_TIMEOUT_MS = Number(process.env.PICKUP_MS) || 90000;  // B1 counts as offline after this long without contact (and not busy)
const QUEUE_TIMEOUT_MS = 15 * 60000; // a job may wait this long behind other jobs
const WORK_TIMEOUT_MS = 10 * 60000;
const KEEP_MS = 30 * 60000;

let TOKEN = process.env.RELAY_TOKEN;
if (!TOKEN) {
  const f = path.join(__dirname, 'token.txt');
  if (fs.existsSync(f)) TOKEN = fs.readFileSync(f, 'utf8').trim();
  else { TOKEN = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(f, TOKEN + '\n', { mode: 0o600 }); }
}

const BUSY_STATUS = 'Waiting for B1 (busy with another bid)…';
const jobs = new Map();     // id -> job
const queue = [];           // ids waiting for B1
const jobWaiters = new Map(); // id -> Set(fn)
const workerWaiters = new Set();
let b1LastSeen = 0;

const now = () => Date.now();
const view = (j) => ({ id: j.id, state: j.state, status: j.status, bid: j.bid, error: j.error, version: j.version });

function touch(j) {
  j.version++;
  j.updated = now();
  const ws = jobWaiters.get(j.id);
  if (ws) { jobWaiters.delete(j.id); ws.forEach((fn) => fn()); }
}

function fail(j, error) {
  if (j.state === 'done' || j.state === 'error') return;
  j.state = 'error'; j.error = error;
  const i = queue.indexOf(j.id); if (i >= 0) queue.splice(i, 1);
  touch(j);
}

function nextJob() {
  while (queue.length) {
    const j = jobs.get(queue.shift());
    if (j && j.state === 'queued') { j.state = 'working'; j.status = 'B1 picked up the job'; j.picked = now(); touch(j); return j; }
  }
  return null;
}

setInterval(() => {
  const t = now();
  for (const j of jobs.values()) {
    if (j.state === 'queued') {
      // B1 handles one bid at a time: while it is busy, queued jobs wait (B1 doesn't poll then).
      const busy = [...jobs.values()].some((x) => x.state === 'working');
      const silent = t - Math.max(j.created, b1LastSeen) > PICKUP_TIMEOUT_MS;
      if (!busy && silent) fail(j, 'B1 did not pick up the job. Is Chrome with B1 running on the VPS, with the pairing code saved in the B1 popup?');
      else if (t - j.created > QUEUE_TIMEOUT_MS) fail(j, 'The job waited too long behind other bids.');
      else if (busy && j.status !== BUSY_STATUS) { j.status = BUSY_STATUS; touch(j); }
      else if (!busy && j.status === BUSY_STATUS) { j.status = 'Waiting for B1 on the VPS…'; touch(j); }
    }
    if (j.state === 'working' && t - j.picked > WORK_TIMEOUT_MS) fail(j, 'B1 took too long to answer.');
    if (t - j.updated > KEEP_MS) jobs.delete(j.id);
  }
}, 5000);

function send(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function authorized(req) {
  const h = req.headers.authorization || '';
  const got = Buffer.from(h.replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204);
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '');
  if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
  if (!authorized(req)) return send(res, 401, { error: 'Wrong relay token' });

  try {
    if (req.method === 'GET' && p === '/api/health') {
      const age = b1LastSeen ? Math.round((now() - b1LastSeen) / 1000) : null;
      return send(res, 200, { ok: true, b1Online: age !== null && age < 70, b1LastSeenSec: age, queued: queue.length });
    }

    if (req.method === 'POST' && p === '/api/jobs') {
      const { text } = await readBody(req);
      if (!text || typeof text !== 'string') return send(res, 400, { error: 'text required' });
      const busyNow = [...jobs.values()].some((x) => x.state === 'working');
      const j = { id: crypto.randomBytes(16).toString('hex'), text, state: 'queued', status: busyNow ? BUSY_STATUS : 'Waiting for B1 on the VPS…', bid: null, error: null, version: 1, created: now(), updated: now() };
      jobs.set(j.id, j);
      queue.push(j.id);
      const w = [...workerWaiters][0];
      if (w) w();
      return send(res, 200, { id: j.id });
    }

    let m;
    if (req.method === 'GET' && (m = p.match(/^\/api\/jobs\/([\w-]+)$/))) {
      const j = jobs.get(m[1]);
      if (!j) return send(res, 404, { error: 'job not found (expired?)' });
      const since = Number(url.searchParams.get('since')) || 0;
      if (j.version > since) return send(res, 200, view(j));
      let done = false;
      const fn = () => { if (!done) { done = true; clearTimeout(t); send(res, 200, view(j)); } };
      const t = setTimeout(() => { done = true; (jobWaiters.get(j.id) || new Set()).delete(fn); send(res, 200, view(j)); }, WAIT_MS);
      if (!jobWaiters.has(j.id)) jobWaiters.set(j.id, new Set());
      jobWaiters.get(j.id).add(fn);
      req.on('close', () => { done = true; clearTimeout(t); (jobWaiters.get(j.id) || new Set()).delete(fn); });
      return;
    }

    if (req.method === 'GET' && p === '/api/next') {
      b1LastSeen = now();
      const j = nextJob();
      if (j) return send(res, 200, { id: j.id, text: j.text });
      let done = false;
      const fn = () => {
        if (done) return;
        const job = nextJob();
        if (!job) return;
        done = true; clearTimeout(t); workerWaiters.delete(fn); b1LastSeen = now();
        send(res, 200, { id: job.id, text: job.text });
      };
      const t = setTimeout(() => { done = true; workerWaiters.delete(fn); b1LastSeen = now(); send(res, 204); }, WAIT_MS);
      workerWaiters.add(fn);
      req.on('close', () => { if (!done) { done = true; clearTimeout(t); workerWaiters.delete(fn); } });
      return;
    }

    if (req.method === 'POST' && (m = p.match(/^\/api\/jobs\/([\w-]+)\/cancel$/))) {
      const j = jobs.get(m[1]);
      if (j && j.state === 'queued') fail(j, 'Canceled.');   // never handed to B1
      else if (j && j.state === 'working') j.canceled = true; // B1 is already writing it; the result is just not used
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && (m = p.match(/^\/api\/jobs\/([\w-]+)\/(status|result)$/))) {
      b1LastSeen = now();
      const j = jobs.get(m[1]);
      if (!j) return send(res, 404, { error: 'job not found' });
      const body = await readBody(req);
      if (m[2] === 'status') { if (j.state === 'working') { j.status = String(body.status || ''); touch(j); } }
      else if (body.error) fail(j, String(body.error));
      else { j.state = 'done'; j.bid = String(body.bid || ''); j.status = 'Done'; touch(j); }
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Bid Assistant relay listening on http://${HOST}:${PORT}`);
  console.log(`Token: ${process.env.RELAY_TOKEN ? '(from RELAY_TOKEN)' : TOKEN + '  (saved in relay/token.txt)'}`);
});
