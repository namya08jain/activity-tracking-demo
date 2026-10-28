// Local calendar dates per office. Everything is stored on the server's UTC clock; a day is filed under the
// employee's own local date (a London "Monday" and a Kolkata "Monday" start at different moments).

const formatters = new Map();  // time zone → Intl formatter
const offsets = new Map();     // time zone → { hour, offset } (offset in ms, re-checked every hour for summer time)

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// Milliseconds to add to a UTC time to get the local wall-clock time in `timeZone`.
function zoneOffset(ms, timeZone) {
  const hour = Math.floor(ms / 3_600_000);
  const cached = offsets.get(timeZone);
  if (cached && cached.hour === hour) return cached.offset;
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offset = asUtc - Math.floor(ms / 1000) * 1000;
  offsets.set(timeZone, { hour, offset });
  return offset;
}

// "2026-10-27": the local date in `timeZone` at the UTC time `ms`.
function dayKey(ms, timeZone) {
  return new Date(ms + zoneOffset(ms, timeZone)).toISOString().slice(0, 10);
}

// The date `delta` days before or after `key`.
function shiftDay(key, delta) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

// UTC time of local midnight at the start of `key` in `timeZone`.
function startOfDay(key, timeZone) {
  const guess = Date.parse(`${key}T00:00:00Z`);
  return guess - zoneOffset(guess, timeZone);
}

// 0 = Sunday … 6 = Saturday.
function weekday(key) {
  return new Date(`${key}T00:00:00Z`).getUTCDay();
}

module.exports = { dayKey, shiftDay, startOfDay, weekday };
