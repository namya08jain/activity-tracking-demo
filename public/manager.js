// Manager side of the demo: the server pushes a snapshot of every employee once a second.
// Uses STATE_LABELS, duration, el, localTime, blockName and blockChart from shared.js.
const $ = id => document.getElementById(id);

function statusDetail(employee, config) {
  if (employee.state === 'logged_out') {
    if (employee.logoutReason === 'idle') return `after ${duration(config.idleLogout)} with no activity`;
    if (employee.logoutReason) return employee.logoutReason;
    // No reason recorded (for example after a server restart): say when they were last seen today, if at all.
    return employee.lastSeenToday ? `last seen ${localTime(employee.lastSeenToday, employee.timeZone)}` : "hasn't logged in yet";
  }
  if (employee.manual) {
    return `${duration(employee.manual.seconds)} so far · no idle logout · ends by itself in ${duration(employee.manual.endsIn)}`;
  }
  if (employee.state === 'away') return `no device connected · logout in ${employee.secondsUntilLogout}s if nobody returns`;
  if (employee.state === 'working') return `${employee.lastWork} (in ${employee.lastWorkApp})`;
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

// Counts per status across the team; doubles as the colour key.
function summary(employees) {
  const order = ['working', 'active', 'idle', 'away', 'call', 'meeting', 'break', 'logged_out'];
  return order.map(state => {
    const count = employees.filter(employee => employee.state === state).length;
    const item = el('div', `summary-item${count ? '' : ' zero'}`);
    const label = el('span', 'summary-label');
    label.append(el('i', `dot ${state}`), document.createTextNode(STATE_LABELS[state]));
    item.append(el('b', '', String(count)), label);
    return item;
  });
}

function render(snapshot) {
  const { config, now } = snapshot;
  $('timeline-head').textContent = `Last ${Math.round(config.timelineWindow / 60)} minutes`;

  const offices = new Map(snapshot.employees.map(employee => [employee.office, employee.timeZone]));
  $('clocks').replaceChildren(...[...offices].map(([office, timeZone]) => {
    const clock = el('span', 'clock');
    clock.append(el('span', '', office), el('b', '', localTime(now, timeZone)));
    return clock;
  }));
  $('summary').replaceChildren(...summary(snapshot.employees));

  const rows = snapshot.employees.map(employee => {
    // Someone who hasn't logged in today gets a short row: nothing to chart yet.
    const notStarted = employee.state === 'logged_out' && !employee.logoutReason && !Object.values(employee.totals).some(Boolean);
    const row = el('div', `row ${employee.state}${notStarted ? ' not-started' : ''}`);

    const who = el('div', 'cell person-cell');
    const avatar = el('span', `avatar ${employee.state}`, initials(employee.name));
    const text = el('div');
    text.append(el('div', 'name', employee.name), el('div', 'muted small', `${employee.office}, ${localTime(now, employee.timeZone)} local`));
    who.append(avatar, text);

    const status = el('div', 'cell status-cell');
    const label = employee.state === 'logged_out' && !employee.logoutReason && !employee.lastSeenToday ? 'Not logged in' : STATE_LABELS[employee.state];
    status.append(el('span', `pill ${employee.state}`, label));
    if (!notStarted) status.append(el('div', 'muted small detail', statusDetail(employee, config)));
    if (employee.noWorkFor) status.append(el('div', 'flag', `⚑ Present but nothing opened or saved for ${duration(employee.noWorkFor)}`));
    if (employee.tooRegular) {
      const { everyMs, same, gaps } = employee.tooRegular;
      status.append(el('div', 'flag', `⚑ Too regular to be human: input every ${(everyMs / 1000).toFixed(1)}s like clockwork (${same} of ${gaps} gaps the same). Possibly a mouse jiggler; worth a look.`));
    }

    if (notStarted) {
      row.append(who, status);
      return row;
    }

    const devices = el('div', 'cell devices-cell');
    if (!employee.devices.length) devices.append(el('span', 'muted small', 'No device connected'));
    for (const device of employee.devices) {
      const chip = el('div', 'chip device-chip');
      chip.append(el('span', '', device.label));
      // Second line: which Crizac apps are open on this device, and how many tabs.
      const apps = el('span', 'chip-apps');
      for (const app of device.apps) apps.append(el('span', 'app-tag', app));
      if (device.tabs > 1) apps.append(el('span', 'chip-tabs', `${device.tabs} tabs`));
      chip.append(apps);
      devices.append(chip);
    }

    const bar = el('div', 'cell timeline-cell');
    bar.append(timeline(employee, now, config.timelineWindow * 1000), blockChart(employee.blocks, config.block, employee.timeZone));

    const totals = el('div', 'cell totals');
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
      // Calls, meetings and breaks only appear once someone has used them.
      if (['call', 'meeting', 'break'].includes(key) && !employee.totals[key] && employee.state !== key) continue;
      const line = el('span');
      line.append(el('i', `dot ${key}`), document.createTextNode(`${STATE_LABELS[key]} ${duration(employee.totals[key])}`));
      times.append(line);
    }
    totals.append(headline, times);
    if (employee.apps.length) {
      const apps = el('div', 'apps-time');
      apps.append(...employee.apps.map(app => appTime(app)));
      totals.append(apps);
    }

    row.append(who, status, devices, bar, totals);
    return row;
  });
  $('rows').replaceChildren(...rows);

  const { stats } = snapshot;
  const bots = snapshot.botsOnline ? `. Load test: ${snapshot.botsOnline.toLocaleString()} simulated employees online` : '';
  $('server').textContent = `Server: ${stats.connections.toLocaleString()} live connections, ${stats.rssMB} MB memory, ${stats.cpuPercent}% CPU, ${stats.messagesPerSecond.toLocaleString()} messages a second${bots}`;
}

function connect() {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=manager`);
  socket.onopen = () => { $('live').classList.remove('off'); };
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'snapshot') render(message);
  };
  socket.onclose = () => {
    $('live').classList.add('off');
    setTimeout(connect, 2000);
  };
}

connect();
