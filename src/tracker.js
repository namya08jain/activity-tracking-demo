const crypto = require('node:crypto');
const { dayKey, shiftDay, startOfDay, weekday } = require('./days');
const { DESKTOP_APP_NAMES, desktopActivity, callApp } = require('./apps');

const MAX_BOTS = 10_000;
const MAX_TOKENS_PER_USER = 20;
const MANUAL_STATES = ['call', 'meeting', 'break'];   // chosen by the employee
const AT_COMPUTER = ['working', 'active', 'idle', 'away'];
const STATES = [...AT_COMPUTER, ...MANUAL_STATES];
const RECENT_SECONDS = 128;  // a tab may report input seconds up to this late (well over one heartbeat)
const MAX_GAPS = 200;
// Crizac apps that load the tracking script. A tab's claim is checked against this list, so a tampered tab
// can't invent app names (unbounded memory) or use names like "__proto__".
const KNOWN_APPS = new Set(['Console', 'TMS']);
// Every app name a daily record may hold: the Crizac web apps plus the fixed list the desktop app can report.
const RECORDED_APPS = new Set([...KNOWN_APPS, ...DESKTOP_APP_NAMES]);
// Ordinary reasons a desktop app goes quiet; any other silence is flagged as "tracker stopped".
const GOODBYES = new Set(['sleep', 'shutdown', 'signout']);
// A detected call shorter than config.minCall (a microphone test, a missed call) isn't counted as a work action.
const MIN_CALL_SECONDS = 20;
const callLength = seconds => (seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`);
// Answers to the desktop app's "you were away, what was it?" question, and the statuses that make up an away spell.
const AWAY_ANSWERS = { break: 'Break', meeting: 'Meeting', call: 'Call' };
const AWAY_STATES = new Set(['away', 'idle', 'logged_out']);

// One record per employee per local date: what the daily and weekly reports are built from, and what is saved
// to disk. Times are milliseconds; activeSeconds counts seconds with any input; flags count flagged milliseconds;
// trackerStops counts times the desktop app went silent unexpectedly.
const DAY_FIELDS = [...STATES, 'activeSeconds', 'work', 'firstSeen', 'lastSeen', 'noWorkFlag', 'regularFlag', 'trackerStops'];
const MAX_DAY_LOG = 100;  // work actions listed per day ("What you got done")
const KEEP_DAYS = 35;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RANGES = { today: [0, 0], yesterday: [-1, -1], week: [-6, 0] };
const HOUR = 3_600_000;

function emptyDay() {
  const day = { apps: {}, log: [], sample: false };
  for (const field of DAY_FIELDS) day[field] = 0;
  return day;
}

// Copies only known fields from a saved day, so a hand-edited file can't add apps, people or properties.
function cleanDay(saved) {
  const day = emptyDay();
  if (!saved || typeof saved !== 'object') return day;
  for (const field of DAY_FIELDS) if (Number.isFinite(saved[field]) && saved[field] >= 0) day[field] = saved[field];
  for (const app of RECORDED_APPS) {
    const ms = saved.apps && Object.hasOwn(saved.apps, app) ? saved.apps[app] : undefined;
    if (Number.isFinite(ms) && ms >= 0) day.apps[app] = ms;
  }
  if (Array.isArray(saved.log)) {
    day.log = saved.log.slice(-MAX_DAY_LOG)
      .filter(item => item && Number.isFinite(item.at))
      .map(item => ({ at: item.at, label: String(item.label ?? '').slice(0, 80), app: RECORDED_APPS.has(item.app) ? item.app : 'Console' }));
  }
  day.sample = saved.sample === true;
  return day;
}

// The same made-up numbers every time for a given person and date.
function seeded(text) {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return () => {
    hash = Math.imul(hash ^ (hash >>> 15), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    hash ^= hash >>> 16;
    return (hash >>> 0) / 4294967296;
  };
}

// A believable made-up working day, clearly marked as sample, so a demo can show a week of history.
function sampleDay(user, key) {
  const random = seeded(`${user.id}|${key}`);
  const between = (low, high) => low + (high - low) * random();
  const computer = between(6.5, 8.5) * HOUR;
  const day = emptyDay();
  day.working = Math.round(computer * between(0.5, 0.68));
  day.active = Math.round(computer * between(0.1, 0.18));
  day.idle = Math.round(computer * between(0.05, 0.1));
  day.away = Math.round(computer) - day.working - day.active - day.idle;
  day.call = Math.round(between(0.5, 1.5) * HOUR);
  day.meeting = Math.round(between(0, 0.75) * HOUR);
  day.break = Math.round(between(0.5, 1) * HOUR);
  day.activeSeconds = Math.round((computer / 1000) * between(0.45, 0.75));
  day.work = Math.round(between(25, 70));
  const inUse = day.working + day.active;
  day.apps.Console = Math.round(inUse * between(0.75, 0.9));
  day.apps.TMS = inUse - day.apps.Console;
  day.firstSeen = startOfDay(key, user.timeZone) + Math.round(between(9.25, 10) * HOUR);
  day.lastSeen = day.firstSeen + Math.round(computer) + day.call + day.meeting + day.break;
  day.noWorkFlag = random() < 0.12 ? Math.round(between(10, 25) * 60_000) : 0;
  day.sample = true;
  return day;
}

// Decides, per employee, whether they are Working, Active, Idle, Away, on a call / in a meeting / on a break,
// or Logged out.
// - Signals from every tab and device of one employee are merged, so overlapping time counts once.
// - All times are the server's clock (milliseconds, UTC). Tabs report "seconds since my last input"
//   instead of a time of day, so a wrong or changed device clock or time zone can't skew anything.
// - A dropped connection (locked phone, closed lid) only makes someone Away; the logout happens when
//   there has been no input anywhere for config.idleLogout seconds.
// - Activity % per block = seconds with any input ÷ seconds at the computer (calls, meetings and breaks
//   are left out), the measure the bought tools use, so managers recognise it.
// The tracker never touches sockets: it returns events and the server delivers them.
class ActivityTracker {
  // `saved` is what exportDays() returned last time (read back from disk), so history survives a restart.
  constructor(config, employees = [], saved = {}) {
    this.config = config;
    this.users = new Map();
    this.tokens = new Map();       // session token → user id
    this.connections = new Map();  // connection id → { userId, deviceId, deviceLabel, tabId, app, visible }
    this.dirty = false;            // daily records changed since the last save
    const savedDays = saved?.days && typeof saved.days === 'object' ? saved.days : {};
    for (const employee of employees) {
      const user = this.addUser(employee);
      const days = Object.hasOwn(savedDays, employee.id) ? savedDays[employee.id] : null;
      if (!days || typeof days !== 'object') continue;
      for (const [key, day] of Object.entries(days)) if (DATE.test(key)) user.days.set(key, cleanDay(day));
    }
  }

  addUser({ id, name, office = '', timeZone = 'UTC', team = '', bot = false }) {
    const user = {
      id, name, office, timeZone, team, bot,
      lastState: null, stateSince: 0,  // the status at the last tick, and since when
      tokens: new Set(), conns: new Set(),
      loggedIn: false, loginAt: 0, lastInputAt: 0, lastWorkAt: 0, lastWork: null,
      warned: false, logoutReason: null, lastTick: 0,
      manual: null,       // { kind: 'call' | 'meeting' | 'break', since }
      resumedAt: 0,       // when a call/meeting/break last ended; the idle clock restarts from here
      totals: Object.fromEntries(STATES.map(state => [state, 0])),
      segments: [],
      // Which of the last RECENT_SECONDS seconds had input, so two tabs reporting the same second count once.
      recentInput: new Uint8Array(RECENT_SECONDS), recentHead: 0,
      blocks: new Map(),  // block start (ms) → { active: seconds with input, work: work actions }
      days: new Map(),    // local date "2026-10-27" → daily record (see emptyDay)
      // Which Crizac app (console, TMS…) had the latest input. Time in use is credited to it, so two apps
      // open at once still count once.
      lastApp: null, lastWorkApp: null,
      gaps: [],           // { at, ms }: time between bursts of input, to spot a mouse jiggler
      trackerStopped: null, // { since, device }: the desktop app went silent without the laptop going to sleep
      // Away spells the server saw itself (Away, Idle or logged out after being here), in ms: the one going on now,
      // and the last one that ended. Only these can be explained (see explainAway).
      awaySpell: 0, lastAwaySpell: 0, lastAwayEnd: 0
    };
    this.users.set(id, user);
    return user;
  }

  // Load-test users (bot-1 … bot-10000) are created on first login and kept out of the manager's table.
  login(userId, now) {
    let user = this.users.get(userId);
    const botNumber = /^bot-(\d{1,5})$/.exec(userId)?.[1];
    if (!user && botNumber && Number(botNumber) <= MAX_BOTS) user = this.addUser({ id: userId, name: userId, bot: true });
    if (!user) return null;
    if (!user.loggedIn) {
      Object.assign(user, { loggedIn: true, loginAt: now, lastInputAt: now, lastWorkAt: 0, lastWork: null, warned: false, logoutReason: null, manual: null, resumedAt: 0, gaps: [], lastApp: null, lastWorkApp: null });
      user.lastTick = now;
    }
    // Every device that logs in gets its own token; one logout ends them all.
    const token = crypto.randomBytes(16).toString('hex');
    user.tokens.add(token);
    this.tokens.set(token, user.id);
    // Repeated logins can't pile up tokens: the oldest is dropped (Sets keep insertion order).
    if (user.tokens.size > MAX_TOKENS_PER_USER) {
      const oldest = user.tokens.values().next().value;
      user.tokens.delete(oldest);
      this.tokens.delete(oldest);
    }
    return token;
  }

  userForToken(token) {
    return this.tokens.get(token);
  }

  // Ends the session on every tab and device. Returns the connections the server must notify.
  logout(userId, reason) {
    const user = this.users.get(userId);
    if (!user || !user.loggedIn) return [];
    user.loggedIn = false;
    user.logoutReason = reason;
    user.manual = null;
    user.trackerStopped = null;
    for (const token of user.tokens) this.tokens.delete(token);
    user.tokens.clear();
    return [...user.conns];
  }

  // `app` is the Crizac web app the tab belongs to ("Console", "TMS"…); each app loads the same tracking script.
  // `kind: 'desktop'` is the desktop app, which sees the whole laptop: its heartbeats say which program is in
  // front (so `app` changes as the person switches), whether the screen is locked, and who is using the microphone.
  connect(connId, token, { deviceId, deviceLabel, tabId, app, kind } = {}) {
    const user = this.users.get(this.tokens.get(token));
    if (!user || !user.loggedIn) return null;
    // A connection belongs to one employee; binding it again first unbinds the old one.
    this.disconnect(connId);
    const desktop = kind === 'desktop';
    this.connections.set(connId, {
      userId: user.id,
      deviceId: String(deviceId || connId).slice(0, 64),
      deviceLabel: String(deviceLabel || 'Unknown device').slice(0, 40),
      tabId: String(tabId || connId).slice(0, 64),
      app: desktop ? null : KNOWN_APPS.has(app) ? app : 'Console',
      visible: true,
      desktop,
      lockedAt: 0,    // when the desktop app first reported the screen locked
      goodbye: null   // why the desktop app said it was going (sleep, shutdown, signout)
    });
    user.conns.add(connId);
    if (desktop) user.trackerStopped = null;
    return user;
  }

  // A desktop app announcing an ordinary reason for going quiet, just before it does.
  goodbye(connId, reason) {
    const conn = this.connections.get(connId);
    if (conn?.desktop && GOODBYES.has(reason)) conn.goodbye = reason;
  }

  // A connection closed. A desktop app that went silent without saying goodbye was closed, stopped or cut off,
  // so the manager sees "tracker stopped" until a desktop app is back for that person.
  connectionLost(connId, now) {
    const conn = this.connections.get(connId);
    const user = this.userOf(connId);
    this.disconnect(connId);
    if (!conn?.desktop || conn.goodbye || !user?.loggedIn || user.bot) return;
    if ([...user.conns].some(id => this.connections.get(id)?.desktop)) return;
    user.trackerStopped = { since: now, device: conn.deviceLabel };
    this.dayOf(user, now).trackerStops++;
  }

  disconnect(connId) {
    const conn = this.connections.get(connId);
    if (!conn) return;
    this.connections.delete(connId);
    this.users.get(conn.userId)?.conns.delete(connId);
  }

  userOf(connId) {
    const conn = this.connections.get(connId);
    return conn && this.users.get(conn.userId);
  }

  // A tab's regular report, all measured on the device with a monotonic clock:
  // - secondsSinceInput: how long since the last mouse/keyboard input
  // - inputSeconds: which of the last few seconds had any input, as "seconds ago" (never what the input was)
  // - gaps: milliseconds between bursts of input since the last report
  // A desktop app's heartbeat also carries `app`, `site`, `locked` and `micApps` (see desktopReport).
  heartbeat(connId, report, now) {
    const { visible, secondsSinceInput, inputSeconds, gaps } = report ?? {};
    const conn = this.connections.get(connId);
    const user = this.userOf(connId);
    if (!conn || !user?.loggedIn) return;
    conn.visible = Boolean(visible);
    if (conn.desktop) this.desktopReport(connId, conn, user, report ?? {}, now);
    // While its screen is locked a desktop app's "seconds since input" is ignored: rounded to whole seconds, it
    // could otherwise place the last input just after the lock and bring the person back.
    const seconds = Number(secondsSinceInput);
    if (Number.isFinite(seconds) && seconds >= 0 && !conn.lockedAt) this.noteInput(user, now - seconds * 1000, conn.app);

    if (Array.isArray(inputSeconds)) {
      const nowSecond = Math.floor(now / 1000);
      this.advanceRecent(user, nowSecond);
      for (const ago of inputSeconds.slice(0, RECENT_SECONDS)) {
        if (Number.isInteger(ago) && ago >= 0 && ago < RECENT_SECONDS) this.noteInputSecond(user, nowSecond - ago);
      }
    }
    if (Array.isArray(gaps)) {
      for (const ms of gaps.slice(0, 100)) if (Number.isFinite(ms) && ms > 0 && ms <= 3_600_000) user.gaps.push({ at: now, ms });
      const oldest = now - this.config.regularWindow * 1000;
      while (user.gaps.length && (user.gaps[0].at < oldest || user.gaps.length > MAX_GAPS)) user.gaps.shift();
    }
  }

  // What only the desktop app can see:
  // - app: the program in front, as its file name ("chrome.exe"), turned into a name from a fixed list;
  //   site: a Crizac app or work website the laptop recognised from the browser's window title
  // - locked: the screen is locked, so the person is Away until there's input again anywhere
  // - micApps: the programs using the microphone. A call app among them means "On a call", switched on and off
  //   automatically; a status the person chose by hand is left alone.
  desktopReport(connId, conn, user, { app, site, locked, micApps }, now) {
    conn.app = desktopActivity(app, site);
    if (locked !== true) conn.lockedAt = 0;
    else if (!conn.lockedAt) conn.lockedAt = now;
    const call = callApp(micApps);
    if (call && !user.manual) user.manual = { kind: 'call', since: now, auto: true, connId, app: call };
    else if (call && user.manual.auto) user.manual.app = call;
    else if (!call && user.manual?.auto && user.manual.connId === connId) {
      // A finished call is work done: it goes in the day's work actions like a saved note.
      const { since, app: callIn } = user.manual;
      this.endManual(user, now);
      const seconds = Math.round((now - since) / 1000);
      if (seconds >= (this.config.minCall ?? MIN_CALL_SECONDS)) this.recordWork(user, `Call in ${callIn}, ${callLength(seconds)}`, callIn, now);
    }
  }

  // The desktop app asks "you were away 25 min, what was it?" when someone comes back. The answer moves that time out
  // of Away (then Idle) into a break, meeting or call; time not recorded at all (logged out meanwhile) is added.
  // A meeting or call away from the desk also counts as work done. The server only accepts an answer for an away
  // spell it saw itself and that has ended (the person is back) within config.awayAnswerWindow; once; for no more
  // than it lasted; and never for a spell longer than config.awayLimit (a night away is time off, not a meeting).
  // A spell still going on can't be answered, so it can't be explained away in small pieces either.
  explainAway(connId, kind, seconds, now) {
    const user = this.userOf(connId);
    const conn = this.connections.get(connId);
    if (!user?.loggedIn || user.bot || !conn?.desktop || !Object.hasOwn(AWAY_ANSWERS, kind)) return false;
    // Back already (an answer can arrive before the next tick notices): the spell ends now.
    if (!AWAY_STATES.has(this.stateOf(user, now))) this.endAwaySpell(user, now);
    const recent = now - user.lastAwayEnd <= (this.config.awayAnswerWindow ?? 900) * 1000;
    const seen = recent ? user.lastAwaySpell : 0;
    if (seen > (this.config.awayLimit ?? 4 * 3600) * 1000) return false;
    const ms = Math.min(Math.round(Number(seconds) * 1000), seen);
    if (!Number.isFinite(ms) || ms < 1000) return false;
    user.lastAwaySpell = 0;
    const day = this.dayOf(user, now);
    let left = ms;
    for (const from of ['away', 'idle']) {
      const moved = Math.min(day[from], left);
      day[from] -= moved;
      left -= moved;
    }
    day[kind] += ms;
    if (kind !== 'break') this.recordWork(user, `${AWAY_ANSWERS[kind]} away from the desk, ${callLength(Math.round(ms / 1000))}`, conn.app, now);
    return true;
  }

  endAwaySpell(user, now) {
    if (!user.awaySpell) return;
    user.lastAwaySpell = user.awaySpell;
    user.lastAwayEnd = now;
    user.awaySpell = 0;
  }

  // Sent by a tab the moment someone touches it after a quiet spell, so the status updates at once.
  input(connId, now) {
    const user = this.userOf(connId);
    const conn = this.connections.get(connId);
    if (user?.loggedIn && !conn.lockedAt) this.noteInput(user, now, conn.app);
  }

  // Real work: an application opened, a note saved, a status changed. In production these would
  // come from the console's own backend when it handles those requests, not from the browser.
  work(connId, label, now) {
    const user = this.userOf(connId);
    if (!user?.loggedIn) return;
    this.recordWork(user, label, this.connections.get(connId).app, now);
  }

  recordWork(user, label, app, now) {
    user.lastWorkAt = now;
    user.lastWork = String(label || 'Work').slice(0, 80);
    user.lastWorkApp = app;
    if (!user.bot) {
      const day = this.dayOf(user, now);
      day.work++;
      day.log.push({ at: now, label: user.lastWork, app });
      if (day.log.length > MAX_DAY_LOG) day.log.shift();
    }
    this.blockAt(user, now).work++;
    this.noteInput(user, now, app);
  }

  // "On a call", "In a meeting" or "On a break", chosen by the employee; null goes back to automatic.
  // While it lasts there is no idle logout and the time is left out of activity %. It ends by itself
  // after config.manualMax seconds, so a forgotten "On a break" can't hide someone all day.
  setStatus(connId, kind, now) {
    const user = this.userOf(connId);
    if (!user?.loggedIn) return;
    if (MANUAL_STATES.includes(kind)) {
      // Choosing a status by hand also takes over a call that was detected automatically.
      if (user.manual?.kind !== kind) user.manual = { kind, since: now };
      else if (user.manual.auto) user.manual = { kind, since: user.manual.since };
    } else if (kind === null || kind === '' || kind === 'auto') {
      if (user.manual) this.endManual(user, now);
    } else {
      return;
    }
    this.noteInput(user, now, this.connections.get(connId).app);
  }

  endManual(user, now) {
    user.manual = null;
    user.resumedAt = now;
    user.warned = false;
  }

  noteInput(user, at, app) {
    if (at <= user.lastInputAt) return;
    user.lastInputAt = at;
    if (app) user.lastApp = app;
    user.warned = false;
  }

  // Moves the "recent seconds" window forward to nowSecond, clearing the seconds it passes over.
  advanceRecent(user, nowSecond) {
    const steps = Math.min(nowSecond - user.recentHead, RECENT_SECONDS);
    for (let i = 1; i <= steps; i++) user.recentInput[(user.recentHead + i) % RECENT_SECONDS] = 0;
    if (nowSecond > user.recentHead) user.recentHead = nowSecond;
  }

  noteInputSecond(user, second) {
    if (second > user.recentHead || second <= user.recentHead - RECENT_SECONDS) return;
    const slot = second % RECENT_SECONDS;
    if (user.recentInput[slot]) return;  // another tab or device already reported this second
    user.recentInput[slot] = 1;
    if (user.manual) return;             // typing notes during a call doesn't count towards activity %
    if (!user.bot) this.dayOf(user, second * 1000).activeSeconds++;
    this.blockAt(user, second * 1000).active++;
  }

  // The daily record for the local date at time `at`, created if needed. Old days beyond KEEP_DAYS are dropped.
  dayOf(user, at) {
    const key = dayKey(at, user.timeZone);
    let day = user.days.get(key);
    if (!day) {
      day = emptyDay();
      user.days.set(key, day);
      const oldest = shiftDay(key, -KEEP_DAYS);
      for (const existing of user.days.keys()) if (existing < oldest) user.days.delete(existing);
    }
    this.dirty = true;
    return day;
  }

  // Like dayOf, but never creates a record (for reading).
  peekDay(user, at) {
    return user.days.get(dayKey(at, user.timeZone)) || emptyDay();
  }

  // Seconds since the last save (or login) while present at the computer, once it passes the flag threshold.
  noWorkFor(user, state, now) {
    const present = state === 'active' || state === 'idle';
    const sinceWork = now - Math.max(user.lastWorkAt, user.loginAt);
    return present && sinceWork >= this.config.noWorkFlag * 1000 ? Math.round(sinceWork / 1000) : null;
  }

  blockAt(user, at) {
    const blockMs = this.config.block * 1000;
    const start = Math.floor(at / blockMs) * blockMs;
    let block = user.blocks.get(start);
    if (!block) {
      block = { active: 0, work: 0 };
      user.blocks.set(start, block);
      for (const key of user.blocks.keys()) if (key < start - this.config.timelineWindow * 1000 - blockMs) user.blocks.delete(key);
    }
    return block;
  }

  stateOf(user, now) {
    if (!user.loggedIn) return 'logged_out';
    if (user.manual) return user.manual.kind;
    if (user.conns.size === 0 || this.screenLocked(user)) return 'away';
    // Someone who has gone quiet is Idle, however recently they saved something.
    if (now - user.lastInputAt >= this.config.presence * 1000) return 'idle';
    if (user.lastWorkAt && now - user.lastWorkAt < this.config.work * 1000) return 'working';
    return 'active';
  }

  // A desktop app reports the screen locked, and nothing has been touched on any device since.
  screenLocked(user) {
    for (const connId of user.conns) {
      const lockedAt = this.connections.get(connId)?.lockedAt;
      if (lockedAt && user.lastInputAt <= lockedAt) return true;
    }
    return false;
  }

  // How long the idle-logout clock has been running: since the last input, or since a call/meeting/break ended.
  quietMs(user, now) {
    return now - Math.max(user.lastInputAt, user.resumedAt);
  }

  // null while on a call / in a meeting / on a break: there is no idle logout then.
  secondsUntilLogout(user, now) {
    if (user.manual) return null;
    return Math.max(0, Math.ceil((this.config.idleLogout * 1000 - this.quietMs(user, now)) / 1000));
  }

  // Called about once a second: adds the elapsed time to each employee's current state and returns
  // warning / logout events for the server to deliver.
  tick(now) {
    const events = [];
    const timelineStart = now - this.config.timelineWindow * 1000;
    for (const user of this.users.values()) {
      if (!user.lastTick) continue;
      // A detected call ends when the desktop app that saw the microphone is gone: nothing can confirm it any more.
      if (user.manual?.auto && !this.connections.has(user.manual.connId)) this.endManual(user, now);
      const state = this.stateOf(user, now);
      const from = user.lastTick;
      if (state !== user.lastState) {
        user.lastState = state;
        user.stateSince = from;
      }
      // Away spells, measured here so that "what was it?" answers can be checked against them.
      if (AWAY_STATES.has(state)) user.awaySpell += now - from;
      else this.endAwaySpell(user, now);
      if (state !== 'logged_out') user.totals[state] += now - from;
      // The day record is the one this second started in, so local midnight splits cleanly.
      if (!user.bot && state !== 'logged_out') {
        const day = this.dayOf(user, from);
        const elapsed = now - from;
        day[state] += elapsed;
        if ((state === 'working' || state === 'active') && user.lastApp) day.apps[user.lastApp] = (day.apps[user.lastApp] || 0) + elapsed;
        if (!day.firstSeen) day.firstSeen = from;
        day.lastSeen = now;
        if (this.noWorkFor(user, state, now)) day.noWorkFlag += elapsed;
        if (this.tooRegular(user, now)) day.regularFlag += elapsed;
      }
      if (!user.bot) {
        const last = user.segments[user.segments.length - 1];
        if (last && last.state === state && last.end === from) last.end = now;
        else user.segments.push({ state, start: from, end: now });
        while (user.segments.length && user.segments[0].end < timelineStart) user.segments.shift();
      }
      user.lastTick = now;
      if (!user.loggedIn) continue;

      if (user.manual) {
        // A chosen status ends by itself after the safety limit; a detected call lasts while the microphone is in use.
        if (!user.manual.auto && now - user.manual.since >= this.config.manualMax * 1000) this.endManual(user, now);
        continue;
      }
      const quietMs = this.quietMs(user, now);
      if (quietMs >= this.config.idleLogout * 1000) {
        events.push({ type: 'logout', userId: user.id, reason: 'idle', connIds: this.logout(user.id, 'idle') });
      } else if (quietMs >= (this.config.idleLogout - this.config.warningBefore) * 1000 && !user.warned) {
        user.warned = true;
        events.push({ type: 'warning', userId: user.id, secondsLeft: this.secondsUntilLogout(user, now), connIds: [...user.conns] });
      }
    }
    return events;
  }

  // Activity % and work actions for each block in the timeline window. The current block is still filling up.
  blocksOf(user, now) {
    const blockMs = this.config.block * 1000;
    const first = Math.ceil((now - this.config.timelineWindow * 1000) / blockMs) * blockMs;
    const blocks = [];
    for (let start = first; start <= now; start += blockMs) {
      const end = Math.min(start + blockMs, now);
      let atComputerMs = 0;
      for (const segment of user.segments) {
        if (AT_COMPUTER.includes(segment.state)) atComputerMs += Math.max(0, Math.min(segment.end, end) - Math.max(segment.start, start));
      }
      const counts = user.blocks.get(start) || { active: 0, work: 0 };
      blocks.push({
        start,
        current: start + blockMs > now,
        // Under 3 seconds at the computer (a whole block on a call, say) gives no percentage.
        activity: atComputerMs >= 3000 ? Math.min(100, Math.round((counts.active * 1000 / atComputerMs) * 100)) : null,
        work: counts.work
      });
    }
    return blocks;
  }

  // A mouse jiggler moves the mouse like a metronome; people never do. Flags input when at least 90% of the
  // gaps between bursts are within a few percent of the typical (median) gap. Using the median means one
  // long pause, such as the one before the jiggler was plugged in, can't hide the pattern.
  tooRegular(user, now) {
    if (!user.loggedIn) return null;
    const recent = user.gaps.filter(gap => gap.at >= now - this.config.regularWindow * 1000).map(gap => gap.ms);
    if (recent.length < this.config.regularMinGaps) return null;
    const sorted = [...recent].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const same = recent.filter(ms => Math.abs(ms - median) <= median * this.config.regularMaxVariation).length;
    if (same < this.config.regularMinGaps || same / recent.length < 0.9) return null;
    return { everyMs: median, same, gaps: recent.length };
  }

  // Everything known about one employee, as shown on the manager screen and on their own "My day" page.
  summary(user, now) {
    const state = this.stateOf(user, now);
    const devices = new Map();
    for (const connId of user.conns) {
      const conn = this.connections.get(connId);
      if (!conn) continue;
      const device = devices.get(conn.deviceId) || { label: conn.deviceLabel, tabs: 0, apps: [] };
      device.tabs++;
      if (conn.app && !device.apps.includes(conn.app)) device.apps.push(conn.app);
      if (conn.desktop) device.desktop = true;
      if (conn.lockedAt) device.locked = true;
      devices.set(conn.deviceId, device);
    }
    for (const device of devices.values()) device.apps.sort();
    // "Today" is the employee's own local date, read from the daily record (so it survives a restart).
    const today = this.peekDay(user, now);
    const totals = Object.fromEntries(STATES.map(key => [key, Math.round(today[key] / 1000)]));
    const atComputer = AT_COMPUTER.reduce((sum, key) => sum + totals[key], 0);
    return {
      id: user.id, name: user.name, office: user.office, timeZone: user.timeZone, state,
      devices: [...devices.values()],
      secondsSinceInput: user.loggedIn ? Math.round((now - user.lastInputAt) / 1000) : null,
      secondsUntilLogout: user.loggedIn ? this.secondsUntilLogout(user, now) : null,
      // A detected call says which app and has no end time: it lasts while the microphone is in use.
      manual: user.manual && {
        kind: user.manual.kind,
        seconds: Math.round((now - user.manual.since) / 1000),
        endsIn: user.manual.auto ? null : Math.max(0, Math.ceil((this.config.manualMax * 1000 - (now - user.manual.since)) / 1000)),
        ...(user.manual.auto && { detected: true, app: user.manual.app })
      },
      trackerStopped: user.trackerStopped,
      lastWork: user.lastWork,
      lastWorkApp: user.lastWorkApp,
      // Time in use (working or active) per app today, most-used first.
      apps: appList(today.apps),
      noWorkFor: this.noWorkFor(user, state, now),
      tooRegular: this.tooRegular(user, now),
      logoutReason: user.loggedIn ? null : user.logoutReason,
      lastSeenToday: today.lastSeen || null,
      totals,
      activity: percent(today.activeSeconds, atComputer),
      workCount: today.work,
      blocks: this.blocksOf(user, now),
      segments: user.segments
    };
  }

  // One line on the manager's list: small enough to work out for thousands of people every second.
  // The full picture (summary) is only sent for the person a manager has opened.
  row(user, now) {
    const state = this.stateOf(user, now);
    const today = this.peekDay(user, now);
    const atComputer = Math.round(AT_COMPUTER.reduce((sum, key) => sum + today[key], 0) / 1000);
    const flags = [];
    if (this.noWorkFor(user, state, now)) flags.push('noWork');
    if (this.tooRegular(user, now)) flags.push('regular');
    if (user.trackerStopped) flags.push('stopped');
    const inUse = state === 'working' || state === 'active';
    return {
      id: user.id, name: user.name, team: user.team, office: user.office, timeZone: user.timeZone, state,
      since: user.stateSince ? Math.max(0, Math.round((now - user.stateSince) / 1000)) : null,
      app: user.manual?.auto ? user.manual.app : inUse ? user.lastApp : null,
      activity: percent(today.activeSeconds, atComputer),
      work: today.work,
      flags
    };
  }

  rows(now) {
    const rows = [];
    for (const user of this.users.values()) if (!user.bot) rows.push(this.row(user, now));
    return rows;
  }

  // The full picture of one employee for the manager's detail panel, or null for unknown ids and load-test bots.
  detail(id, now) {
    const user = this.users.get(id);
    return user && !user.bot ? { ...this.summary(user, now), team: user.team } : null;
  }

  // What the manager screen shows. Load-test users are only counted.
  snapshot(now) {
    const employees = [];
    let botsOnline = 0;
    for (const user of this.users.values()) {
      if (user.bot) {
        if (user.loggedIn) botsOnline++;
        continue;
      }
      employees.push(this.summary(user, now));
    }
    return { now, employees, botsOnline };
  }

  // An employee's own record, asked for over their own connection (so nobody can read someone else's).
  myDay(connId, now) {
    const user = this.userOf(connId);
    if (!user || user.bot) return null;
    const { segments, ...summary } = this.summary(user, now);
    return { ...summary, workLog: this.peekDay(user, now).log.slice(-15).reverse() };
  }

  // Daily or weekly summary for managers: 'today', 'yesterday' or 'week' (the last 7 local dates, today included).
  // Each employee's dates are their own office's dates.
  report(range, now) {
    const span = RANGES[range];
    if (!span) throw new Error(`Unknown range: ${range}`);
    const employees = [];
    for (const user of this.users.values()) {
      if (user.bot) continue;
      const today = dayKey(now, user.timeZone);
      const days = [];
      for (let offset = span[0]; offset <= span[1]; offset++) {
        const key = shiftDay(today, offset);
        days.push({ key, day: user.days.get(key) || emptyDay() });
      }
      employees.push(reportRow(user, days));
    }
    const add = field => employees.reduce((total, row) => total + row[field], 0);
    const team = {
      people: employees.length,
      atComputer: add('atComputer'),
      activeSeconds: add('activeSeconds'),
      work: add('work'),
      callsAndMeetings: add('callsAndMeetings'),
      breaks: add('breaks'),
      flaggedPeople: employees.filter(row => row.flagged.noWork || row.flagged.regular || row.flagged.trackerStops).length
    };
    team.activity = percent(team.activeSeconds, team.atComputer);
    return { range, now, employees, team, sample: employees.some(row => row.sample) };
  }

  // Demo only: fills the six days before today with made-up, clearly marked days (skipping each office's weekend),
  // so the weekly report has something to show. Real days are never overwritten.
  addSampleWeek(now) {
    for (const user of this.users.values()) {
      if (user.bot) continue;
      const today = dayKey(now, user.timeZone);
      let flagged = false;
      for (let offset = 1; offset <= 6; offset++) {
        const key = shiftDay(today, -offset);
        const day = weekday(key);
        const weekend = user.office === 'London' ? day === 0 || day === 6 : day === 0;
        if (weekend || (user.days.has(key) && !user.days.get(key).sample)) continue;
        const sample = sampleDay(user, key);
        // Priya's most recent made-up day always has a "too regular" stretch, so the demo can point at it any day.
        if (user.id === 'priya' && !flagged) {
          sample.regularFlag = 40 * 60_000;
          flagged = true;
        }
        user.days.set(key, sample);
      }
    }
    this.dirty = true;
  }

  removeSample() {
    for (const user of this.users.values()) {
      for (const [key, day] of user.days) if (day.sample) user.days.delete(key);
    }
    this.dirty = true;
  }

  // Everything worth saving to disk: the daily records of every real employee.
  exportDays() {
    const days = {};
    for (const user of this.users.values()) if (!user.bot) days[user.id] = Object.fromEntries(user.days);
    return { version: 1, days };
  }
}

// Activity %: seconds with input ÷ seconds at the computer, or null when there's too little time to judge.
function percent(activeSeconds, atComputerSeconds) {
  return atComputerSeconds >= 3 ? Math.min(100, Math.round((activeSeconds / atComputerSeconds) * 100)) : null;
}

// { Console: ms, TMS: ms } → [{ name, seconds }], most-used first.
function appList(apps) {
  return Object.entries(apps)
    .map(([name, ms]) => ({ name, seconds: Math.round(ms / 1000) }))
    .filter(app => app.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
}

// One employee's row in the report: totals over the chosen days, plus one entry per day for the weekly strip.
function reportRow(user, days) {
  const sum = field => days.reduce((total, { day }) => total + day[field], 0);
  const seconds = ms => Math.round(ms / 1000);
  const atComputer = seconds(AT_COMPUTER.reduce((total, state) => total + sum(state), 0));
  const apps = {};
  for (const { day } of days) for (const [name, ms] of Object.entries(day.apps)) apps[name] = (apps[name] || 0) + ms;
  const seen = days.filter(({ day }) => day.firstSeen);
  return {
    id: user.id, name: user.name, office: user.office, timeZone: user.timeZone,
    atComputer,
    working: seconds(sum('working')),
    activeSeconds: sum('activeSeconds'),
    activity: percent(sum('activeSeconds'), atComputer),
    work: sum('work'),
    callsAndMeetings: seconds(sum('call') + sum('meeting')),
    breaks: seconds(sum('break')),
    apps: appList(apps),
    firstSeen: seen.length ? Math.min(...seen.map(({ day }) => day.firstSeen)) : null,
    lastSeen: seen.length ? Math.max(...seen.map(({ day }) => day.lastSeen)) : null,
    daysActive: seen.length,
    flagged: { noWork: seconds(sum('noWorkFlag')), regular: seconds(sum('regularFlag')), trackerStops: sum('trackerStops') },
    sample: days.some(({ day }) => day.sample),
    days: days.map(({ key, day }) => {
      const dayComputer = seconds(AT_COMPUTER.reduce((total, state) => total + day[state], 0));
      return { date: key, atComputer: dayComputer, activity: percent(day.activeSeconds, dayComputer), work: day.work, sample: day.sample };
    })
  };
}

module.exports = { ActivityTracker };
