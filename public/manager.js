// Manager side of the demo, built for thousands of people. The page tells the server what it is looking at (search,
// team, office, status, sort, and which rows are on screen); once a second the server answers with the totals, just
// those rows, and the full detail of the person whose panel is open.
// Uses STATE_LABELS, duration, el, initials, localTime, appTime and blockChart from shared.js.
const $ = id => document.getElementById(id);
const ROW = 56;     // height of one person's row; only the rows on screen are drawn
const BUFFER = 15;  // rows drawn above and below what's visible, so fast scrolling never shows a gap
const STATUSES = ['working', 'active', 'idle', 'away', 'call', 'meeting', 'break', 'logged_out'];
const FLAG_LABELS = { noWork: 'Nothing saved', regular: 'Too regular', stopped: 'Tracker off' };
const SORT_TITLES = { attention: '', name: 'by name', status: 'by status', activity: 'lowest activity first', work: 'most work first', longest: 'longest in status first' };

const view = { search: '', team: '', office: '', status: '', sort: 'attention', offset: 0, limit: 60 };
let socket = null;
let snapshot = null;
let detailId = null;
let sentView = '';

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendView() {
  const text = JSON.stringify(view);
  if (text === sentView) return;
  sentView = text;
  send({ type: 'view', ...view });
}

// Asks for the rows around what's on screen whenever the list scrolls far enough.
function updateWindow() {
  const scroller = $('scroller');
  const first = Math.floor(scroller.scrollTop / ROW);
  const visible = Math.ceil(scroller.clientHeight / ROW);
  const offset = Math.max(0, first - BUFFER);
  const limit = Math.min(200, visible + BUFFER * 2);
  if (Math.abs(offset - view.offset) >= 5 || limit !== view.limit) {
    view.offset = offset;
    view.limit = limit;
    sendView();
  }
}

function setFilter(changes) {
  Object.assign(view, changes, { offset: 0 });
  $('scroller').scrollTop = 0;
  sendView();
  if (snapshot) renderControls(snapshot);
}

const sinceText = seconds => (seconds === null || seconds === undefined ? '' : seconds < 60 ? `${seconds}s` : roundDuration(seconds));

// ---------- Top: clocks, headcount, status filters, teams ----------

function renderControls({ overview, now, botsOnline }) {
  $('clocks').replaceChildren(...overview.offices.map(({ name, timeZone }) => {
    const clock = el('span', 'clock');
    clock.append(el('span', '', name), el('b', '', localTime(now, timeZone)));
    return clock;
  }));
  const bots = botsOnline ? ` · load test: ${botsOnline.toLocaleString()} simulated` : '';
  $('headcount').textContent = `${overview.people.toLocaleString()} people · ${overview.online.toLocaleString()} online${bots}`;

  const chip = (key, count, label, className = '') => {
    const button = el('button', `summary-item${count ? '' : ' zero'}${view.status === key ? ' on' : ''}${className}`);
    const text = el('span', 'summary-label');
    if (key !== 'flagged') text.append(el('i', `dot ${key}`));
    text.append(document.createTextNode(label));
    button.append(el('b', '', count.toLocaleString()), text);
    button.onclick = () => setFilter({ status: view.status === key ? '' : key });
    return button;
  };
  $('summary').replaceChildren(
    ...STATUSES.map(state => chip(state, overview.counts[state], STATE_LABELS[state])),
    chip('flagged', overview.flagged, '⚑ Needs a look', ' flagged')
  );

  const all = el('button', `team-card all${view.team ? '' : ' on'}`);
  all.append(el('span', 'team-name', 'All teams'), el('span', 'team-count', overview.people.toLocaleString()));
  all.onclick = () => setFilter({ team: '' });
  $('teams').replaceChildren(all, ...overview.teams.map(team => {
    const card = el('button', `team-card${view.team === team.name ? ' on' : ''}`);
    const head = el('span', 'team-line');
    head.append(el('span', 'team-name', team.name), el('span', 'team-count', team.people.toLocaleString()));
    // One bar per team: how its people who are online split between statuses.
    const bar = el('span', 'team-bar');
    for (const state of STATUSES.slice(0, 7)) {
      if (!team.counts[state]) continue;
      const part = el('i');
      part.style.flexGrow = String(team.counts[state]);
      part.style.background = `var(--${state})`;
      part.title = `${STATE_LABELS[state]}: ${team.counts[state]}`;
      bar.append(part);
    }
    const foot = el('span', 'team-foot');
    foot.append(el('span', '', team.online ? `${Math.round((team.busy / team.online) * 100)}% working` : 'No one online'));
    if (team.flagged) foot.append(el('span', 'team-flags', `⚑ ${team.flagged}`));
    card.append(head, bar, foot);
    card.onclick = () => setFilter({ team: view.team === team.name ? '' : team.name });
    return card;
  }));

  fillSelect($('team-select'), 'All teams', overview.teams.map(team => team.name), view.team);
  fillSelect($('office-select'), 'All offices', overview.offices.map(office => office.name), view.office);
}

