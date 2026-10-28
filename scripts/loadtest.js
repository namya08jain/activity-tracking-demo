// Pretends to be many employees, each with one console tab open, to measure what the server needs.
// Usage (server running): npm run loadtest -- [employees=2000] [heartbeat seconds=30] [run seconds=40]
// Prints the server's memory, CPU and message rate before, during and after.
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 4100);
const base = `http://localhost:${PORT}`;
const [count = 2000, heartbeat = 30, duration = 40] = process.argv.slice(2).map(Number);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const stats = async () => (await fetch(`${base}/api/stats`)).json();

async function employee(index, sockets) {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: `bot-${index}` })
  });
  const { token } = await response.json();
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'hello', token, deviceId: `bot-device-${index}`, deviceLabel: 'Load test', tabId: `bot-tab-${index}` }));
  // Spread heartbeats across the interval, as real tabs opened at different times would be.
  // Each check-in carries what a real tab sends: about half the seconds since the last one had input,
  // plus a few gaps between bursts of input.
  const beat = () => ws.readyState === ws.OPEN && ws.send(JSON.stringify({
    type: 'heartbeat',
    visible: true,
    secondsSinceInput: Math.floor(Math.random() * 10),
    inputSeconds: Array.from({ length: Math.min(heartbeat, 120) }, (_, ago) => ago).filter(() => Math.random() < 0.5),
    gaps: Array.from({ length: 8 }, () => 300 + Math.floor(Math.random() * 4000))
  }));
  setTimeout(() => { beat(); ws.timer = setInterval(beat, heartbeat * 1000); }, Math.random() * heartbeat * 1000);
  sockets.push(ws);
}

(async () => {
  const before = await stats();
  console.log(`Before: ${before.connections} connections, ${before.rssMB} MB memory`);
  const sockets = [];
  for (let start = 0; start < count; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, count - start) }, (_, offset) => employee(start + offset + 1, sockets)));
  }
  console.log(`Connected ${sockets.length} simulated employees (heartbeat every ${heartbeat}s). Measuring for ${duration}s…`);

  const samples = [];
  for (let second = 0; second < duration; second += 2) {
    await pause(2000);
    samples.push(await stats());
  }
  const peak = samples.reduce((max, sample) => (sample.rssMB > max.rssMB ? sample : max), samples[0]);
  const average = key => Math.round((samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length) * 10) / 10;
  const perConnectionKB = Math.round(((peak.rssMB - before.rssMB) * 1024) / sockets.length * 10) / 10;

  console.log('');
  console.log(`Simulated employees:      ${sockets.length}`);
  console.log(`Server connections:       ${peak.connections}`);
  console.log(`Server memory:            ${before.rssMB} MB → ${peak.rssMB} MB (about ${perConnectionKB} KB per connected employee)`);
  console.log(`Server CPU (average):     ${average('cpuPercent')}% of one core`);
  console.log(`Messages per second:      ${average('messagesPerSecond')} (expected about ${Math.round(sockets.length / heartbeat)})`);

  for (const ws of sockets) {
    clearInterval(ws.timer);
    ws.close();
  }
  await pause(2000);
  const after = await stats();
  console.log(`After disconnecting:      ${after.connections} connections`);
  process.exit(0);
})().catch(error => { console.error(error.message); process.exit(1); });
