# Activity tracking demo

A small working demo of tracking employee activity in a web console over WebSockets: each open tab
keeps one connection, the server merges every tab and device per employee, and the idle logout happens
on all of them at once.

- `/` is a pretend employee console (made-up employees and applications), with a status picker
  (Automatic / On a call / In a meeting / On a break), a "My day" tab, and a demo-only "pretend a mouse jiggler" switch.
- `/tms` is a pretend second Crizac app (Training Management System). It loads the same tracking script
  (`public/console.js`, with `<body data-app="TMS">`) and shares the console's login, so one person working in
  both is counted once; time in use is credited to the app with the latest input.
- `/reports` is the managers' daily and weekly summary (Today / Yesterday / Last 7 days, CSV download), built
  from one record per employee per local date. Records are saved to `data/activity.json` every 5 seconds and on
  shutdown (set `DATA_FILE` to use another file; a real rollout would use Crizac's database). A demo-only button
  adds a clearly marked made-up week (only from the demo laptop itself, not from other devices on the Wi-Fi).
- `/manager` is a live manager screen: status, devices, a 10-minute timeline with activity % per block and
  work actions underneath, time per state, and flags.

## Run

Double-click `start-demo.cmd`, or:

```bash
npm install
npm start            # demo timings: logout after 60 s of no activity
npm run start:real   # realistic timings: logout after 5 minutes
npm test             # tracker rules
npm run loadtest -- 2000 30 30   # employees, check-in seconds, measuring seconds (server running)
```

A phone on the same Wi-Fi can open the address the server prints (Windows may ask to allow Node.js through the firewall).

## How it decides

| Status | Meaning |
|---|---|
| Working | input recently and something opened or saved recently |
| Active | mouse/keyboard input recently, nothing saved |
| Idle | connected, no input |
| Away | no tab or device connected (locked phone, closed laptop, Wi-Fi off) |
| On a call / In a meeting / On a break | chosen by the employee; no idle logout; ends by itself after `manualMax` |
| Logged out | no input on any tab or device for the idle limit, or logged out by hand |

- **Several tabs and devices:** the server keeps one status per employee, so overlapping time counts once.
- **Clocks and time zones:** tabs report "seconds since my last input", never a time of day; the server
  stores its own UTC clock and the manager screen shows each office's local time.
- **Phones and sleeping laptops:** the server pings every connection and drops silent ones, which makes
  the employee Away, not logged out. The logout only follows a full idle period with no input anywhere.
- **Fake activity:** mouse movement alone shows as Active and is flagged when nothing has been opened or
  saved for a while. In a real console, "work" events should come from the backend when it handles a save,
  not from the browser.
- **Activity % per block:** each heartbeat lists which recent seconds had any input (as "seconds ago", never
  what the input was). The server merges them across tabs and devices (a second counts once) and divides by the
  seconds the person was at the computer; calls, meetings and breaks are left out.
- **Mouse jigglers:** each heartbeat also lists the gaps between bursts of input. If at least 90% of the gaps in
  the window are within 5% of the median gap, the manager sees a "too regular to be human" flag. The median
  keeps one long pause (before the jiggler was plugged in) from hiding the pattern.

Timings live in `src/config.js`; the rules in `src/tracker.js` (tested in `test/tracker.test.js`).

## Load test result (this laptop, 2026-10-26)

2,000 simulated employees, one check-in every 30 s: server memory 42 → 72 MB (about 15 KB per employee),
about 3% of one CPU core, 66 messages per second.

Re-run after adding activity seconds and input gaps to every heartbeat: 58 → 87 MB (about 15 KB per employee),
about 3.5% of one CPU core, 69 messages per second. The extra data costs almost nothing.
