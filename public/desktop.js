// A pretend Windows 11 laptop with the Crizac desktop app ("Crizac Activity") running in the tray. The pretend apps
// are just enough to work in and switch between. The desktop app is the real part: it reports to the server
// exactly like desktop-agent/agent.js does on a real laptop: the program in front, time since the last input,
// the screen lock, and which programs are using the microphone. Window titles never leave the laptop; a Crizac
// page or work website is recognised from the title here and only its name is sent.
// Uses el and initials from shared.js.
const $ = id => document.getElementById(id);
const DEVICE_ID = 'demo-laptop';
const SITES = [[/Staff Console/, 'Console'], [/Training Management System/, 'TMS'], [/universit/i, 'University portal']];
const MANUAL = ['call', 'meeting', 'break'];

const APPS = {
  explorer: { name: 'File Explorer', process: 'explorer.exe', icon: 'icon-explorer.svg', build: buildExplorer, size: [900, 560], className: 'tabbed' },
  browser: { name: 'Google Chrome', process: 'chrome.exe', icon: 'icon-chrome.svg', build: buildBrowser, size: [1040, 660], className: 'tabbed' },
  calls: { name: 'Microsoft Teams', process: 'ms-teams.exe', icon: 'icon-teams.svg', build: buildCalls, size: [900, 580], className: 'teams' },
  mail: { name: 'Outlook', process: 'outlook.exe', icon: 'icon-outlook.svg', build: buildMail, size: [1000, 620], className: 'office outlook' },
  sheet: { name: 'Excel', process: 'excel.exe', icon: 'icon-excel.svg', build: buildSheet, size: [960, 600], className: 'office excel' },
  taskmgr: { name: 'Task Manager', process: 'taskmgr.exe', icon: 'icon-taskmgr.png', build: buildTaskManager, size: [760, 540], className: '' },
  // The employee's own window of the desktop app, opened from its icon by the clock.
  activity: { name: 'Crizac Activity', process: 'crizacactivity.exe', icon: 'icon-crizac-activity.svg', build: buildActivity, size: [820, 580], className: 'activity-app' }
};
const PINNED = ['explorer', 'browser', 'calls', 'mail', 'sheet'];
// How the tray panel names what's in front.
const PROCESS_NAMES = { 'lockapp.exe': 'Lock screen', desktop: 'Desktop' };
for (const app of Object.values(APPS)) PROCESS_NAMES[app.process] = app.name;

const state = {
  user: null,         // who is signed in to the laptop
  selected: null,     // who is picked on the sign-in screen
  people: [],
  screen: 'signin',   // signin | unlock | locked | desktop | asleep | off | restarting
  windows: [],        // open windows, front last
  mic: new Map(),     // program using the microphone → its name
  jiggler: null,
  lastForeground: '',
  wokeAt: 0,
  lastManualPerf: 0,  // when the person was last on a call, in a meeting or on a break (not "away" time)
  input: { lastPerf: performance.now(), lastBurst: 0, seconds: new Set(), gaps: [] }
};

function glyph(code, className = '') {
  return el('span', `glyph ${className}`.trim(), String.fromCodePoint(code));
}

function appIcon(key, className = 'app-icon') {
  const image = el('img', className);
  image.src = APPS[key].icon;
  image.alt = '';
  image.draggable = false;
  return image;
}

// ---------- Input: what the desktop app counts as "someone is using the laptop" ----------

function onInput() {
  if (state.screen === 'asleep') return wake();
  // Moving the mouse on the sign-in or lock screen isn't being at work.
  if (state.screen === 'desktop') noteInput();
}

function noteInput() {
  const input = state.input;
  const now = performance.now();
  const quietMs = now - input.lastPerf;
  // Back after a long spell with no input (locked, asleep or just away): ask what it was. Time on a call, in a
  // meeting or on a break is already explained, so only the time since then counts.
  const awaySeconds = Math.round((now - Math.max(input.lastPerf, state.lastManualPerf)) / 1000);
  // Longer than the limit is time off (a night, a day out), not something to explain.
  const asks = awaySeconds >= (agent.config.awayPrompt ?? 30) && awaySeconds <= (agent.config.awayLimit ?? 600);
  if (agent.running && asks) showAwayPrompt(awaySeconds);
  // A pause of 300 ms or more, then input again, starts a new burst (the same rule as the console tab).
  if (quietMs >= 300) {
    if (input.lastBurst) input.gaps.push(Math.round(now - input.lastBurst));
    if (input.gaps.length > 60) input.gaps.shift();
    input.lastBurst = now;
  }
  input.seconds.add(Math.floor(now / 1000));
  input.lastPerf = now;
  $('toast-warning')?.remove();
  if (!agent.running) return;
  if (agent.signedOut) agentSignIn();
  else if (quietMs > 2000) agentSend({ type: 'input' });
}

function listenForInput(target) {
  for (const type of ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart']) {
    target.addEventListener(type, onInput, { capture: true, passive: true });
  }
}

// ---------- The desktop app: Crizac Activity ----------

// you: the server's view of this person, every second; myday: their day so far, asked for while the window is open.
const agent = { running: false, ws: null, token: null, config: { heartbeat: 5 }, signedOut: true, signingIn: false, timer: null, lastSent: null, you: null, myday: null, pendingAway: null };

function agentSend(message) {
  if (!agent.ws || agent.ws.readyState !== WebSocket.OPEN) return false;
  agent.ws.send(JSON.stringify(message));
  return true;
}

function agentStart() {
  if (agent.running) return;
  agent.running = true;
  agent.signedOut = true;
  agentSignIn();
  renderTray();
}

// Stops the desktop app. Sleep, shutting down and signing out are announced first, so the server doesn't flag
// them; ending it in Task Manager gives it no chance to say anything.
function agentStop(goodbye) {
  if (!agent.running) return;
  if (goodbye) agentSend({ type: 'goodbye', reason: goodbye });
  agent.running = false;
  clearInterval(agent.timer);
  const socket = agent.ws;
  agent.ws = null;
  socket?.close(1000);
  renderTray();
}

// A real desktop app signs in with the person's Windows account; here, signing in to the laptop does it.
async function agentSignIn() {
  if (agent.signingIn || !agent.running || !state.user) return;
  agent.signingIn = true;
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: state.user.id }) });
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    agent.token = body.token;
    agent.config = body.config;
    agent.signedOut = false;
    agentConnect();
  } catch {
    setTimeout(() => { if (agent.running && agent.signedOut) agentSignIn(); }, 5000);
  } finally {
    agent.signingIn = false;
    renderTray();
  }
}

