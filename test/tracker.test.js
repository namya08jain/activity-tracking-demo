const test = require('node:test');
const assert = require('node:assert/strict');
const { ActivityTracker } = require('../src/tracker');

const config = {
  heartbeat: 5, presence: 20, work: 60, idleLogout: 60, warningBefore: 20, noWorkFlag: 45, deadConnection: 10, timelineWindow: 600,
  block: 60, manualMax: 180, regularWindow: 60, regularMinGaps: 15, regularMaxVariation: 0.05
};
const employees = [{ id: 'ananya', name: 'Ananya Bose', office: 'Kolkata', timeZone: 'Asia/Kolkata' }];
const T0 = Date.UTC(2026, 9, 26, 9, 0, 0);
const at = seconds => T0 + seconds * 1000;

// Runs tick() once per second from `from` to `to` (inclusive) and returns every event.
function run(tracker, from, to) {
  const events = [];
  for (let second = from; second <= to; second++) events.push(...tracker.tick(at(second)));
  return events;
}

function setup() {
  const tracker = new ActivityTracker(config, employees);
  const token = tracker.login('ananya', at(0));
  return { tracker, token, user: tracker.users.get('ananya') };
}

test('two tabs on one laptop plus a phone count as one person, and overlapping time counts once', () => {
  const { tracker, token, user } = setup();
  tracker.connect('tab-1', token, { deviceId: 'laptop', deviceLabel: 'Computer · Chrome' });
  tracker.connect('tab-2', token, { deviceId: 'laptop', deviceLabel: 'Computer · Chrome' });
  tracker.connect('phone', token, { deviceId: 'phone', deviceLabel: 'Phone · Chrome' });
  for (let second = 1; second <= 10; second++) {
    tracker.input('tab-1', at(second));
    tracker.input('phone', at(second));
    tracker.tick(at(second));
  }
  assert.equal(user.totals.active, 10_000);
  const [row] = tracker.snapshot(at(10)).employees;
  assert.deepEqual(row.devices, [{ label: 'Computer · Chrome', tabs: 2, apps: ['Console'] }, { label: 'Phone · Chrome', tabs: 1, apps: ['Console'] }]);
});

test('console and TMS open at once: one person, time counted once and credited to the app in use', () => {
  const { tracker, token, user } = setup();
  tracker.connect('console-tab', token, { deviceId: 'laptop', deviceLabel: 'Computer · Chrome', app: 'Console' });
  tracker.connect('tms-tab', token, { deviceId: 'laptop', deviceLabel: 'Computer · Chrome', app: 'TMS' });
  for (let second = 1; second <= 10; second++) {
    tracker.input('console-tab', at(second));
    tracker.tick(at(second));
  }
  for (let second = 11; second <= 20; second++) {
    tracker.input('tms-tab', at(second));
    tracker.tick(at(second));
  }
  tracker.work('tms-tab', 'Published module: UK student visa update', at(21));
  tracker.tick(at(21));
  assert.equal(user.totals.active + user.totals.working, 21_000);
  const [row] = tracker.snapshot(at(21)).employees;
  assert.deepEqual(row.apps, [{ name: 'TMS', seconds: 11 }, { name: 'Console', seconds: 10 }]);
  assert.deepEqual(row.devices, [{ label: 'Computer · Chrome', tabs: 2, apps: ['Console', 'TMS'] }]);
  assert.equal(row.lastWorkApp, 'TMS');
  assert.equal(tracker.myDay('console-tab', at(21)).workLog[0].app, 'TMS');
});

test('only known Crizac apps are accepted; anything else a tab claims counts as the console', () => {
  const { tracker, token } = setup();
  const claims = ['__proto__', 'constructor', 'Made-up app', ...Array.from({ length: 50 }, (_, i) => `app-${i}`)];
  claims.forEach((app, i) => {
    tracker.connect(`tab-${i}`, token, { deviceId: 'laptop', app });
    tracker.input(`tab-${i}`, at(i + 1));
    tracker.tick(at(i + 1));
  });
  const [row] = tracker.snapshot(at(claims.length)).employees;
  assert.deepEqual(row.apps, [{ name: 'Console', seconds: claims.length }]);
  assert.deepEqual(row.devices[0].apps, ['Console']);
  assert.equal(Object.getPrototypeOf({}).polluted, undefined);
});

