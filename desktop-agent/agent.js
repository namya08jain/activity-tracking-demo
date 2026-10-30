// The desktop helper: a small, real version of the desktop app, for Windows laptops. sensor.ps1 asks Windows the
// tracking questions; this file sends the answers to the demo server the same way a console tab does, plus the
// program in front, whether the screen is locked and which programs are using the microphone. It prints every
// report it sends, so the person can see exactly what leaves the laptop.
// Usage: node desktop-agent/agent.js <ananya|rahul|priya|oliver> [server address, default http://localhost:4100]
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const WebSocket = require('ws');

const userId = process.argv[2];
const server = (process.argv[3] || 'http://localhost:4100').replace(/\/$/, '');
if (!userId) {
  console.log('Usage: node desktop-agent/agent.js <ananya|rahul|priya|oliver> [server address]');
  process.exit(1);
}
if (process.platform !== 'win32') {
  console.log('The desktop helper reads Windows settings, so it only runs on Windows.');
  process.exit(1);
}

// Recognised here from the browser's window title. Only the name is sent, never the title itself.
const SITES = [[/Staff Console/, 'Console'], [/Training Management System/, 'TMS'], [/universit|ucas/i, 'University portal']];
// Store apps note their microphone use under a package name instead of a file name.
const PACKAGES = [[/^MSTeams/i, 'ms-teams.exe'], [/WhatsApp/i, 'whatsapp.exe'], [/SkypeApp/i, 'skype.exe'], [/Zoom/i, 'zoom.exe']];

// One stable id per laptop, so the manager sees one device however often the helper restarts.
const deviceId = `desktop-${crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 12)}`;
const deviceLabel = 'Laptop · Desktop app';

let config = { heartbeat: 5 };
let token = null;
let ws = null;
let signedOut = true;
let signingIn = false;
let reconnectDelay = 1000;
let heartbeatTimer = null;

// The latest answers from the sensor.
let now = { app: '', site: null, locked: false, micApps: [] };
let idleMs = 0;
let lastTick = null;        // Windows tick of the latest input seen
let burstStartTick = null;  // Windows tick when the current burst of input started
let gaps = [];              // milliseconds between bursts of input, for the "too regular" check
const inputSeconds = new Set();

const clock = () => new Date().toLocaleTimeString('en-GB');
const log = text => console.log(`${clock()}  ${text}`);

