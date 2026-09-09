import fs from "fs";
import vm from "vm";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "..", "src-tauri", "module", "client-inject.js");
const source = fs.readFileSync(sourcePath, "utf8");
const startMarker = "  const EXTERNAL_PROGRESS_KEY";
const endMarker = "\n\n  function installExternalProgressLifecycle";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0) {
  throw new Error("Unable to locate externalProgressManager block in client-inject.js");
}

const storage = new Map();
const timeline = new Map();
const timelineUpdates = [];
const timelineHandlerUpdates = [];
const context = {
  console,
  Date,
  JSON,
  Math,
  Number,
  String,
  Boolean,
  setTimeout: () => 1,
  clearTimeout: () => {},
  localStorage: {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
  },
  Prisma: {
    Utils: {
      hash(value) {
        let result = 0;
        for (const char of String(value)) result = ((result << 5) - result + char.charCodeAt(0)) | 0;
        return result;
      },
    },
    Storage: { set() {} },
    Timeline: {
      view(hash) { return timeline.get(hash) || null; },
      update(update) {
        timelineUpdates.push({ ...update });
        timeline.set(update.hash, { percent: update.percent, time: update.time, duration: update.duration });
      },
    },
    Noty: { show() {} },
  },
};
context.window = {
  Prisma: context.Prisma,
  desktopAPI: {
    player: { readState: async () => ({ success: false, reason: "test_not_polled" }) },
    store: { set: async () => {} },
  },
};
context.globalThis = context;

vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}\n;globalThis.__manager = externalProgressManager;`, context, { filename: sourcePath });
const manager = context.__manager;
const progressKey = "prisma_desktop_external_progress_v1";

const episodeTimeline = {
  hash: 777,
  episode: 2,
  season: 1,
  handler(percent, time, duration) {
    timelineHandlerUpdates.push({ percent, time, duration });
    context.Prisma.Timeline.update({ hash: 777, percent, time, duration });
  },
};
const episodeData = {
  id: "movie-1",
  title: "Native PotPlayer Test",
  season_number: 1,
  episode_number: 2,
  timeline: episodeTimeline,
};
manager.attach({
  data: episodeData,
  mode: "play",
  pid: 42,
  url: "https://example.invalid/video.m3u8",
  key: "timeline:777",
  timelineHash: 777,
  timeline: episodeTimeline,
  resumePositionSec: 18,
});
manager.state.positionSec = 30;
manager.state.durationSec = 100;
manager.persist(true);

if (timelineUpdates.length !== 1) throw new Error(`Expected one Timeline update, got ${timelineUpdates.length}`);
if (timelineHandlerUpdates.length !== 1) throw new Error(`Expected one timeline handler call, got ${timelineHandlerUpdates.length}`);
const first = timelineUpdates[0];
if (first.hash !== 777 || first.time !== 30 || first.duration !== 100 || first.percent !== 30) {
  throw new Error(`Unexpected Timeline update: ${JSON.stringify(first)}`);
}
if (context.window.__desktop_external_progress_diagnostics.lastTimelineUpdate.saveMethod !== "timeline_handler") {
  throw new Error("The real timeline handler was not used");
}
if (context.window.__desktop_external_progress_diagnostics.inputTimelineHash !== 777 ||
    context.window.__desktop_external_progress_diagnostics.inputEpisode !== 2 ||
    context.window.__desktop_external_progress_diagnostics.inputSeason !== 1) {
  throw new Error("Episode diagnostics do not retain the source timeline identity");
}
const persisted = JSON.parse(storage.get(progressKey));
if (persisted["timeline:777"].positionSec !== 30 || persisted["timeline:777"].watched !== false) {
  throw new Error(`Unexpected fallback record: ${JSON.stringify(persisted["timeline:777"])}`);
}
if (manager.resumePosition("timeline:777", 777) !== 30) {
  throw new Error("Resume position did not prefer stored non-watched progress");
}

manager.state.positionSec = 96;
manager.persist(true);
const watched = timelineUpdates.at(-1);
if (watched.percent !== 100 || watched.time !== 100) {
  throw new Error(`Watched threshold did not produce 100% Timeline update: ${JSON.stringify(watched)}`);
}
if (manager.resumePosition("timeline:777", 777) !== 0) {
  throw new Error("Watched media must resume from zero");
}
if (context.window.__desktop_external_progress_diagnostics.timelineUpdates < 2) {
  throw new Error("Diagnostics did not record Timeline updates");
}

console.log(JSON.stringify({
  pass: true,
  timelineUpdates,
  timelineHandlerUpdates,
  fallback: JSON.parse(storage.get(progressKey)),
  diagnostics: context.window.__desktop_external_progress_diagnostics,
}, null, 2));