function agentConnect() {
  if (agent.ws) return;
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  agent.ws = socket;
  socket.onopen = () => {
    agentSend({ type: 'hello', token: agent.token, kind: 'desktop', deviceId: DEVICE_ID, deviceLabel: 'Laptop · Desktop app', tabId: DEVICE_ID });
    agentHeartbeat();
    // An answer to "what was it?" given while the app was reconnecting goes now.
    if (agent.pendingAway) agentSend({ type: 'away', ...agent.pendingAway });
    agent.pendingAway = null;
    if (isOpen('activity')) agentSend({ type: 'myday' });
    clearInterval(agent.timer);
    agent.timer = setInterval(agentHeartbeat, agent.config.heartbeat * 1000);
    renderTray();
  };
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'logout') {
      agent.signedOut = true;
      agent.you = null;
      renderTray();
    } else if (message.type === 'you') {
      agent.you = message;
      if (MANUAL.includes(message.state)) state.lastManualPerf = performance.now();
    } else if (message.type === 'myday') {
      agent.myday = message;
      renderActivity();
    } else if (message.type === 'warning') {
      showToast('warning', 'Still there?', `You'll be signed out of Crizac in ${message.secondsLeft} s.`, [["I'm here", () => noteInput()]]);
    }
  };
  socket.onclose = event => {
    if (agent.ws !== socket) return;
    agent.ws = null;
    clearInterval(agent.timer);
    if (!agent.running) return;
    // 4000/4001 = the server ended the session (it signs back in at the next input); anything else, reconnect.
    if (agent.signedOut || event.code === 4000 || event.code === 4001) agent.signedOut = true;
    else setTimeout(agentConnect, 2000);
    renderTray();
  };
}

const isLocked = () => state.screen === 'locked' || state.screen === 'unlock';

function foreground() {
  if (isLocked()) return { process: 'lockapp.exe', site: null };
  const front = frontWindow();
  if (!front) return { process: 'desktop', site: null };
  const title = front.title();
  const site = SITES.find(([pattern]) => pattern.test(title));
  return { process: APPS[front.key].process, site: site ? site[1] : null };
}

function agentHeartbeat() {
  const input = state.input;
  const now = performance.now();
  const nowSecond = Math.floor(now / 1000);
  for (const second of input.seconds) if (nowSecond - second >= 120) input.seconds.delete(second);
  const front = foreground();
  const report = {
    type: 'heartbeat',
    visible: state.screen === 'desktop',
    secondsSinceInput: Math.round((now - input.lastPerf) / 1000),
    inputSeconds: [...input.seconds].map(second => nowSecond - second),
    gaps: input.gaps,
    app: front.process,
    site: front.site,
    locked: isLocked(),
    micApps: [...state.mic.keys()]
  };
  if (agentSend(report)) {
    input.seconds.clear();
    input.gaps = [];
    agent.lastSent = { ...report, at: Date.now() };
  }
  renderTray();
}

// The manager screen updates straight away when the person switches app, locks the screen or starts a call.
function changed() {
  const front = foreground();
  const now = `${front.process}|${front.site}|${isLocked()}|${[...state.mic.keys()]}`;
  if (now === state.lastForeground) return;
  state.lastForeground = now;
  agentHeartbeat();
}

// ---------- Tray ----------

function renderTray() {
  $('tray-app').classList.toggle('off', !agent.running);
  $('mic').hidden = state.mic.size === 0;
  $('mic').title = state.mic.size ? `${[...state.mic.values()].join(', ')} is using your microphone` : '';
  renderActivity();
}

// ---------- Notifications (bottom right, like Windows) ----------

function showToast(id, title, text, actions, seconds = 60) {
  $(`toast-${id}`)?.remove();
  const toast = el('div', 'toast');
  toast.id = `toast-${id}`;
  const head = el('div', 'toast-head');
  const close = el('button', 'toast-close glyph', '');
  close.onclick = () => toast.remove();
  head.append(appIcon('activity', 'toast-icon'), el('span', '', 'Crizac Activity'), close);
  const buttons = el('div', 'toast-actions');
  for (const [label, action] of actions) {
    const button = el('button', '', label);
    button.onclick = () => {
      toast.remove();
      action();
    };
    buttons.append(button);
  }
  toast.append(head, el('b', 'toast-title', title), el('div', 'toast-text', text), buttons);
  $('toasts').append(toast);
  setTimeout(() => toast.remove(), seconds * 1000);
}

// "You were away 25 min, what was it?" The answer is sent now, or as soon as the app has reconnected.
function showAwayPrompt(seconds) {
  const answer = kind => () => {
    const message = { kind, seconds };
    if (!agentSend({ type: 'away', ...message })) agent.pendingAway = message;
    if (isOpen('activity')) setTimeout(() => agentSend({ type: 'myday' }), 300);
  };
  showToast('away', `You were away for ${duration(seconds)}`, 'What was it?',
    [['Break', answer('break')], ['Meeting', answer('meeting')], ['Call', answer('call')], ['Skip', () => {}]]);
}

// A USB mouse jiggler: to the laptop it's a real mouse that moves once a second, like clockwork.
function toggleJiggler() {
  if (state.jiggler) {
    clearInterval(state.jiggler);
    state.jiggler = null;
  } else {
    state.jiggler = setInterval(() => { if (state.screen === 'desktop') noteInput(); }, 1000);
  }
  $('jiggler').classList.toggle('on', Boolean(state.jiggler));
}

// ---------- Windows ----------

let nextWindowId = 1;
const narrow = () => window.innerWidth < 860;
const frontWindow = () => [...state.windows].reverse().find(win => !win.minimized) || null;
const isOpen = key => state.windows.some(win => win.key === key);