function fillSelect(select, allLabel, names, selected) {
  const wanted = ['', ...names];
  if ([...select.options].map(option => option.value).join('|') !== wanted.join('|')) {
    select.replaceChildren(...wanted.map(name => {
      const option = el('option', '', name || allLabel);
      option.value = name;
      return option;
    }));
  }
  select.value = selected;
}

// ---------- The list ----------

// Rows on screen, by person. Each row's elements stay put and only their text and colours change each second, so
// a click that happens while the list refreshes still lands.
const lines = new Map();

function createLine(id) {
  const line = el('div', 'people-row person-line');
  line.tabIndex = 0;
  line.setAttribute('role', 'button');
  line.onclick = () => openDetail(id);
  line.onkeydown = event => { if (event.key === 'Enter') openDetail(id); };
  const parts = {
    avatar: el('span', 'avatar'), name: el('b'), place: el('small'), team: el('span', 'col-team'),
    pill: el('span'), since: el('small', 'since'), app: el('span', 'app-tag'),
    meter: el('span', 'meter-bar'), fill: el('i'), value: el('span', 'meter-value'), work: el('span', 'col-work'), flags: el('span', 'col-flags')
  };
  const who = el('span', 'who');
  const text = el('span', 'who-text');
  text.append(parts.name, parts.place);
  who.append(parts.avatar, text);
  const status = el('span', 'status-col');
  status.append(parts.pill, parts.since);
  const app = el('span', 'col-app');
  app.append(parts.app);
  parts.meter.append(parts.fill);
  const activity = el('span', 'col-activity meter');
  activity.append(parts.meter, parts.value);
  line.append(who, parts.team, status, app, activity, parts.work, parts.flags);
  return { line, parts, flags: null };
}

const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
const setClass = (node, name) => { if (node.className !== name) node.className = name; };

function fillLine(entry, row, index, now) {
  const { line, parts } = entry;
  line.style.top = `${index * ROW}px`;
  setClass(line, `people-row person-line${row.flags.length ? ' has-flags' : ''}${row.id === detailId ? ' selected' : ''}`);
  setClass(parts.avatar, `avatar ${row.state}`);
  setText(parts.avatar, initials(row.name));
  setText(parts.name, row.name);
  setText(parts.place, `${row.office} · ${localTime(now, row.timeZone)}`);
  setText(parts.team, row.team);
  setClass(parts.pill, `pill small ${row.state}`);
  setText(parts.pill, STATE_LABELS[row.state]);
  setText(parts.since, row.state === 'logged_out' ? '' : sinceText(row.since));
  setText(parts.app, row.app || '');
  parts.app.hidden = !row.app;
  parts.meter.hidden = row.activity === null;
  parts.fill.style.width = `${row.activity ?? 0}%`;
  setText(parts.value, row.activity === null ? '–' : `${row.activity}%`);
  setText(parts.work, String(row.work));
  const flags = row.flags.join();
  if (entry.flags !== flags) {
    entry.flags = flags;
    parts.flags.replaceChildren(...row.flags.map(flag => el('span', 'flag-tag', `⚑ ${FLAG_LABELS[flag] || flag}`)));
  }
}

