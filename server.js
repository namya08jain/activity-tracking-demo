// Activity tracking demo: a pretend employee console (/) and a live manager screen (/manager).
// Each open console tab keeps one WebSocket open and reports activity; the server merges every tab
// and device per employee, warns before an idle logout, and logs out every tab and device at once.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const config = require('./src/config');
const employees = require('./src/employees');
const { ActivityTracker } = require('./src/tracker');
const { SamplePeople } = require('./src/sample-people');
const managerView = require('./src/manager-view');
const store = require('./src/store');

const PORT = Number(process.env.PORT || 4100);
// Daily records are saved here every few seconds, so the reports keep their history across restarts.
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'activity.json');
const tracker = new ActivityTracker(config, employees, store.load(DATA_FILE));
const samplePeople = new SamplePeople(config);  // demo only: a made-up crowd for the manager screen
const SAMPLE_PEOPLE = 2000;
const MANAGER_REPLY_MS = 200;  // quickest a manager page gets a fresh answer after changing what it looks at
const sockets = new Map();   // connection id → employee tab socket
const managers = new Map();  // manager screen socket → what that page is looking at (manager-view.js)
const publicDir = path.join(__dirname, 'public');
const PAGES = { '/': 'console.html', '/tms': 'tms.html', '/manager': 'manager.html', '/reports': 'reports.html', '/desktop': 'desktop.html' };
const REPORT_RANGES = new Set(['today', 'yesterday', 'week']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
// The pretend laptop (/desktop) shows Windows' own wallpaper and lock screen picture when the demo runs on Windows.
// They're read from the Windows folder on request, never copied into the demo; elsewhere the page uses a gradient.
const WINDOWS_DIR = process.env.WINDIR || 'C:\\Windows';
const WINDOWS_PICTURES = {
  '/wallpaper.jpg': path.join(WINDOWS_DIR, 'Web', 'Wallpaper', 'Windows', 'img0.jpg'),
  '/lockscreen.jpg': path.join(WINDOWS_DIR, 'Web', 'Screen', 'img100.jpg')
};

// Load figures for the manager screen and the load test.
let messagesThisSecond = 0;
const stats = { messagesPerSecond: 0, cpuPercent: 0 };
let lastCpu = process.cpuUsage();
let lastCpuAt = process.hrtime.bigint();

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10_000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// A message from a page: a JSON object, or null for anything else ("null", a number, broken JSON), so a bad
// message can never crash the server.
function parseMessage(data) {
  try {
    const message = JSON.parse(data);
    return message && typeof message === 'object' && !Array.isArray(message) ? message : null;
  } catch {
    return null;
  }
}

function send(ws, message) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

// Tells every tab and device of an employee they are logged out, then closes those connections.
function deliverLogout(connIds, reason) {
  for (const connId of connIds) {
    const ws = sockets.get(connId);
    send(ws, { type: 'logout', reason });
    ws?.close(4000, 'logged out');
  }
}

function saveDays() {
  if (!tracker.dirty) return;
  tracker.dirty = false;
  try {
    store.save(DATA_FILE, tracker.exportDays());
  } catch (error) {
    tracker.dirty = true;
    console.warn(`Could not save ${DATA_FILE}: ${error.message}`);
  }
}

// Changing demo data (the made-up sample week) is only allowed from this computer, not from the Wi-Fi.
function fromThisComputer(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}

function currentStats() {
  const memory = process.memoryUsage();
  return {
    connections: sockets.size,
    managers: managers.size,
    rssMB: Math.round(memory.rss / 1048576),
    heapMB: Math.round(memory.heapUsed / 1048576),
    cpuPercent: stats.cpuPercent,
    messagesPerSecond: stats.messagesPerSecond
  };
}

// Sends each manager page the totals, the rows it has on screen and the detail of the person it has open (or only
// `one` page, when it has just changed what it's looking at). The totals are worked out once for everyone; each page
// then filters and sorts its own copy, which takes milliseconds even for thousands of people.
function sendManagers(now, one = null) {
  const targets = one ? [one] : [...managers.keys()];
  if (!targets.length) return;
  const rows = [...tracker.rows(now), ...samplePeople.rows(now)];
  let botsOnline = 0;
  for (const user of tracker.users.values()) if (user.bot && user.loggedIn) botsOnline++;
  const common = { type: 'snapshot', now, config, stats: currentStats(), overview: managerView.overview(rows), botsOnline, samplePeople: samplePeople.size };
  for (const ws of targets) {
    const manager = managers.get(ws);
    if (!manager || ws.readyState !== ws.OPEN) continue;
    manager.lastSent = now;
    const id = manager.detail;
    const detail = !id ? null : id.startsWith('sample-') ? samplePeople.detail(id, now) : tracker.detail(id, now);
    ws.send(JSON.stringify({ ...common, ...managerView.select(rows, manager.view), detail }));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/employees') {
      return sendJson(res, 200, employees.map(({ id, name, office }) => ({ id, name, office })));
    }
    if (req.method === 'GET' && url.pathname === '/api/stats') return sendJson(res, 200, currentStats());
    if (req.method === 'GET' && url.pathname === '/api/report') {
      const range = url.searchParams.get('range') || 'today';
      if (!REPORT_RANGES.has(range)) return sendJson(res, 400, { error: 'range must be today, yesterday or week' });
      return sendJson(res, 200, tracker.report(range, Date.now()));
    }
    if (req.method === 'POST' && url.pathname === '/api/sample') {
      if (!fromThisComputer(req)) return sendJson(res, 403, { error: 'Sample data can only be changed on the demo laptop' });
      const { action } = await readJson(req);
      if (action === 'add') tracker.addSampleWeek(Date.now());
      else if (action === 'remove') tracker.removeSample();
      else return sendJson(res, 400, { error: 'action must be add or remove' });
      saveDays();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/sample-people') {
      if (!fromThisComputer(req)) return sendJson(res, 403, { error: 'Sample data can only be changed on the demo laptop' });
      const { action } = await readJson(req);
      if (action === 'add') {
        samplePeople.remove();
        samplePeople.add(SAMPLE_PEOPLE, Date.now());
      } else if (action === 'remove') samplePeople.remove();
      else return sendJson(res, 400, { error: 'action must be add or remove' });
      sendManagers(Date.now());
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const { userId } = await readJson(req);
      const token = tracker.login(String(userId || ''), Date.now());
      return token ? sendJson(res, 200, { token, config }) : sendJson(res, 404, { error: 'Unknown employee' });
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const { token } = await readJson(req);
      const userId = tracker.userForToken(String(token || ''));
      if (userId) deliverLogout(tracker.logout(userId, 'signed out'), 'signed out');
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && Object.hasOwn(WINDOWS_PICTURES, url.pathname)) {
      const picture = WINDOWS_PICTURES[url.pathname];
      if (!fs.existsSync(picture)) return sendJson(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' });
      return fs.createReadStream(picture).pipe(res);
    }
    if (req.method === 'GET') {
      // Only plain file names from public/ are served, never paths.
      const file = PAGES[url.pathname] || url.pathname.slice(1);
      if (/^[a-z-]+\.(html|js|css|svg|png)$/.test(file) && fs.existsSync(path.join(publicDir, file))) {
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)], 'cache-control': 'no-store' });
        return fs.createReadStream(path.join(publicDir, file)).pipe(res);
      }
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (new URL(req.url, 'http://localhost').searchParams.get('role') === 'manager') {
    managers.set(ws, { view: managerView.cleanView(), detail: null, lastSent: 0, timer: null });
    // The page says what it's looking at; the answer goes back quickly (at most every 200 ms however fast the page
    // asks, for example while scrolling), and once a second anyway.
    ws.on('message', data => {
      const message = parseMessage(data);
      const manager = managers.get(ws);
      if (!message || !manager) return;
      if (message.type === 'view') manager.view = managerView.cleanView(message);
      else if (message.type === 'detail') manager.detail = typeof message.id === 'string' ? message.id.slice(0, 64) : null;
      else return;
      if (manager.timer) return;
      manager.timer = setTimeout(() => {
        manager.timer = null;
        sendManagers(Date.now(), ws);
      }, Math.max(0, MANAGER_REPLY_MS - (Date.now() - manager.lastSent)));
    });
    ws.on('close', () => {
      clearTimeout(managers.get(ws)?.timer);
      managers.delete(ws);
    });
    sendManagers(Date.now(), ws);
    return;
  }

  const connId = crypto.randomUUID();
  ws.on('message', data => {
    messagesThisSecond++;
    const message = parseMessage(data);
    if (!message) return;
    const now = Date.now();
    if (message.type === 'hello') {
      if (sockets.has(connId)) return; // already bound to an employee; a second hello is ignored
      const user = tracker.connect(connId, message.token, message);
      if (!user) {
        send(ws, { type: 'logout', reason: 'not logged in' });
        return ws.close(4001, 'not logged in');
      }
      sockets.set(connId, ws);
      send(ws, { type: 'welcome', name: user.name, config });
    } else if (message.type === 'heartbeat') {
      tracker.heartbeat(connId, message, now);
    } else if (message.type === 'input') {
      tracker.input(connId, now);
    } else if (message.type === 'work') {
      tracker.work(connId, message.label, now);
    } else if (message.type === 'status') {
      tracker.setStatus(connId, message.status ?? null, now);
    } else if (message.type === 'goodbye') {
      tracker.goodbye(connId, message.reason);
    } else if (message.type === 'away') {
      tracker.explainAway(connId, message.kind, message.seconds, now);
    } else if (message.type === 'myday') {
      const day = tracker.myDay(connId, now);
      if (day) send(ws, { type: 'myday', ...day });
    }
  });
  ws.on('close', () => {
    tracker.connectionLost(connId, Date.now());
    sockets.delete(connId);
  });
});