function openApp(key) {
  closeMenus();
  const existing = state.windows.find(win => win.key === key);
  if (existing) {
    existing.minimized = false;
    existing.node.hidden = false;
    return focusWindow(existing);
  }
  const app = APPS[key];
  const win = { id: nextWindowId++, key, minimized: false, closed: false };
  const node = el('div', `window ${app.className}`.trim());
  const bar = el('div', 'titlebar');
  const title = el('span', 'title', app.name);
  const minimize = el('button', 'caption', '');
  const maximize = el('button', 'caption', '');
  const close = el('button', 'caption close', '');
  const toggleMaximized = () => {
    node.classList.toggle('maximized');
    maximize.textContent = node.classList.contains('maximized') ? '' : '';
  };
  minimize.onclick = () => minimizeWindow(win);
  maximize.onclick = toggleMaximized;
  close.onclick = () => closeWindow(win);
  // Chrome and File Explorer put their tabs in the title bar.
  const tabStrip = el('div', 'tab-strip');
  if (app.className.includes('tabbed')) bar.append(tabStrip, minimize, maximize, close);
  else bar.append(appIcon(key), title, minimize, maximize, close);
  bar.ondblclick = event => { if (!event.target.closest('button')) toggleMaximized(); };
  dragBy(bar, node);

  const body = el('div', 'window-body');
  node.append(bar, body);
  node.addEventListener('pointerdown', () => focusWindow(win), true);
  Object.assign(win, { node, body, tabStrip, title: () => title.textContent, setTitle: text => { title.textContent = text; } });
  app.build(win);

  const area = $('windows').getBoundingClientRect();
  const offset = (state.windows.length % 5) * 26;
  const width = Math.min(app.size[0], area.width - 40);
  const height = Math.min(app.size[1], area.height - 30);
  node.style.width = `${width}px`;
  node.style.height = `${height}px`;
  node.style.left = `${Math.max(0, Math.min((area.width - width) / 2 - 70 + offset, area.width - width))}px`;
  node.style.top = `${Math.max(0, Math.min((area.height - height) / 2 - 30 + offset, area.height - height))}px`;
  if (narrow()) toggleMaximized();
  $('windows').append(node);
  state.windows.push(win);
  focusWindow(win);
}

// When the screen changes size (a window dragged to half the screen, a phone turned), windows stay usable:
// on a narrow screen they fill it, on a wider one they're pulled back inside it.
function fitWindows() {
  const area = $('windows').getBoundingClientRect();
  if (!area.width) return;
  for (const win of state.windows) {
    const node = win.node;
    if (narrow()) {
      node.classList.add('maximized');
      continue;
    }
    if (node.offsetWidth > area.width) node.style.width = `${area.width - 20}px`;
    if (node.offsetHeight > area.height) node.style.height = `${area.height - 20}px`;
    node.style.left = `${Math.max(0, Math.min(node.offsetLeft, area.width - node.offsetWidth))}px`;
    node.style.top = `${Math.max(0, Math.min(node.offsetTop, area.height - node.offsetHeight))}px`;
  }
}

function focusWindow(win) {
  if (win.closed) return;
  state.windows = [...state.windows.filter(other => other !== win), win];
  state.windows.forEach((other, index) => {
    other.node.style.zIndex = String(index + 1);
    other.node.classList.toggle('inactive', other !== win);
  });
  renderTaskbar();
  changed();
}

function minimizeWindow(win) {
  win.minimized = true;
  win.node.hidden = true;
  const front = frontWindow();
  state.windows.forEach(other => other.node.classList.toggle('inactive', other !== front));
  renderTaskbar();
  changed();
}

function closeWindow(win) {
  win.closed = true;
  win.onClose?.();
  win.node.remove();
  state.windows = state.windows.filter(other => other !== win);
  const front = frontWindow();
  if (front) front.node.classList.remove('inactive');
  renderTaskbar();
  changed();
}

function dragBy(handle, node) {
  handle.addEventListener('pointerdown', event => {
    if (event.target.closest('button') || node.classList.contains('maximized')) return;
    const startX = event.clientX - node.offsetLeft;
    const startY = event.clientY - node.offsetTop;
    const area = $('windows').getBoundingClientRect();
    handle.setPointerCapture(event.pointerId);
    const move = moveEvent => {
      node.style.left = `${Math.min(Math.max(moveEvent.clientX - startX, -node.offsetWidth + 100), area.width - 100)}px`;
      node.style.top = `${Math.min(Math.max(moveEvent.clientY - startY, 0), area.height - 32)}px`;
    };
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
  });
}

// ---------- Taskbar and Start ----------

function renderTaskbar() {
  const front = frontWindow();
  const keys = [...PINNED, ...state.windows.map(win => win.key).filter(key => !PINNED.includes(key))];
  $('task-apps').replaceChildren(...keys.map(key => {
    const win = state.windows.find(other => other.key === key);
    const button = el('button', `task-button${win ? ' running' : ''}${win && win === front ? ' focused' : ''}`);
    button.title = APPS[key].name;
    button.append(appIcon(key));
    button.onclick = () => {
      if (win && win === front) minimizeWindow(win);
      else openApp(key);
    };
    return button;
  }));
}

function renderStart() {
  $('start-apps').replaceChildren(...['browser', 'calls', 'mail', 'sheet', 'explorer', 'taskmgr'].map(key => {
    const button = el('button', 'start-app');
    button.append(appIcon(key), el('span', '', APPS[key].name.replace('Microsoft ', '').replace('Google ', '')));
    button.onclick = () => openApp(key);
    return button;
  }));
  const recent = [
    ['sheet', 'Applications October.xlsx', '12m ago'],
    ['sheet', 'Intake tracker Jan 2027.xlsx', 'Yesterday at 17:40'],
    ['explorer', 'Offer letters', 'Yesterday at 16:05'],
    ['mail', 'Visa desk: CAS checklist', 'Monday at 11:20']
  ];
  $('start-recent').replaceChildren(...recent.map(([key, name, when]) => {
    const button = el('button', 'recent-item');
    const text = el('span');
    text.append(el('b', '', name), el('span', '', when));
    button.append(appIcon(key), text);
    button.onclick = () => openApp(key);
    return button;
  }));
  $('start-avatar').textContent = initials(state.user.name);
  $('start-name').textContent = state.user.name;
}

function closeMenus() {
  for (const id of ['start', 'user-menu', 'power-menu']) $(id).hidden = true;
}

// ---------- Screens: sign-in, lock, sleep, shut down ----------

function show(screen, text = '') {
  state.screen = screen;
  $('signin').hidden = screen !== 'signin' && screen !== 'unlock';
  $('lock').hidden = screen !== 'locked';
  $('desktop').hidden = screen !== 'desktop';
  $('black').hidden = !['asleep', 'off', 'restarting'].includes(screen);
  $('black-text').textContent = text;
  closeMenus();
  if (screen === 'signin' || screen === 'unlock') renderSignIn();
  changed();
}

function renderSignIn() {
  const unlocking = state.screen === 'unlock';
  const person = unlocking ? state.user : state.selected;
  $('signin-avatar').textContent = person ? initials(person.name) : '';
  $('signin-name').textContent = person ? person.name : '';
  // Unlocking is only for the person already signed in; the full list is for signing in.
  $('users').hidden = unlocking;
  $('users').replaceChildren(...state.people.map(other => {
    const item = el('button', `user-item${other === person ? ' selected' : ''}`);
    item.append(el('span', 'avatar', initials(other.name)), el('span', '', other.name));
    item.onclick = () => { state.selected = other; renderSignIn(); };
    return item;
  }));
}