function renderPeople({ rows, total, offset, now }) {
  const label = [view.team || 'Everyone'];
  if (view.status === 'flagged') label.push('needing a look');
  else if (view.status) label.push(STATE_LABELS[view.status].toLowerCase());
  if (view.office) label.push(`in ${view.office}`);
  if (view.search) label.push(`matching “${view.search}”`);
  $('people-title').textContent = `${label.join(' · ')} · ${total.toLocaleString()} ${total === 1 ? 'person' : 'people'}`;
  if (SORT_TITLES[view.sort]) $('people-title').append(el('small', 'muted', `, ${SORT_TITLES[view.sort]}`));

  const spacer = $('spacer');
  spacer.style.height = `${Math.max(total, 1) * ROW}px`;
  let empty = spacer.querySelector('.empty-list');
  if (!total && !empty) spacer.append(empty = el('div', 'empty-list muted', 'No one matches'));
  if (empty) empty.hidden = total > 0;

  const shown = new Set();
  rows.forEach((row, index) => {
    let entry = lines.get(row.id);
    if (!entry) lines.set(row.id, entry = createLine(row.id));
    fillLine(entry, row, offset + index, now);
    if (!entry.line.isConnected) spacer.append(entry.line);
    shown.add(row.id);
  });
  for (const [id, entry] of lines) {
    if (shown.has(id)) continue;
    entry.line.remove();
    lines.delete(id);
  }
}

// ---------- One person: the detail panel ----------

function statusDetail(employee, config) {
  if (employee.state === 'logged_out') {
    if (employee.logoutReason === 'idle') return `after ${duration(config.idleLogout)} with no activity`;
    if (employee.logoutReason) return employee.logoutReason;
    return employee.lastSeenToday ? `last seen ${localTime(employee.lastSeenToday, employee.timeZone)}` : "hasn't logged in yet";
  }
  if (employee.manual?.detected) return `${employee.manual.app} · detected from the microphone · ${duration(employee.manual.seconds)} so far`;
  if (employee.manual) return `${duration(employee.manual.seconds)} so far · no idle logout · ends by itself in ${duration(employee.manual.endsIn)}`;
  if (employee.state === 'away') {
    const locked = employee.devices.some(device => device.locked);
    return `${locked ? 'screen locked' : 'no device connected'} · logout in ${employee.secondsUntilLogout}s if nobody returns`;
  }
  if (employee.state === 'working' && employee.lastWork) return `${employee.lastWork} (in ${employee.lastWorkApp})`;
  const parts = [`last input ${employee.secondsSinceInput}s ago`];
  if (employee.secondsUntilLogout <= config.warningBefore) parts.push(`warned · logout in ${employee.secondsUntilLogout}s`);
  return parts.join(' · ');
}

function timeline(employee, now, windowMs) {
  const bar = el('div', 'timeline');
  const start = now - windowMs;
  for (const segment of employee.segments) {
    const from = Math.max(segment.start, start);
    if (segment.end <= from) continue;
    const piece = el('i', `seg ${segment.state}`);
    piece.style.left = `${((from - start) / windowMs) * 100}%`;
    piece.style.width = `${((segment.end - from) / windowMs) * 100}%`;
    piece.title = STATE_LABELS[segment.state];
    bar.append(piece);
  }
  return bar;
}

function section(title, ...content) {
  const part = el('section', 'drawer-section');
  part.append(el('h3', '', title), ...content);
  return part;
}