test('input on one tab keeps the person active even when another tab is idle', () => {
  const { tracker, token, user } = setup();
  tracker.connect('busy', token, {});
  tracker.connect('forgotten', token, {});
  tracker.heartbeat('forgotten', { visible: false, secondsSinceInput: 500 }, at(30));
  tracker.heartbeat('busy', { visible: true, secondsSinceInput: 2 }, at(30));
  assert.equal(tracker.stateOf(user, at(30)), 'active');
});

test('a dropped connection makes someone Away, not logged out', () => {
  const { tracker, token, user } = setup();
  tracker.connect('phone', token, {});
  tracker.input('phone', at(5));
  tracker.disconnect('phone');
  assert.deepEqual(run(tracker, 1, 30), []);
  assert.equal(tracker.stateOf(user, at(30)), 'away');
  assert.ok(user.loggedIn);
  assert.equal(user.totals.away, 30_000);
});

test('no input anywhere: one warning, then logout on every connection', () => {
  const { tracker, token, user } = setup();
  tracker.connect('tab-1', token, {});
  tracker.connect('phone', token, {});
  const events = run(tracker, 1, 60);
  assert.deepEqual(events.map(event => [event.type, event.secondsLeft ?? null]), [['warning', 20], ['logout', null]]);
  assert.deepEqual(events[1].connIds.sort(), ['phone', 'tab-1']);
  assert.equal(tracker.stateOf(user, at(60)), 'logged_out');
  // The old token no longer works on any device.
  assert.equal(tracker.connect('tab-3', token, {}), null);
});

test('activity after the warning cancels the logout', () => {
  const { tracker, token, user } = setup();
  tracker.connect('tab', token, {});
  assert.equal(run(tracker, 1, 45).filter(event => event.type === 'warning').length, 1);
  tracker.input('tab', at(46));
  // The next warning would only be due 40 s after that input.
  assert.deepEqual(run(tracker, 46, 85), []);
  assert.ok(user.loggedIn);
});

test('saving something counts as Working; mouse movement alone gets flagged after a while', () => {
  const { tracker, token, user } = setup();
  tracker.connect('tab', token, {});
  tracker.work('tab', 'Saved a note on 358120', at(1));
  assert.equal(tracker.stateOf(user, at(10)), 'working');
  // Gone quiet after saving: Idle, not Working.
  assert.equal(tracker.stateOf(user, at(30)), 'idle');
  for (let second = 2; second <= 120; second++) tracker.input('tab', at(second));
  assert.equal(tracker.stateOf(user, at(120)), 'active');
  const [row] = tracker.snapshot(at(120)).employees;
  assert.equal(row.noWorkFor, 119);
  assert.equal(row.lastWork, 'Saved a note on 358120');
});

test('a device clock or reported time can never move activity into the future or the past', () => {
  const { tracker, token, user } = setup();
  tracker.connect('tab', token, {});
  tracker.heartbeat('tab', { visible: true, secondsSinceInput: -500 }, at(10));
  tracker.heartbeat('tab', { visible: true, secondsSinceInput: 'soon' }, at(10));
  assert.equal(user.lastInputAt, at(0));
  tracker.heartbeat('tab', { visible: true, secondsSinceInput: 3 }, at(10));
  assert.equal(user.lastInputAt, at(7));
});

test('a connection re-bound to another employee leaves no stale entry behind', () => {
  const tracker = new ActivityTracker(config, [...employees, { id: 'rahul', name: 'Rahul Sharma' }]);
  const ananya = tracker.login('ananya', at(0));
  const rahul = tracker.login('rahul', at(0));
  tracker.connect('tab', ananya, {});
  tracker.connect('tab', rahul, {});
  tracker.disconnect('tab');
  assert.equal(tracker.users.get('ananya').conns.size, 0);
  assert.doesNotThrow(() => tracker.snapshot(at(1)));
});

test('repeated logins keep at most 20 tokens per employee', () => {
  const tracker = new ActivityTracker(config, employees);
  const first = tracker.login('ananya', at(0));
  for (let i = 0; i < 30; i++) tracker.login('ananya', at(0));
  assert.equal(tracker.users.get('ananya').tokens.size, 20);
  assert.equal(tracker.userForToken(first), undefined);
});