function signIn() {
  if (state.screen === 'unlock') {
    show('desktop');
    noteInput();
    return;
  }
  state.user = state.selected;
  // A new session starts now: the time before signing in isn't "away".
  state.input.lastPerf = performance.now();
  state.lastManualPerf = 0;
  agent.myday = null;
  renderStart();
  renderTaskbar();
  show('desktop');
  noteInput();
  agentStart();
}

function lock() {
  show('locked');
}

function lockScreenClicked() {
  // The click that woke the laptop only shows the lock screen; the next one goes to the password screen.
  if (performance.now() - state.wokeAt < 800) return;
  show('unlock');
}

// A sleeping laptop drops every connection, the browser's pages included; waking brings them back.
function suspendPages(asleep) {
  for (const frame of document.querySelectorAll('.page iframe')) {
    if (asleep) {
      frame.dataset.src = frame.getAttribute('src');
      frame.src = 'about:blank';
    } else if (frame.dataset.src) {
      frame.src = frame.dataset.src;
    }
  }
}

function sleep() {
  agentStop('sleep');
  suspendPages(true);
  show('asleep');
}

// Waking shows the lock screen, as Windows does; the desktop app starts again straight away.
function wake() {
  state.wokeAt = performance.now();
  suspendPages(false);
  show('locked');
  agentStart();
}

function endSession(goodbye) {
  agentStop(goodbye);
  for (const win of [...state.windows]) closeWindow(win);
  state.mic.clear();
  state.user = null;
  renderTray();
}

function signOut() {
  endSession('signout');
  show('signin');
}

function shutDown() {
  endSession('shutdown');
  show('off');
}

function restart() {
  endSession('shutdown');
  show('restarting', 'Restarting');
  setTimeout(() => show('signin'), 2500);
}

function blackClicked() {
  if (state.screen === 'asleep') wake();
  else if (state.screen === 'off') show('signin');
}

async function loadPeople() {
  state.people = await (await fetch('/api/employees')).json();
  state.selected = state.people[0];
  renderSignIn();
}

// ---------- Pretend apps ----------

const STUDENTS = [
  ['358120', 'Riya Sen', 'University of Leeds', 'MSc Data Science', 'Jan 2027', 'Conditional offer'],
  ['358121', 'Arjun Mehta', 'Coventry University', 'MBA', 'Jan 2027', 'Documents requested'],
  ['358122', 'Sara Ali', 'University of Kent', 'BSc Psychology', 'Sep 2027', 'Submitted'],
  ['358123', 'Kabir Nair', 'University of Northbridge', 'MSc Finance', 'Jan 2027', 'Unconditional offer'],
  ['358124', 'Meera Iyer', 'University of Leeds', 'MA Education', 'Sep 2027', 'Interview booked'],
  ['358125', 'Dev Malhotra', 'University of Kent', 'LLM', 'Jan 2027', 'CAS requested'],
  ['358126', 'Tanya Ghosh', 'Coventry University', 'MSc Nursing', 'May 2027', 'Submitted'],
  ['358127', 'Ishaan Roy', 'University of Northbridge', 'BEng Civil Engineering', 'Sep 2027', 'Conditional offer']
];

function favicon(text, colour) {
  const icon = el('span', 'favicon', text);
  icon.style.background = colour;
  return icon;
}

function buildBrowser(win) {
  const tabs = [
    { title: 'Staff Console', address: `${location.host}`, frame: '/', icon: ['C', '#ff6525'] },
    { title: 'Training Management System', address: `${location.host}/tms`, frame: '/tms', icon: ['C', '#ff6525'] },
    { title: 'Applicant portal | University of Northbridge', address: 'applicants.northbridge.ac.uk/partner', page: universityPage, icon: ['N', '#3b2a5c'] },
    { title: 'Morning Herald: Kolkata news', address: 'morningherald.example/kolkata', page: newsPage, icon: ['MH', '#111'] }
  ];
  const toolbar = el('div', 'toolbar');
  const url = el('span');
  const omnibox = el('div', 'omnibox');
  omnibox.append(glyph(0xE72E, 'small'), url);
  toolbar.append(el('button', 'tool glyph', ''), el('button', 'tool glyph', ''), el('button', 'tool glyph', ''), omnibox,
    el('span', 'avatar profile', initials(state.user.name)), el('button', 'tool glyph', ''));
  const page = el('div', 'page');
  let active = null;

  function select(tab) {
    active = tab;
    if (!tab.node) {
      if (tab.frame) {
        tab.node = el('iframe');
        tab.node.src = tab.frame;
        tab.node.title = tab.title;
        // The page inside is a separate document: listen to it too, and bring the browser to the front when used.
        tab.node.addEventListener('load', () => {
          try {
            listenForInput(tab.node.contentWindow);
            tab.node.contentWindow.addEventListener('pointerdown', () => focusWindow(win), true);
          } catch {}
        });
      } else {
        tab.node = tab.page();
      }
      page.append(tab.node);
    }
    for (const other of tabs) {
      if (other.node) other.node.hidden = other !== tab;
      other.button.classList.toggle('active', other === tab);
    }
    url.textContent = tab.address;
    changed();
  }

  for (const tab of tabs) {
    tab.button = el('button', 'tab');
    tab.button.append(favicon(...tab.icon), el('span', 'tab-title', tab.title), glyph(0xE8BB));
    tab.button.onclick = () => select(tab);
    win.tabStrip.append(tab.button);
  }
  win.tabStrip.append(el('button', 'new-tab glyph', ''));
  win.body.append(toolbar, page);
  win.title = () => `${active.title} - Google Chrome`;
  select(tabs[0]);
}

function universityPage() {
  const site = el('div', 'site-uni');
  const head = el('div', 'uni-head');
  head.append(el('b', '', 'University of Northbridge'), el('div', '', 'Applicant portal · Partner access'));
  const body = el('div', 'uni-body');
  const list = el('div', 'uni-card');
  const table = el('table');
  for (const [, name, , course, intake, status] of STUDENTS.filter(row => row[2] === 'University of Northbridge')) {
    const row = el('tr');
    row.append(el('td', '', name), el('td', '', course), el('td', '', intake), el('td', '', status));
    table.append(row);
  }
  list.append(el('b', '', 'Your applicants'), table);
  const form = el('div', 'uni-card');
  const subject = el('input');
  const message = el('textarea');
  message.rows = 4;
  const send = el('button', 'send', 'Send');
  send.onclick = () => { subject.value = ''; message.value = ''; };
  form.append(el('b', '', 'Message admissions'), el('label', '', 'Subject'), subject, el('label', '', 'Message'), message, send);
  body.append(list, form);
  site.append(head, body);
  return site;
}