// Every second: update states, deliver warnings and logouts, refresh the manager screens.
setInterval(() => {
  const now = Date.now();
  for (const event of tracker.tick(now)) {
    if (event.type === 'logout') deliverLogout(event.connIds, event.reason);
    else for (const connId of event.connIds) send(sockets.get(connId), { type: 'warning', secondsLeft: event.secondsLeft });
  }
  // Each demo employee's tabs show what the server currently thinks of them.
  for (const [connId, ws] of sockets) {
    const user = tracker.userOf(connId);
    if (user && !user.bot) {
      const manualEndsIn = user.manual && !user.manual.auto && Math.max(0, Math.ceil((config.manualMax * 1000 - (now - user.manual.since)) / 1000));
      send(ws, { type: 'you', state: tracker.stateOf(user, now), secondsUntilLogout: tracker.secondsUntilLogout(user, now), manualEndsIn });
    }
  }

  const cpu = process.cpuUsage(lastCpu);
  const at = process.hrtime.bigint();
  stats.cpuPercent = Math.round(((cpu.user + cpu.system) / (Number(at - lastCpuAt) / 1000)) * 1000) / 10;
  lastCpu = process.cpuUsage();
  lastCpuAt = at;
  stats.messagesPerSecond = messagesThisSecond;
  messagesThisSecond = 0;

  samplePeople.tick(now);
  sendManagers(now);
}, 1000);

// A laptop that sleeps or a phone that locks often vanishes without closing its connection.
// The server pings every connection and drops the ones that stop answering.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, config.deadConnection * 1000);

// Save the daily records every few seconds, and once more when the server is stopped
// (Ctrl+C, or closing the "Activity demo server" window, which Windows reports as SIGHUP).
setInterval(saveDays, 5000);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    saveDays();
    process.exit(0);
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Activity tracking demo (${config.mode} timings: idle logout after ${config.idleLogout} s)`);
  console.log(`  Employee console:  http://localhost:${PORT}/`);
  console.log(`  Manager screen:    http://localhost:${PORT}/manager`);
  console.log(`  Reports:           http://localhost:${PORT}/reports`);
  console.log(`  History saved in:  ${DATA_FILE}`);
  const lan = Object.values(os.networkInterfaces()).flat().filter(item => item.family === 'IPv4' && !item.internal);
  for (const item of lan) console.log(`  From a phone on the same Wi-Fi: http://${item.address}:${PORT}/`);
});