test('unknown employees cannot log in; load-test bots are capped, counted, and hidden from the table', () => {
  const tracker = new ActivityTracker(config, employees);
  assert.equal(tracker.login('mallory', at(0)), null);
  assert.equal(tracker.login('bot-10001', at(0)), null);
  assert.ok(tracker.login('bot-7', at(0)));
  const snapshot = tracker.snapshot(at(1));
  assert.equal(snapshot.botsOnline, 1);
  assert.deepEqual(snapshot.employees.map(row => row.id), ['ananya']);
});

// ── Additions: activity % per block, work actions, call/meeting/break, "My day", too-regular flag ──

const blockOf = (snapshotRow, second) => snapshotRow.blocks.find(block => block.start === at(second));

test('activity % per block: seconds with input ÷ seconds at the computer, and two tabs reporting the same second count once', () => {
  const { tracker, token } = setup();
  tracker.connect('tab-1', token, {});
  tracker.connect('tab-2', token, {});
  run(tracker, 1, 29);
  // Both tabs report input in each of the last 30 seconds (1 … 30).
  const lastThirty = Array.from({ length: 30 }, (_, ago) => ago);
  tracker.heartbeat('tab-1', { visible: true, secondsSinceInput: 0, inputSeconds: lastThirty }, at(30));
  tracker.heartbeat('tab-2', { visible: true, secondsSinceInput: 0, inputSeconds: lastThirty }, at(30));
  run(tracker, 30, 60);
  const [row] = tracker.snapshot(at(60)).employees;
  assert.equal(blockOf(row, 0).activity, 50);
  assert.equal(row.activity, 50);
});

test('nonsense input reports are ignored', () => {
  const { tracker, token } = setup();
  tracker.connect('tab', token, {});
  tracker.heartbeat('tab', { visible: true, secondsSinceInput: 0, inputSeconds: [-1, 1.5, 'x', 5000, 1e9] }, at(30));
  tracker.heartbeat('tab', { visible: true, secondsSinceInput: 0, inputSeconds: 'all of them' }, at(30));
  assert.equal(tracker.dayOf(tracker.users.get('ananya'), at(30)).activeSeconds, 0);
});

test('work actions are counted per block and for the day', () => {
  const { tracker, token } = setup();
  tracker.connect('tab', token, {});
  tracker.work('tab', 'Saved a note on 358120', at(5));
  tracker.work('tab', 'Opened application 358121', at(65));
  tracker.work('tab', 'Updated status on 358122', at(70));
  run(tracker, 1, 80);
  const [row] = tracker.snapshot(at(80)).employees;
  assert.equal(blockOf(row, 0).work, 1);
  assert.equal(blockOf(row, 60).work, 2);
  assert.equal(row.workCount, 3);
});

test('on a call: idle logout paused, time left out of activity %, and it ends by itself after the safety limit', () => {
  const { tracker, token, user } = setup();
  tracker.connect('tab', token, {});
  tracker.setStatus('tab', 'call', at(0));
  // Typing notes during the call doesn't count towards activity %.
  tracker.heartbeat('tab', { visible: true, secondsSinceInput: 0, inputSeconds: [0, 1, 2] }, at(10));
  // No warning or logout during the call, even with the laptop closed.
  tracker.disconnect('tab');
  assert.deepEqual(run(tracker, 1, 179), []);
  assert.equal(tracker.stateOf(user, at(100)), 'call');
  assert.equal(user.totals.call, 179_000);
  const [row] = tracker.snapshot(at(179)).employees;
  assert.equal(blockOf(row, 0).activity, null);
  assert.equal(row.manual.endsIn, 1);
  // Safety limit (180 s): the call ends by itself and the normal idle clock starts from then.
  run(tracker, 180, 180);
  assert.equal(user.manual, null);
  assert.equal(tracker.stateOf(user, at(181)), 'away');
  const events = run(tracker, 181, 240);
  assert.deepEqual(events.map(event => event.type), ['warning', 'logout']);
  assert.equal(events[1].reason, 'idle');
});