function newsPage() {
  const site = el('div', 'site-news');
  site.append(el('h2', '', 'Morning Herald'), el('div', 'muted', 'Kolkata edition'));
  for (const [headline, text] of [
    ['Monsoon forecast revised for eastern states', 'Rainfall is now expected to ease by the middle of next week.'],
    ['Metro extends late-night service', 'Trains will run until midnight on weekdays from next month.'],
    ['Home side wins series opener', 'A late partnership sealed a four-wicket win.']
  ]) {
    const item = el('div', 'news-item');
    item.append(el('b', '', headline), el('span', 'muted', text));
    site.append(item);
  }
  return site;
}

function buildCalls(win) {
  win.setTitle('Calls | Microsoft Teams');
  const wrap = el('div', 'calls');
  const rail = el('div', 'teams-rail');
  for (const [code, label] of [[0xEA8F, 'Activity'], [0xE8BD, 'Chat'], [0xE716, 'Teams'], [0xE787, 'Calendar'], [0xE717, 'Calls']]) {
    const item = el('div', label === 'Calls' ? 'on' : '');
    item.append(glyph(code), el('span', '', label));
    rail.append(item);
  }
  const list = el('div', 'calls-list');
  list.append(el('h4', '', 'Calls'));
  const stage = el('div', 'call-stage');
  let timer = null;

  function idle() {
    clearInterval(timer);
    state.mic.delete('ms-teams.exe');
    stage.className = 'call-stage';
    const dial = glyph(0xE717);
    dial.style.fontSize = '48px';
    stage.replaceChildren(dial, el('span', '', 'Make a call'));
    renderTray();
    changed();
  }

  // On a call the microphone stays in use even when muted, as it does in real call apps.
  function call(name) {
    const started = Date.now();
    const clock = el('span', '', '00:00');
    const top = el('div', 'call-top');
    top.append(el('span', '', name), clock);
    const person = el('div', 'call-person');
    person.append(el('span', 'avatar', initials(name)), el('b', '', name));
    const control = (code, label) => {
      const button = el('button');
      button.append(glyph(code), el('span', '', label));
      return button;
    };
    const mic = control(0xE720, 'Mic');
    mic.onclick = () => {
      const muted = mic.dataset.muted !== 'yes';
      mic.dataset.muted = muted ? 'yes' : 'no';
      mic.firstChild.textContent = String.fromCodePoint(muted ? 0xEC54 : 0xE720);
    };
    const leave = el('button', 'leave');
    leave.append(glyph(0xE778), el('span', '', 'Leave'));
    leave.onclick = idle;
    const controls = el('div', 'call-controls');
    controls.append(mic, control(0xE714, 'Camera'), control(0xE72D, 'Share'), control(0xE712, 'More'), leave);
    stage.className = 'call-stage live';
    stage.replaceChildren(top, person, controls);
    clearInterval(timer);
    timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      clock.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    }, 1000);
    state.mic.set('ms-teams.exe', 'Microsoft Teams');
    renderTray();
    changed();
  }

  for (const name of ['Admissions team', 'Rahul Sharma', 'Oliver Smith', 'Visa desk']) {
    const contact = el('button', 'contact');
    contact.append(el('span', 'avatar', initials(name)), el('span', '', name), glyph(0xE717, 'call-glyph'));
    contact.onclick = () => call(name);
    list.append(contact);
  }
  wrap.append(rail, list, stage);
  win.body.append(wrap);
  win.onClose = idle;
  idle();
}

function ribbonTabs(names, on) {
  const tabs = el('div', 'ribbon-tabs');
  for (const name of names) tabs.append(el('span', name === on ? 'on' : '', name));
  return tabs;
}

function buildMail(win) {
  win.setTitle(`Inbox - ${state.user.name} - Outlook`);
  const mails = [
    ['University of Northbridge Admissions', 'Conditional offer: Kabir Nair (MSc Finance)', 'Dear partner,\n\nWe are pleased to confirm an offer for Kabir Nair for the January 2027 intake. Please upload the final transcript by 15 November.\n\nAdmissions Office'],
    ['Visa desk', 'CAS checklist for Arjun Mehta', 'Hi,\n\nBefore we request the CAS, please confirm the bank statement dates and the passport number on file.\n\nThanks'],
    ['Accommodation team', 'Room hold for Sara Ali', 'Hello,\n\nWe have held an en-suite room in Canterbury until Friday. Let us know if the student would like to confirm.\n\nRegards'],
    ['Rahul Sharma', 'Leads for Thursday', 'Hi,\n\nI have shared five new leads from the Kolkata fair. Can you take the two MBA ones?\n\nRahul'],
    ['IT Service Desk', 'Crizac Activity is now on your laptop', 'Hello,\n\nCrizac Activity is now installed on company laptops. It records the app in use, the time since your last input, when the microphone is in use (to mark calls) and when the screen is locked.\n\nIt does not record keystrokes, screenshots, audio or window titles. You can see your own day under "My day" in the staff console.\n\nIT Service Desk']
  ];
  const ribbon = el('div', 'ribbon');
  const newMail = el('button', 'tool');
  newMail.style.cssText = 'width:auto;padding:0 12px;border-radius:4px;background:#0f6cbd;color:#fff;display:flex;gap:8px;align-items:center';
  newMail.append(glyph(0xE715), el('span', '', 'New mail'));
  ribbon.append(newMail, el('span', 'sep'));
  for (const code of [0xE74D, 0xE7B8, 0xE97A, 0xE8C2, 0xE72D, 0xE7C1]) ribbon.append(el('button', 'tool glyph', String.fromCodePoint(code)));

  const wrap = el('div', 'mail');
  const folders = el('div', 'mail-folders');
  for (const [name, on] of [['Inbox  5', true], ['Drafts'], ['Sent Items'], ['Archive'], ['Deleted Items']]) folders.append(el('div', on ? 'on' : '', name));
  const list = el('div', 'mail-list');
  const read = el('div', 'mail-read');

  function open(index, button) {
    for (const other of list.children) other.classList.toggle('active', other === button);
    const [from, subject, text] = mails[index];
    const reply = el('textarea');
    reply.placeholder = 'Reply';
    const body = el('div');
    body.style.whiteSpace = 'pre-wrap';
    body.textContent = text;
    read.replaceChildren(el('h3', '', subject), el('div', 'muted', from), el('hr'), body, reply);
  }

  mails.forEach(([from, subject], index) => {
    const button = el('button', 'mail-item');
    button.append(el('b', '', from), el('span', '', subject));
    button.onclick = () => open(index, button);
    list.append(button);
  });
  wrap.append(folders, list, read);
  win.body.append(ribbonTabs(['File', 'Home', 'View', 'Help'], 'Home'), ribbon, wrap);
  open(0, list.firstChild);
}

