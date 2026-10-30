// Employee side of the demo: the tracking script every Crizac web app would load (here the console and the
// pretend TMS; <body data-app="…"> names the app). Both share one login. Each tab keeps one WebSocket open and reports:
// - a heartbeat every few seconds: is this tab visible, how long since the last mouse/keyboard input,
//   which recent seconds had any input, and the gaps between bursts of input (never what was typed or clicked)
// - "input" the moment someone touches the tab after a quiet spell
// - "work" when something is opened or saved
// - "status" when the employee picks On a call / In a meeting / On a break / Automatic
// The server decides the status and the logout; this page only reports and obeys.
// Uses STATE_LABELS, duration, el, localTime, blockName and blockChart from shared.js.
const $ = id => document.getElementById(id);
const APP = document.body.dataset.app || 'Console';

const store = {
  get: key => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch {} },
  remove: key => { try { localStorage.removeItem(key); } catch {} }
};
// crypto.randomUUID needs https, and a phone on the Wi-Fi opens this page over plain http.
const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// Tabs of one browser share a device id (localStorage); every tab has its own tab id.
const deviceId = store.get('deviceId') || (() => { const id = randomId(); store.set('deviceId', id); return id; })();
const tabId = randomId();

let session = readSession();
let config = { heartbeat: 5, warningBefore: 20, idleLogout: 60 };
let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let countdownTimer = null;

// Two clocks: performance.now() can't be changed by the user but may pause while a laptop sleeps;
// Date.now() keeps counting but can be changed. Reporting the larger gap never overstates activity.
let lastInputPerf = performance.now();
let lastInputDate = Date.now();
// For activity %: which seconds (on the monotonic clock) had input since the last heartbeat.
const inputSeconds = new Set();
// For the "too regular" check: milliseconds between the starts of bursts of input.
let gaps = [];
let lastBurstPerf = 0;
let dayTimer = null;
let jigglerTimer = null;

function readSession() {
  try { return JSON.parse(store.get('session')); } catch { return null; }
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const kind = /Mobi|Android|iPhone|iPad/i.test(ua) ? 'Phone' : 'Computer';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${kind} · ${browser}`;
}

function show(view) {
  for (const id of ['login', 'app', 'loggedout']) $(id).hidden = id !== view;
  $('topbar-user').hidden = view !== 'app';
}

function send(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

function secondsSinceInput() {
  const perfGap = (performance.now() - lastInputPerf) / 1000;
  const dateGap = (Date.now() - lastInputDate) / 1000;
  const gap = dateGap >= 0 && dateGap < 86400 ? Math.max(perfGap, dateGap) : perfGap;
  return Math.round(gap);
}

function onInput() {
  const now = performance.now();
  const quietMs = now - lastInputPerf;
  // A pause of 300 ms or more, then input again, starts a new "burst".
  if (quietMs >= 300) {
    if (lastBurstPerf) gaps.push(Math.round(now - lastBurstPerf));
    if (gaps.length > 60) gaps.shift();
    lastBurstPerf = now;
  }
  inputSeconds.add(Math.floor(now / 1000));
  lastInputPerf = now;
  lastInputDate = Date.now();
  if (quietMs > 2000) send({ type: 'input' });
}

function sendHeartbeat() {
  const nowSecond = Math.floor(performance.now() / 1000);
  for (const second of inputSeconds) if (nowSecond - second >= 120) inputSeconds.delete(second);
  const sent = send({
    type: 'heartbeat',
    visible: document.visibilityState === 'visible',
    secondsSinceInput: secondsSinceInput(),
    inputSeconds: [...inputSeconds].map(second => nowSecond - second),
    gaps
  });
  // Kept for the next try if the connection was down.
  if (sent) {
    inputSeconds.clear();
    gaps = [];
  }
}

async function showLogin() {
  show('login');
  const people = await (await fetch('/api/employees')).json();
  $('people').replaceChildren(...people.map(person => {
    const button = el('button', 'person');
    const text = el('span', 'person-text');
    text.append(el('b', '', person.name), el('span', 'muted small', `${person.office} office`));
    button.append(el('span', 'avatar', initials(person.name)), text);
    button.onclick = () => login(person);
    return button;
  }));
}

async function login(person) {
  const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: person.id }) });
  if (!response.ok) return;
  const body = await response.json();
  session = { token: body.token, userId: person.id, name: person.name };
  config = body.config;
  store.set('session', JSON.stringify(session));
  onInput();
  startApp();
}

function startApp() {
  show('app');
  $('who').textContent = session.name;
  $('avatar').textContent = initials(session.name);
  $('avatar').title = session.name;
  $('device').textContent = `This device: ${deviceLabel()}`;
  connect();
}

function connect() {
  clearTimeout(reconnectTimer);
  if (ws) return;
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws = socket;
  socket.onopen = () => {
    reconnectDelay = 1000;
    $('connection').textContent = 'Connected';
    send({ type: 'hello', token: session.token, deviceId, deviceLabel: deviceLabel(), tabId, app: APP });
    sendHeartbeat();
  };
  // Messages from an old socket (after a logout and a new login) are ignored.
  socket.onmessage = event => { if (ws === socket) handle(JSON.parse(event.data)); };
  socket.onclose = event => {
    if (ws !== socket) return;
    ws = null;
    // 4000/4001 = the server ended the session; anything else is a network drop, so reconnect.
    if (!session || event.code === 4000 || event.code === 4001) return;
    $('connection').textContent = 'Reconnecting…';
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
}

function handle(message) {
  if (message.type === 'welcome') {
    config = message.config;
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(sendHeartbeat, config.heartbeat * 1000);
  } else if (message.type === 'you') {
    $('me').textContent = STATE_LABELS[message.state];
    $('me').className = `pill ${message.state}`;
    showStatus(message);
    if (message.secondsUntilLogout !== null && message.secondsUntilLogout <= config.warningBefore) showWarning(message.secondsUntilLogout);
    else hideWarning();
  } else if (message.type === 'myday') {
    renderDay(message);
  } else if (message.type === 'warning') {
    showWarning(message.secondsLeft);
  } else if (message.type === 'logout') {
    endSession(message.reason);
  }
}

// The status picker shows what the server has recorded, so every tab and device agrees.
function showStatus({ state, manualEndsIn }) {
  const manual = ['call', 'meeting', 'break'].includes(state) ? state : '';
  for (const button of $('status').querySelectorAll('button')) button.classList.toggle('on', button.dataset.status === manual);
  $('manual-note').hidden = !manual;
  if (manual) {
    $('manual-note').className = `manual-note ${manual}`;
    // A call detected by the desktop app has no end time: it ends when the microphone is free again.
    $('manual-note').textContent = `You're marked "${STATE_LABELS[manual]}". There's no idle logout and this time is left out of your activity %. `
      + (typeof manualEndsIn === 'number' ? `It goes back to Automatic by itself in ${duration(manualEndsIn)}, or click Automatic when you're done.` : 'It ends when the call ends.');
  }
}