test('ending a status by hand restarts the idle clock; unknown statuses are ignored', () => {
  const { tracker, token, user } = setup();
  tracker.connect('tab', token, {});
  tracker.setStatus('tab', 'break', at(0));
  run(tracker, 1, 100);
  tracker.setStatus('tab', null, at(100));
  assert.equal(tracker.stateOf(user, at(101)), 'active');
  assert.deepEqual(run(tracker, 101, 139), []);
  tracker.setStatus('tab', 'nap', at(140));
  assert.equal(user.manual, null);
});

test('"too regular to be human": metronome-like input is flagged, human input is not', () => {
  const jiggled = setup();
  jiggled.tracker.connect('tab', jiggled.token, {});
  // The first gap is the long pause before the jiggler was plugged in; it mustn't hide the pattern.
  const metronome = [120_000, ...Array.from({ length: 20 }, (_, i) => 1000 + (i % 3) - 1)];
  jiggled.tracker.heartbeat('tab', { visible: true, secondsSinceInput: 0, gaps: metronome }, at(25));
  const [flagged] = jiggled.tracker.snapshot(at(25)).employees;
  assert.equal(flagged.tooRegular.everyMs, 1000);
  assert.deepEqual([flagged.tooRegular.same, flagged.tooRegular.gaps], [20, 21]);
  // Old gaps fall out of the window, so the flag clears once the jiggler stops.
  assert.equal(jiggled.tracker.snapshot(at(90)).employees[0].tooRegular, null);

  const human = setup();
  human.tracker.connect('tab', human.token, {});
  const uneven = [400, 2300, 900, 1500, 650, 3100, 1200, 800, 2700, 450, 1900, 1100, 600, 2200, 1400, 950, 3000, 700, 1600, 500];
  human.tracker.heartbeat('tab', { visible: true, secondsSinceInput: 0, gaps: uneven }, at(25));
  assert.equal(human.tracker.snapshot(at(25)).employees[0].tooRegular, null);

  const few = setup();
  few.tracker.connect('tab', few.token, {});
  few.tracker.heartbeat('tab', { visible: true, secondsSinceInput: 0, gaps: [1000, 1000, 1000] }, at(5));
  assert.equal(few.tracker.snapshot(at(5)).employees[0].tooRegular, null);
});

test('"My day" shows an employee their own record, and only through their own connection', () => {
  const { tracker, token } = setup();
  tracker.connect('tab', token, {});
  tracker.work('tab', 'Saved a note on 358120', at(5));
  run(tracker, 1, 10);
  const day = tracker.myDay('tab', at(10));
  assert.equal(day.name, 'Ananya Bose');
  assert.deepEqual(day.workLog.map(item => item.label), ['Saved a note on 358120']);
  assert.equal(day.totals.working, 10);
  assert.equal(tracker.myDay('someone-else', at(10)), null);
});

// ── Daily records, reports and saving to disk ──

const { dayKey } = require('../src/days');

test('each day is filed under the employee\'s own local date, and local midnight starts a new day', () => {
  // 18:29:50 UTC is 23:59:50 in Kolkata, so ten seconds later it's a new day there.
  const base = Date.UTC(2026, 9, 26, 18, 29, 50);
  const tracker = new ActivityTracker(config, employees);
  const token = tracker.login('ananya', base);
  tracker.connect('tab', token, {});
  for (let s = 1; s <= 20; s++) {
    tracker.input('tab', base + s * 1000);
    tracker.tick(base + s * 1000);
  }
  const user = tracker.users.get('ananya');
  assert.equal(dayKey(base, 'Asia/Kolkata'), '2026-10-26');
  assert.equal(dayKey(base + 10_000, 'Asia/Kolkata'), '2026-10-27');
  assert.equal(user.days.get('2026-10-26').active, 10_000);
  assert.equal(user.days.get('2026-10-27').active, 10_000);
});