function renderDetail({ detail: employee, now, config }) {
  if (!detailId) return;
  if (!employee) return closeDetail();
  const person = $('drawer-person');
  const text = el('div');
  text.append(el('b', '', employee.name), el('div', 'muted small', `${employee.team || 'No team'} · ${employee.office}, ${localTime(now, employee.timeZone)} local`));
  person.replaceChildren(el('span', `avatar big ${employee.state}`, initials(employee.name)), text);

  const status = el('div');
  status.append(el('span', `pill ${employee.state}`, STATE_LABELS[employee.state]), el('div', 'muted small detail', statusDetail(employee, config)));
  if (employee.noWorkFor) status.append(el('div', 'flag', `⚑ Present but nothing opened or saved for ${duration(employee.noWorkFor)}`));
  if (employee.tooRegular) {
    const { everyMs, same, gaps } = employee.tooRegular;
    status.append(el('div', 'flag', `⚑ Too regular to be human: input every ${(everyMs / 1000).toFixed(1)}s like clockwork (${same} of ${gaps} gaps the same). Possibly a mouse jiggler; worth a look.`));
  }
  if (employee.trackerStopped) {
    status.append(el('div', 'flag', `⚑ Desktop app stopped reporting at ${localTime(employee.trackerStopped.since, employee.timeZone)} without the laptop going to sleep`));
  }

  const devices = el('div', 'devices-cell');
  if (!employee.devices.length) devices.append(el('span', 'muted small', 'No device connected'));
  for (const device of employee.devices) {
    const chip = el('div', `chip device-chip${device.desktop ? ' desktop' : ''}`);
    const apps = el('span', 'chip-apps');
    if (device.locked) apps.append(el('span', 'app-tag locked', 'Screen locked'));
    else for (const app of device.apps) apps.append(el('span', 'app-tag', app));
    if (device.tabs > 1 && !device.desktop) apps.append(el('span', 'chip-tabs', `${device.tabs} tabs`));
    chip.append(el('span', '', device.label), apps);
    devices.append(chip);
  }

  const stat = (value, label, className) => {
    const box = el('div', `big-stat ${className}`);
    box.append(el('b', '', value), el('span', '', label));
    return box;
  };
  const headline = el('div', 'headline');
  headline.append(
    stat(employee.activity === null ? '–' : `${employee.activity}%`, 'activity', 'activity'),
    stat(String(employee.workCount), `work action${employee.workCount === 1 ? '' : 's'}`, 'work')
  );
  const times = el('div', 'times');
  for (const key of ['working', 'active', 'idle', 'away', 'call', 'meeting', 'break']) {
    if (['call', 'meeting', 'break'].includes(key) && !employee.totals[key] && employee.state !== key) continue;
    const line = el('span');
    line.append(el('i', `dot ${key}`), document.createTextNode(`${STATE_LABELS[key]} ${duration(employee.totals[key])}`));
    times.append(line);
  }
  const today = [headline, times];
  if (employee.apps.length) {
    const apps = el('div', 'apps-time');
    apps.append(...employee.apps.map(app => appTime(app)));
    today.push(apps);
  }

  $('drawer-body').replaceChildren(
    section('Status now', status),
    section('Devices', devices),
    section(`Last ${Math.round(config.timelineWindow / 60)} minutes`, timeline(employee, now, config.timelineWindow * 1000), blockChart(employee.blocks, config.block, employee.timeZone)),
    section('Today', ...today)
  );
}

function openDetail(id) {
  detailId = id;
  $('drawer').hidden = false;
  $('drawer-body').replaceChildren(el('p', 'muted', '…'));
  send({ type: 'detail', id });
  if (snapshot) renderPeople(snapshot);
}

function closeDetail() {
  detailId = null;
  $('drawer').hidden = true;
  send({ type: 'detail', id: null });
  if (snapshot) renderPeople(snapshot);
}

// ---------- Wiring ----------

function render(message) {
  snapshot = message;
  renderControls(message);
  renderPeople(message);
  renderDetail(message);
  $('sample-people').textContent = message.samplePeople ? `Remove ${message.samplePeople.toLocaleString()} sample employees` : 'Add 2,000 sample employees';
  const { stats } = message;
  $('server').textContent = `Server: ${stats.connections.toLocaleString()} live connections, ${stats.rssMB} MB memory, ${stats.cpuPercent}% CPU, ${stats.messagesPerSecond.toLocaleString()} messages a second`;
}

function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=manager`);
  socket.onopen = () => {
    $('live').classList.remove('off');
    sentView = '';
    updateWindow();
    sendView();
    if (detailId) send({ type: 'detail', id: detailId });
  };
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'snapshot') render(message);
  };
  socket.onclose = () => {
    $('live').classList.add('off');
    setTimeout(connect, 2000);
  };
}

let searchTimer = null;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => setFilter({ search: $('search').value.trim().toLowerCase() }), 150);
});
$('team-select').onchange = () => setFilter({ team: $('team-select').value });
$('office-select').onchange = () => setFilter({ office: $('office-select').value });
$('sort').onchange = () => setFilter({ sort: $('sort').value });
let scrollFrame = 0;
$('scroller').addEventListener('scroll', () => {
  cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(updateWindow);
}, { passive: true });
window.addEventListener('resize', updateWindow);
$('drawer-close').onclick = closeDetail;
document.addEventListener('keydown', event => { if (event.key === 'Escape' && detailId) closeDetail(); });
$('sample-people').onclick = async () => {
  const action = snapshot?.samplePeople ? 'remove' : 'add';
  await fetch('/api/sample-people', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
};

connect();