function showView(view) {
  for (const button of document.querySelectorAll('[data-view]')) button.classList.toggle('on', button.dataset.view === view);
  $('apps-view').hidden = view !== 'apps';
  $('day-view').hidden = view !== 'day';
  clearInterval(dayTimer);
  if (view === 'day') {
    send({ type: 'myday' });
    dayTimer = setInterval(() => send({ type: 'myday' }), 2000);
  }
}

function renderDay(day) {
  const { totals } = day;
  $('day-activity').textContent = day.activity === null ? '–' : `${day.activity}%`;
  $('day-work').textContent = day.workCount;
  $('day-computer').textContent = duration(totals.working + totals.active + totals.idle + totals.away);
  $('day-calls').textContent = duration(totals.call + totals.meeting);
  $('day-breaks').textContent = duration(totals.break);
  $('day-chart-title').textContent = `Activity % per ${blockName(config.block)}`;
  $('day-chart').replaceChildren(blockChart(day.blocks, config.block, day.timeZone));
  $('day-apps').replaceChildren(...(day.apps.length
    ? day.apps.map(app => appTime(app))
    : [el('span', 'muted small', 'No time in use yet.')]));
  const items = day.workLog.map(item => {
    const li = el('li');
    li.append(el('time', '', localTime(item.at, day.timeZone)), el('span', 'log-label', item.label), el('span', 'app-tag', item.app));
    return li;
  });
  if (!items.length) items.push(el('li', 'muted', 'Nothing opened or saved yet.'));
  $('day-log').replaceChildren(...items);
}

function setJiggler(on) {
  if (!$('jiggler')) return;  // the demo-only jiggler box is only on the console
  $('jiggler').checked = on;
  $('jiggling').hidden = !on;
  clearInterval(jigglerTimer);
  // A real jiggler moves the pointer by a pixel on a fixed beat; the page sees it as mouse movement.
  if (on) jigglerTimer = setInterval(onInput, 1000);
}

function showWarning(secondsLeft) {
  $('countdown').textContent = secondsLeft;
  $('warning').hidden = false;
  clearInterval(countdownTimer);
  let left = secondsLeft;
  countdownTimer = setInterval(() => { left = Math.max(0, left - 1); $('countdown').textContent = left; }, 1000);
}

function hideWarning() {
  $('warning').hidden = true;
  clearInterval(countdownTimer);
}

function endSession(reason) {
  session = null;
  store.remove('session');
  clearInterval(heartbeatTimer);
  hideWarning();
  setJiggler(false);
  showView('apps');
  const old = ws;
  ws = null;
  old?.close();
  const minutes = Math.round(config.idleLogout / 60);
  $('reason').textContent = reason === 'idle'
    ? `There was no activity on any of your tabs or devices for ${minutes} minute${minutes === 1 ? '' : 's'}, so every tab and device was logged out together.`
    : reason === 'signed out' ? 'You logged out, so every tab and device was logged out together.' : 'Your session has ended.';
  show('loggedout');
}

function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('toast').hidden = true; }, 2200);
}

for (const type of ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
  window.addEventListener(type, onInput, { passive: true });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') onInput();
  sendHeartbeat();
});

document.addEventListener('click', event => {
  const button = event.target.closest('[data-work]');
  if (!button) return;
  send({ type: 'work', label: button.dataset.work });
  toast(`${button.dataset.work} ✓`);
});
for (const button of $('status').querySelectorAll('button')) {
  button.onclick = () => send({ type: 'status', status: button.dataset.status || null });
}
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => showView(button.dataset.view);
if ($('jiggler')) $('jiggler').onchange = () => setJiggler($('jiggler').checked);
$('here').onclick = () => { onInput(); send({ type: 'input' }); hideWarning(); };
$('signout').onclick = () => fetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: session?.token }) });
$('again').onclick = showLogin;

// Logging in or out in one tab updates the other tabs of this browser straight away.
window.addEventListener('storage', event => {
  if (event.key !== 'session') return;
  const next = readSession();
  if (next && !session) {
    session = next;
    startApp();
  }
});

if (session) startApp();
else showLogin();