test('the report adds up a week per person, with a row per day and team totals', () => {
  const { tracker, token } = setup();
  tracker.connect('tab', token, { app: 'Console' });
  tracker.work('tab', 'Saved a note on 358120', at(1));
  for (let s = 1; s <= 30; s++) {
    tracker.input('tab', at(s));
    tracker.tick(at(s));
  }
  tracker.heartbeat('tab', { visible: true, secondsSinceInput: 0, inputSeconds: Array.from({ length: 15 }, (_, i) => i) }, at(30));
  const report = tracker.report('week', at(30));
  const [ananya] = report.employees;
  assert.equal(ananya.days.length, 7);
  assert.equal(ananya.days[6].date, '2026-10-26');
  assert.equal(ananya.atComputer, 30);
  assert.equal(ananya.work, 1);
  assert.equal(ananya.activity, 50);
  assert.deepEqual(ananya.apps, [{ name: 'Console', seconds: 30 }]);
  assert.equal(ananya.daysActive, 1);
  assert.equal(report.team.work, 1);
  assert.equal(tracker.report('yesterday', at(30)).employees[0].atComputer, 0);
  assert.throws(() => tracker.report('forever', at(30)));
});

test('saved days come back after a restart, and today carries on from where it was', () => {
  const first = setup();
  first.tracker.connect('tab', first.token, {});
  first.tracker.work('tab', 'Saved a note on 358120', at(1));
  for (let s = 1; s <= 10; s++) first.tracker.tick(at(s));
  const saved = JSON.parse(JSON.stringify(first.tracker.exportDays()));

  const restarted = new ActivityTracker(config, employees, saved);
  const token = restarted.login('ananya', at(100));
  restarted.connect('tab', token, {});
  restarted.work('tab', 'Opened application 358121', at(101));
  for (let s = 101; s <= 105; s++) restarted.tick(at(s));
  const [row] = restarted.snapshot(at(105)).employees;
  assert.equal(row.workCount, 2);
  assert.equal(row.totals.working, 15);
  assert.deepEqual(restarted.myDay('tab', at(105)).workLog.map(item => item.label), ['Opened application 358121', 'Saved a note on 358120']);
});

test('a saved file can\'t smuggle in unknown apps, odd fields or unknown people', () => {
  const saved = JSON.parse('{"days":{"ananya":{"2026-10-26":{"working":5000,"apps":{"Console":5000,"__proto__":{"polluted":1},"Fake":9},"extra":"x"}},"mallory":{"2026-10-26":{"working":1}}}}');
  const tracker = new ActivityTracker(config, employees, saved);
  const day = tracker.users.get('ananya').days.get('2026-10-26');
  assert.deepEqual(Object.keys(day.apps), ['Console']);
  assert.equal(day.extra, undefined);
  assert.equal(day.working, 5000);
  assert.equal(tracker.users.has('mallory'), false);
  assert.equal({}.polluted, undefined);
});

test('a made-up sample week fills the days before today, marked as sample, and can be removed', () => {
  const { tracker } = setup();
  tracker.addSampleWeek(at(0));
  const report = tracker.report('week', at(0));
  for (const person of report.employees) {
    const sampleDays = person.days.filter(day => day.sample);
    assert.ok(sampleDays.length >= 4 && sampleDays.length <= 6);
    assert.ok(sampleDays.every(day => day.date < '2026-10-26' && day.work > 0 && day.atComputer > 3 * 3600));
  }
  assert.equal(report.sample, true);
  tracker.removeSample();
  assert.equal(tracker.report('week', at(0)).sample, false);
  assert.equal(tracker.report('week', at(0)).team.work, 0);
});

test('the sample week always shows Priya\'s "too regular" flag, whatever day the demo runs on', () => {
  const priya = [{ id: 'priya', name: 'Priya Das', office: 'Kolkata', timeZone: 'Asia/Kolkata' }];
  for (let day = 0; day < 7; day++) {
    const now = at(day * 86_400);
    const tracker = new ActivityTracker(config, priya);
    tracker.addSampleWeek(now);
    assert.ok(tracker.report('week', now).employees[0].flagged.regular > 0, `no flag when the demo runs ${dayKey(now, 'Asia/Kolkata')}`);
  }
});

test('load-test bots keep no daily records', () => {
  const tracker = new ActivityTracker(config, employees);
  const token = tracker.login('bot-1', at(0));
  tracker.connect('bot-tab', token, {});
  tracker.work('bot-tab', 'x', at(1));
  for (let s = 1; s <= 5; s++) tracker.tick(at(s));
  assert.equal(tracker.users.get('bot-1').days.size, 0);
  assert.deepEqual(Object.keys(tracker.exportDays().days), ['ananya']);
});