function buildSheet(win) {
  win.setTitle('Applications October.xlsx - Excel');
  const ribbon = el('div', 'ribbon');
  for (const code of [0xE77F, 0xE8C6, 0xE8C8]) ribbon.append(el('button', 'tool glyph', String.fromCodePoint(code)));
  ribbon.append(el('span', 'sep'), el('span', 'format', 'Aptos Narrow'), el('span', 'format', '11'));
  for (const code of [0xE8DD, 0xE8DB, 0xE8DC]) ribbon.append(el('button', 'tool glyph', String.fromCodePoint(code)));
  ribbon.append(el('span', 'sep'));
  for (const code of [0xE8E4, 0xE8E3, 0xE8E2]) ribbon.append(el('button', 'tool glyph', String.fromCodePoint(code)));
  ribbon.append(el('span', 'sep'), el('span', 'format', 'General'));

  const nameBox = el('span', 'name-box', 'A1');
  const formula = el('span', 'formula', 'CAMS ID');
  const bar = el('div', 'formula-bar');
  bar.append(nameBox, el('span', 'fx', 'fx'), formula);

  const columns = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const rows = [['CAMS ID', 'Student', 'University', 'Course', 'Intake', 'Status', ''], ...STUDENTS.map(row => [...row, '']), ...Array.from({ length: 14 }, () => columns.map(() => ''))];
  const wrap = el('div', 'sheet');
  const table = el('table');
  const head = el('tr');
  head.append(el('th', '', ''), ...columns.map(column => el('th', '', column)));
  table.append(head);
  rows.forEach((values, index) => {
    const row = el('tr');
    row.append(el('th', '', String(index + 1)));
    values.forEach((value, column) => {
      const cell = el('td', '', value);
      if (index === 0) cell.style.fontWeight = '700';
      cell.contentEditable = 'true';
      cell.onfocus = () => { nameBox.textContent = `${columns[column]}${index + 1}`; formula.textContent = cell.textContent; };
      cell.oninput = () => { formula.textContent = cell.textContent; };
      row.append(cell);
    });
    table.append(row);
  });
  wrap.append(table);
  const sheets = el('div', 'sheet-tabs');
  sheets.append(el('span', 'on', 'Sheet1'), glyph(0xE710, 'small'));
  win.body.append(ribbonTabs(['File', 'Home', 'Insert', 'Draw', 'Page Layout', 'Formulas', 'Data', 'Review', 'View', 'Help'], 'Home'), ribbon, bar, wrap, sheets, el('div', 'status-bar', 'Ready'));
}

function buildExplorer(win) {
  const tab = el('button', 'tab active');
  tab.append(appIcon('explorer', 'favicon'), el('span', 'tab-title', 'Documents'), glyph(0xE8BB));
  win.tabStrip.append(tab, el('button', 'new-tab glyph', ''));
  win.title = () => 'Documents - File Explorer';

  const address = el('div', 'explorer-address');
  const path = el('div', 'path');
  path.append(glyph(0xE8B7, 'small'), glyph(0xE76C, 'small'), el('span', '', 'This PC'), glyph(0xE76C, 'small'), el('span', '', 'Documents'));
  const find = el('div', 'find', 'Search Documents');
  address.append(el('button', 'tool glyph', ''), el('button', 'tool glyph', ''), el('button', 'tool glyph', ''), el('button', 'tool glyph', ''), path, find);

  const bar = el('div', 'explorer-bar');
  const label = (code, text) => {
    const item = el('span', 'label');
    item.append(glyph(code), el('span', '', text));
    return item;
  };
  bar.append(label(0xE710, 'New'));
  for (const code of [0xE8C6, 0xE8C8, 0xE77F, 0xE8AC, 0xE72D, 0xE74D]) bar.append(el('button', 'tool glyph', String.fromCodePoint(code)));
  bar.append(label(0xE8CB, 'Sort'), label(0xE8A9, 'View'), el('button', 'tool glyph', ''));

  const nav = el('div', 'explorer-nav');
  for (const [code, name, on] of [[0xE80F, 'Home'], [0xE91B, 'Gallery'], [0xE7F4, 'Desktop'], [0xE896, 'Downloads'], [0xE8A5, 'Documents', true], [0xEB9F, 'Pictures'], [0xE8D6, 'Music']]) {
    const item = el('div', on ? 'on' : '');
    item.append(glyph(code), el('span', '', name));
    nav.append(item);
  }
  const files = el('div', 'explorer-files');
  const table = el('table');
  const head = el('tr');
  for (const name of ['Name', 'Date modified', 'Type', 'Size']) head.append(el('th', '', name));
  table.append(head);
  for (const [name, date, type, size, opens] of [
    ['Offer letters', '27/10/2026 16:05', 'File folder', ''],
    ['Visa checklists', '21/10/2026 11:42', 'File folder', ''],
    ['Applications October.xlsx', '28/10/2026 10:12', 'Microsoft Excel Worksheet', '24 KB', 'sheet'],
    ['Intake tracker Jan 2027.xlsx', '27/10/2026 17:40', 'Microsoft Excel Worksheet', '18 KB', 'sheet']
  ]) {
    const row = el('tr', 'file');
    const cell = el('td');
    const fileName = el('span', 'file-name');
    fileName.append(opens ? appIcon(opens) : appIcon('explorer'), el('span', '', name));
    cell.append(fileName);
    row.append(cell, el('td', 'muted', date), el('td', 'muted', type), el('td', 'muted', size));
    row.onclick = () => { for (const other of table.querySelectorAll('tr.file')) other.classList.toggle('selected', other === row); };
    if (opens) row.ondblclick = () => openApp(opens);
    table.append(row);
  }
  files.append(table);
  const wrap = el('div', 'explorer');
  wrap.append(nav, files);
  win.body.append(address, bar, wrap);
}