function send(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

// Windows clock ticks are unsigned 32-bit numbers that wrap after 49 days; >>> 0 keeps the difference right.
const ticksBetween = (later, earlier) => (later - earlier) >>> 0;

function onInput(last, tickNow) {
  const quietMs = lastTick === null ? Infinity : ticksBetween(last, lastTick);
  lastTick = last;
  // A pause of 300 ms or more, then input again, starts a new burst (the same rule as the console tab).
  if (quietMs >= 300) {
    if (burstStartTick !== null) gaps.push(ticksBetween(last, burstStartTick));
    if (gaps.length > 60) gaps.shift();
    burstStartTick = last;
  }
  inputSeconds.add(Math.floor((performance.now() - ticksBetween(tickNow, last)) / 1000));
  if (signedOut) signIn();
  else if (quietMs > 2000) send({ type: 'input' });
}

function onSample(sample) {
  if (!Number.isFinite(sample.last) || !Number.isFinite(sample.now)) return;
  // Once a second the sample also says what's in front, the screen lock and the microphone.
  if (sample.app !== undefined) {
    const title = String(sample.title || '');
    const site = SITES.find(([pattern]) => pattern.test(title));
    const micApps = (Array.isArray(sample.mic) ? sample.mic : []).map(name => {
      const store = PACKAGES.find(([pattern]) => pattern.test(name));
      return store ? store[1] : String(name).toLowerCase();
    });
    now = { app: String(sample.app || '').toLowerCase(), site: site ? site[1] : null, locked: sample.locked === true, micApps };
    // Going to sleep is an ordinary reason to go quiet; say so first, so it isn't flagged as "tracker stopped".
    if (sample.power === 'sleep') send({ type: 'goodbye', reason: 'sleep' });
  }
  // Moving the mouse on the lock screen isn't being at work: while the screen is locked, input is ignored.
  if (sample.last !== lastTick && !now.locked) onInput(sample.last, sample.now);
  if (lastTick !== null) idleMs = ticksBetween(sample.now, lastTick);
}

function heartbeat() {
  // Nothing to report until the sensor's first answers arrive (it takes a second or two to start).
  if (lastTick === null || !now.app) return;
  const nowSecond = Math.floor(performance.now() / 1000);
  for (const second of inputSeconds) if (nowSecond - second >= 120) inputSeconds.delete(second);
  const report = {
    type: 'heartbeat',
    visible: !now.locked,
    secondsSinceInput: Math.round(idleMs / 1000),
    inputSeconds: [...inputSeconds].map(second => nowSecond - second),
    gaps,
    app: now.app,
    site: now.site,
    locked: now.locked,
    micApps: now.micApps
  };
  if (!send(report)) return;
  inputSeconds.clear();
  gaps = [];
  const inFront = now.site ? `${now.site} (in ${now.app})` : now.app || 'nothing';
  const mic = now.micApps.length ? now.micApps.join(', ') : 'not in use';
  log(`sent: in front ${inFront} · last input ${report.secondsSinceInput}s ago · microphone ${mic} · screen ${now.locked ? 'locked' : 'unlocked'}`);
}

// In a real rollout the desktop app would sign in with the person's Windows (company) account. The demo has no
// passwords, so it signs in as the employee named when it was started, and again after an idle logout as soon as
// the laptop is used.
async function signIn() {
  if (signingIn) return;
  signingIn = true;
  try {
    const response = await fetch(`${server}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId })
    });
    if (!response.ok) throw new Error(response.status === 404 ? `there's no employee called "${userId}"` : `the server said ${response.status}`);
    ({ token, config } = await response.json());
    signedOut = false;
    log(`signed in as ${userId}`);
    connect();
  } catch (error) {
    log(`couldn't sign in (${error.message}). Is the demo running at ${server}? Trying again in 5 seconds.`);
    setTimeout(() => { if (signedOut) signIn(); }, 5000);
  } finally {
    signingIn = false;
  }
}

function connect() {
  if (ws) return;
  const socket = new WebSocket(`${server.replace(/^http/, 'ws')}/ws`);
  ws = socket;
  socket.on('open', () => {
    reconnectDelay = 1000;
    send({ type: 'hello', token, kind: 'desktop', deviceId, deviceLabel, tabId: deviceId });
    heartbeat();
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(heartbeat, config.heartbeat * 1000);
  });
  socket.on('message', data => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.type === 'logout') {
      signedOut = true;
      log(`signed out (${message.reason}); signs back in when the laptop is used again`);
    }
  });
  socket.on('close', code => {
    if (ws !== socket) return;
    ws = null;
    clearInterval(heartbeatTimer);
    // 4000/4001 = the server ended the session; anything else is a network drop, so reconnect.
    if (signedOut || code === 4000 || code === 4001) {
      signedOut = true;
      return;
    }
    log('connection lost, reconnecting');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  });
  socket.on('error', () => {});
}

function startSensor() {
  const sensor = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'sensor.ps1')], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  readline.createInterface({ input: sensor.stdout }).on('line', line => {
    try { onSample(JSON.parse(line)); } catch {}
  });
  sensor.stderr.on('data', data => log(`sensor: ${String(data).trim()}`));
  sensor.on('exit', () => {
    log('sensor stopped; restarting it');
    setTimeout(startSensor, 2000);
  });
  process.on('exit', () => sensor.kill());
}

console.log(`Desktop helper for ${userId}, reporting to ${server}`);
console.log('Sends: the program in front, seconds since the last input, whether the screen is locked, and which programs use the microphone.');
console.log('Closing this window switches the helper off; the manager screen shows that the desktop app stopped.\n');
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));
startSensor();
signIn();
