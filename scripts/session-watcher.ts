import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseIcsFeed } from "../src/ics-input/parse.js";

const run = promisify(execFile);

const FEED_URL = process.env.WATCHER_FEED_URL; // e.g. http://localhost:3067/feeds/study.ics?token=...
const OBS_PATH = process.env.WATCHER_OBS_PATH ?? "C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe";
const TZ = process.env.WATCHER_TZ ?? "Europe/Paris";
const STATE_FILE = "./data/watcher-fired.json";
const GRACE_MS = 5 * 60_000; // still fire if the laptop wakes up within 5 min of the start

if (!FEED_URL) throw new Error("Set WATCHER_FEED_URL");

const fired = new Set<string>(existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : []);
function saveFired() {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify([...fired]));
}

let sessions: { uid: string; summary: string; startUtc: Date }[] = [];

async function refresh() {
  try {
    const res = await fetch(FEED_URL!);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const now = Date.now();
    const { events } = parseIcsFeed(await res.text(), {
      rangeStartUtc: new Date(now - 86_400_000),
      rangeEndUtc: new Date(now + 30 * 86_400_000),
      fallbackTimezone: TZ,
    });
    sessions = events.filter((e) => e.uid.startsWith("study-"));
  } catch (err) {
    console.warn("feed refresh failed, keeping previous data:", (err as Error).message);
  }
}

function ring() {
  spawn("powershell.exe", [
    "-NoProfile", "-Command",
    "1..3 | ForEach-Object { (New-Object Media.SoundPlayer 'C:\\Windows\\Media\\Alarm01.wav').PlaySync() }",
  ], { stdio: "ignore", windowsHide: true });
}

async function launchObs() {
  const { stdout } = await run("tasklist", ["/FI", "IMAGENAME eq obs64.exe", "/NH"]);
  if (stdout.toLowerCase().includes("obs64.exe")) return; // already running
  // OBS must be started from its own bin folder or it can't find its data files.
  spawn(OBS_PATH, [], { cwd: dirname(OBS_PATH), detached: true, stdio: "ignore" }).unref();
}

async function tick() {
  const now = Date.now();
  for (const s of sessions) {
    const start = s.startUtc.getTime();
    if (now < start || now > start + GRACE_MS) continue;
    const key = `${s.uid}|${s.startUtc.toISOString()}`; // includes start, so a rescheduled session fires again
    if (fired.has(key)) continue;
    fired.add(key);
    saveFired();
    console.log(`Study session started: ${s.summary}`);
    ring();
    await launchObs().catch((e) => console.warn("OBS launch failed:", e.message));
  }
}

await refresh();
setInterval(refresh, 5 * 60_000);
setInterval(() => void tick(), 15_000);
console.log(`Watching ${sessions.length} upcoming study sessions`);