function buildTaskManager(win) {
  const wrap = el('div', 'taskmgr');
  const rail = el('div', 'taskmgr-rail');
  for (const [code, on] of [[0xE700], [0xE8FD, true], [0xE9D2], [0xE81C], [0xE7B5], [0xE716], [0xE8A9], [0xE713]]) {
    const item = el('span', on ? 'on' : '');
    item.append(glyph(code));
    rail.append(item);
  }
  const main = el('div', 'taskmgr-main');
  const head = el('div', 'taskmgr-head');
  const button = (code, text) => {
    const item = el('button', 'label');
    item.append(glyph(code), el('span', '', text));
    return item;
  };
  const end = button(0xE711, 'End task');
  head.append(el('b', '', 'Processes'), button(0xE8F4, 'Run new task'), end);
  const scroll = el('div', 'taskmgr-list');
  main.append(head, scroll);
  wrap.append(rail, main);
  win.body.append(wrap);
  let selected = null;

  const memory = { explorer: 74.3, browser: 612.4, calls: 388.1, mail: 241.7, sheet: 133.9, taskmgr: 38.2 };
  function render() {
    if (win.closed) return clearInterval(refresh);
    const apps = state.windows.map(other => ({ id: `app:${other.key}`, name: APPS[other.key].name, key: other.key, memory: memory[other.key] }));
    const background = [
      ...(agent.running ? [{ id: 'agent', name: 'Crizac Activity', memory: 18.6 }] : []),
      { id: 'service', name: 'Crizac Activity Service', memory: 4.1 }
    ];
    const table = el('table');
    const columns = el('tr');
    const heading = (top, label) => {
      const cell = el('th');
      if (top) cell.append(el('b', '', top));
      cell.append(document.createTextNode(label));
      return cell;
    };
    columns.append(heading('', 'Name'), heading('', 'Status'), heading(`${3 + Math.floor(Math.random() * 4)}%`, 'CPU'), heading('48%', 'Memory'));
    table.append(columns);
    const group = (label, items) => {
      const row = el('tr', 'group');
      const cell = el('td', '', `${label} (${items.length})`);
      cell.colSpan = 4;
      row.append(cell);
      table.append(row);
      for (const item of items) {
        const process = el('tr', `process${selected === item.id ? ' selected' : ''}`);
        const name = el('td');
        const cell = el('span', 'name-cell');
        cell.append(item.key ? appIcon(item.key) : el('span', 'tray-logo', 'C'), document.createTextNode(item.name));
        name.append(cell);
        const cpu = (Math.random() * (item.key ? 2.5 : 0.3)).toFixed(1);
        process.append(name, el('td', '', ''), el('td', 'heat', `${cpu}%`), el('td', 'heat', `${item.memory.toFixed(1)} MB`));
        process.onclick = () => { selected = item.id; render(); };
        table.append(process);
      }
    };
    group('Apps', apps);
    group('Background processes', background);
    scroll.replaceChildren(table);
    end.disabled = ![...apps, ...background].some(item => item.id === selected);
  }

  end.onclick = () => {
    if (selected === 'service') {
      showDialog('Unable to terminate process', 'The operation could not be completed. Access is denied.');
    } else if (selected === 'agent') {
      // Ended without warning: the server sees the desktop app go silent. Its watchdog service starts it again.
      agentStop(null);
      setTimeout(() => { if (state.user && state.screen !== 'asleep') agentStart(); }, (agent.config.watchdog ?? 5) * 1000);
    } else if (selected?.startsWith('app:')) {
      const target = state.windows.find(other => `app:${other.key}` === selected);
      if (target) closeWindow(target);
    }
    selected = null;
    render();
  };

  const refresh = setInterval(render, 1000);
  render();
}

// ---------- Crizac Activity: the employee's own window ----------

const STATUS_NAMES = { working: 'Working', active: 'Active', idle: 'Idle', away: 'Away', call: 'On a call', meeting: 'In a meeting', break: 'On a break', logged_out: 'Signed out' };
const STATUS_OPTIONS = [
  ['auto', 'Automatic', 'Calls on Teams, Zoom and WhatsApp switch this on by themselves'],
  ['call', 'On a call', 'A phone or video call the laptop can’t see'],
  ['meeting', 'In a meeting', 'In person or online'],
  ['break', 'On a break', 'Lunch, tea or a short break']
];
// The window is built once; each second only its text changes, so clicks always land.
const activityView = { win: null, page: 'today', parts: null };

function buildActivity(win) {
  const wrap = el('div', 'activity');
  const nav = el('nav', 'activity-nav');
  const connection = el('div', 'activity-connection');
  const profile = el('div', 'activity-profile');
  const who = el('div', 'activity-who');
  who.append(el('b', '', state.user.name), connection);
  profile.append(el('span', 'avatar', initials(state.user.name)), who);
  nav.append(profile);
  const main = el('div', 'activity-main');
  const pages = {};
  for (const [key, code, label] of [['today', 0xE80F, 'Today'], ['status', 0xE916, 'Status'], ['privacy', 0xE72E, 'Privacy']]) {
    const item = el('button', 'nav-item');
    item.append(glyph(code), el('span', '', label));
    item.onclick = () => {
      activityView.page = key;
      renderActivity();
    };
    const node = el('section', 'activity-page');
    node.append(el('h1', '', label));
    nav.append(item);
    main.append(node);
    pages[key] = { item, node };
  }

  const today = el('div');
  pages.today.node.append(today);

  const options = {};
  for (const [key, title, description] of STATUS_OPTIONS) {
    const option = el('button', 'option');
    const text = el('span', 'option-text');
    text.append(el('b', '', title), el('span', '', description));
    option.append(el('span', 'radio'), text);
    option.onclick = () => {
      agentSend({ type: 'status', status: key === 'auto' ? null : key });
      // Show the choice straight away; the server confirms it within a second.
      agent.you = { ...(agent.you || {}), state: key === 'auto' ? 'active' : key, manualEndsIn: key === 'auto' ? false : agent.config.manualMax };
      if (key !== 'auto') state.lastManualPerf = performance.now();
      renderActivity();
    };
    options[key] = option;
  }
  const statusNote = el('p', 'status-note');
  const optionCard = el('div', 'option-list');
  optionCard.append(...Object.values(options));
  pages.status.node.append(optionCard, statusNote);

  const card = (title, ...content) => {
    const box = el('div', 'card');
    box.append(el('h2', '', title), ...content);
    return box;
  };
  const list = (items, code, className) => {
    const ul = el('ul', `check-list ${className}`);
    for (const item of items) {
      const li = el('li');
      li.append(glyph(code), el('span', '', item));
      ul.append(li);
    }
    return ul;
  };
  pages.privacy.node.append(
    card('Sent to Crizac', list(['Which app or work website is in front', 'How long since you last used the mouse or keyboard (not what you typed)',
      'Whether the microphone is in use (never the sound)', 'Whether the screen is locked', 'Work you save in Crizac apps'], 0xE73E, 'yes')),
    card('Never collected', list(['What you type', 'Screenshots or what’s on your screen', 'Audio or video', 'Window titles, email subjects or file names'], 0xE711, 'no')),
    card('Who can see it', list(['You: everything on these pages', 'Your manager: your status, apps in use, activity, work done and flags'], 0xE716, 'who')),
    el('p', 'managed', 'Managed by Crizac IT')
  );

  wrap.append(nav, main);
  win.body.append(wrap);
  win.onClose = () => { activityView.win = null; };
  Object.assign(activityView, { win, parts: { connection, pages, today, options, statusNote } });
  agentSend({ type: 'myday' });
  renderActivity();
}

function renderActivity() {
  const { win, parts, page } = activityView;
  if (!win || win.closed) return;
  for (const [key, { item, node }] of Object.entries(parts.pages)) {
    item.classList.toggle('on', key === page);
    node.hidden = key !== page;
  }
  const connected = agent.ws?.readyState === WebSocket.OPEN && !agent.signedOut;
  const link = !agent.running ? 'Not running' : agent.signedOut ? 'Signed out' : connected ? 'Connected' : 'Connecting…';
  parts.connection.replaceChildren(el('i', `dot${connected ? '' : ' off'}`), document.createTextNode(link));
  if (page === 'today') renderToday(parts.today);
  if (page === 'status') renderStatus(parts);
}

function renderToday(container) {
  const you = agent.you;
  const day = agent.myday;
  const sent = agent.lastSent;
  const nowCard = el('div', 'card now-card');
  const line = el('div', 'now-line');
  const current = you?.state || 'logged_out';
  line.append(el('i', `status-dot ${current}`), el('b', '', STATUS_NAMES[current] || current));
  const detected = current === 'call' && typeof you.manualEndsIn !== 'number';
  if (detected) line.append(el('span', 'muted', 'detected from your microphone'));
  else if (MANUAL.includes(current) && you.manualEndsIn) line.append(el('span', 'muted', `back to Automatic in ${duration(you.manualEndsIn)}`));
  nowCard.append(el('h2', '', 'Right now'), line);
  if (sent) {
    const inFront = PROCESS_NAMES[sent.app] || sent.app;
    const grid = el('div', 'sent-grid');
    for (const [label, value] of [
      ['App in front', sent.site ? `${sent.site} (${inFront})` : inFront],
      ['Last input', `${sent.secondsSinceInput}s ago`],
      ['Microphone', sent.micApps.length ? 'In use' : 'Not in use'],
      ['Screen', sent.locked ? 'Locked' : 'Unlocked']
    ]) {
      const cell = el('div');
      cell.append(el('span', 'muted', label), el('b', '', value));
      grid.append(cell);
    }
    nowCard.append(grid, el('div', 'sent-at muted', `Last sent ${new Date(sent.at).toLocaleTimeString('en-GB')}`));
  }

  if (!day) {
    container.replaceChildren(nowCard);
    return;
  }
  const atComputer = day.totals.working + day.totals.active + day.totals.idle;
  const stats = el('div', 'stat-row');
  for (const [value, label] of [[duration(atComputer), 'At the computer'], [day.activity === null ? '–' : `${day.activity}%`, 'Activity'], [String(day.workCount), 'Work done']]) {
    const box = el('div', 'card stat-card');
    box.append(el('b', '', value), el('span', 'muted', label));
    stats.append(box);
  }
  const other = el('div', 'other-time muted');
  other.textContent = `Calls and meetings ${duration(day.totals.call + day.totals.meeting)} · Breaks ${duration(day.totals.break)} · Away ${duration(day.totals.away)}`;

  const apps = el('div', 'card');
  apps.append(el('h2', '', 'Time by app'));
  const longest = Math.max(1, ...day.apps.map(app => app.seconds));
  if (!day.apps.length) apps.append(el('p', 'muted', 'Nothing yet'));
  for (const app of day.apps.slice(0, 6)) {
    const row = el('div', 'app-bar');
    const bar = el('span', 'bar');
    const fill = el('i');
    fill.style.width = `${Math.max(2, (app.seconds / longest) * 100)}%`;
    bar.append(fill);
    row.append(el('span', 'app-name', app.name), bar, el('span', 'muted', duration(app.seconds)));
    apps.append(row);
  }

  const work = el('div', 'card');
  work.append(el('h2', '', 'Work done'));
  if (!day.workLog.length) work.append(el('p', 'muted', 'Nothing yet'));
  const ul = el('ul', 'work-list');
  for (const item of day.workLog.slice(0, 8)) {
    const li = el('li');
    li.append(el('time', 'muted', new Date(item.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })), el('span', '', item.label), el('span', 'tag', item.app));
    ul.append(li);
  }
  work.append(ul);
  container.replaceChildren(nowCard, stats, other, apps, work);
}

function renderStatus({ options, statusNote }) {
  const you = agent.you;
  const current = you?.state;
  const manual = MANUAL.includes(current) && typeof you.manualEndsIn === 'number';
  const chosen = manual ? current : 'auto';
  for (const [key, option] of Object.entries(options)) option.classList.toggle('on', key === chosen);
  if (manual) statusNote.textContent = `Goes back to Automatic by itself in ${duration(you.manualEndsIn)}.`;
  else if (current === 'call') statusNote.textContent = 'On a call right now: detected from your microphone.';
  else statusNote.textContent = current ? `Right now: ${STATUS_NAMES[current] || current}.` : '';
}

function showDialog(title, text) {
  $('dialog-title').textContent = title;
  $('dialog-text').textContent = text;
  $('dialog').hidden = false;
}

// ---------- Clock and wiring ----------

function tickClock() {
  const now = new Date();
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  $('clock-time').textContent = time;
  $('clock-date').textContent = now.toLocaleDateString('en-GB');
  $('lock-time').textContent = time;
  $('lock-date').textContent = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  // The employee window keeps itself up to date while it's open.
  if (isOpen('activity')) {
    renderActivity();
    if (now.getSeconds() % 3 === 0) agentSend({ type: 'myday' });
  }
}

listenForInput(window);
window.addEventListener('resize', fitWindows);
$('start-button').onclick = () => {
  const open = $('start').hidden;
  closeMenus();
  $('start').hidden = !open;
};
$('user-button').onclick = () => { $('user-menu').hidden = !$('user-menu').hidden; $('power-menu').hidden = true; };
$('power-button').onclick = () => { $('power-menu').hidden = !$('power-menu').hidden; $('user-menu').hidden = true; };
for (const item of document.querySelectorAll('[data-action]')) {
  item.onclick = () => ({ lock, signout: signOut, sleep, shutdown: shutDown, restart })[item.dataset.action]();
}
$('tray-app').onclick = () => openApp('activity');
$('jiggler').onclick = toggleJiggler;
$('lock').onclick = lockScreenClicked;
$('black').onclick = blackClicked;
$('signin-button').onclick = signIn;
$('dialog-ok').onclick = () => { $('dialog').hidden = true; };
$('windows').addEventListener('pointerdown', event => { if (event.target === $('windows')) closeMenus(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeMenus();
  if (event.key === 'Enter' && (state.screen === 'signin' || state.screen === 'unlock')) signIn();
});
setInterval(tickClock, 1000);
tickClock();
show('signin');
loadPeople();
