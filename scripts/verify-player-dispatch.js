// Проверяет, какой плеер получает запуск при разных настройках.
// Вырезает patchPlayerExternalLaunch из client-inject.js и гоняет его в VM
// с заглушками — так же, как verify-external-progress-manager.js.
//
//   node scripts/verify-player-dispatch.js

import fs from "fs";
import vm from "vm";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.join(__dirname, "..", "src-tauri", "module", "client-inject.js"),
  "utf8",
);

function slice(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`Не найден блок: ${startMarker.trim()}`);
  return source.slice(start, end);
}

const code =
  slice("  function externalPlayerPathLooksPotPlayer(path) {", "\n  function externalTimelineHash") +
  slice("  function patchPlayerExternalLaunch() {", "\n  async function initAppAutoUpdate");

function run({ player, playerPath, torrent = true }) {
  const calls = [];

  const storage = {
    player_torrent: torrent ? player : null,
    player: torrent ? null : player,
    player_nw_path: playerPath,
  };

  const context = {
    console: { warn() {}, log() {} },
    Number, String, Boolean, JSON, Math, Date,
    setTimeout: (fn) => fn(),
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    externalMediaKey: () => "key",
    externalTimelineHash: () => null,
    externalProgressManager: { resumePosition: () => 0, attach() {}, stop() {} },
    installExternalProgressLifecycle() {},
    Prisma: {
      Platform: { macOS: () => false },
      Storage: { field: (key) => storage[key] ?? undefined },
      Player: {
        play: (data) => calls.push({ target: "inner", data }),
      },
    },
  };

  context.window = {
    // Патч проверяет window.Prisma — без этого он тихо не применится
    // и любой тест «пройдёт», показав встроенный плеер.
    Prisma: context.Prisma,
    desktopAPI: {
      player: {
        start: async (args) => {
          calls.push({ target: "potplayer", args });
          return { success: true, pid: 1 };
        },
      },
      external: { open: (url) => calls.push({ target: "external-url", url }) },
    },
    require: () => ({
      spawn: (cmd, args) => calls.push({ target: "spawn", cmd, args }),
    }),
    addEventListener() {},
  };
  context.Prisma.Player.__desktopPatched = false;

  vm.createContext(context);
  vm.runInContext(`${code}\npatchPlayerExternalLaunch();`, context);

  context.Prisma.Player.play({ url: "http://ts/stream", torrent_hash: torrent ? "abc" : undefined });
  return calls;
}

const POT = "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe";
const VLC = "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe";

const cases = [
  { name: "выбран встроенный, путь к PotPlayer остался", args: { player: "inner", playerPath: POT }, expect: "inner" },
  { name: "выбран встроенный, путь к VLC остался", args: { player: "inner", playerPath: VLC }, expect: "inner" },
  { name: "выбран PotPlayer", args: { player: "potplayer", playerPath: POT }, expect: "potplayer" },
  { name: "\"Другой плеер\" с путём к PotPlayer — таймкоды работают", args: { player: "other", playerPath: POT }, expect: "potplayer" },
  { name: "\"Другой плеер\" без пути — падаем во встроенный", args: { player: "other", playerPath: "" }, expect: "inner" },
  { name: "плеер не выбран — встроенный", args: { player: null, playerPath: "" }, expect: "inner" },
  { name: "выбран VLC с путём — прямой запуск", args: { player: "vlc", playerPath: VLC }, expect: "spawn" },
];

// --- переключение встроенный / внешний ---------------------------------------

function runMode({ start, path, saved, action, withBridge = false }) {
  const store = { ...start, player_nw_path: path };
  if (saved) store[EXTERNAL_ID_KEY] = saved;

  const context = {
    console: { warn() {}, log() {} },
    Number, String, Boolean, JSON, Math, Date,
    setTimeout: (fn) => fn(),
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    localStorage: {
      getItem: (key) => (key in store ? String(store[key]) : null),
      setItem: (key, value) => { store[key] = String(value); },
    },
    externalMediaKey: () => "key",
    externalTimelineHash: () => null,
    externalProgressManager: { resumePosition: () => 0, attach() {}, stop() {} },
    installExternalProgressLifecycle() {},
    Prisma: { Storage: { field: (key) => store[key], set(key, value) { store[key] = String(value); } } },
  };
  const bridgeCalls = [];
  context.window = {
    Prisma: context.Prisma,
    desktopAPI: withBridge
      ? {
          // Повторяет поведение setPlayerSelection из bridge.js
          setPlayerSelection: (id, playerPath) => {
            bridgeCalls.push({ id, playerPath });
            if (playerPath) store.player_nw_path = String(playerPath);
            ["player_torrent", "player_iptv", "player"].forEach((key) => {
              store[key] = String(id || "other");
            });
          },
        }
      : {},
  };

  vm.createContext(context);
  vm.runInContext(code, context);

  const before = context.currentPlayerMode();
  const result = context.applyPlayerMode(action);
  return { before, result, store, bridgeCalls };
}

const EXTERNAL_ID_KEY = "app_external_player_id";
const modeCases = [
  {
    name: "внешний → встроенный: все ключи становятся inner",
    run: () => runMode({ start: { player_torrent: "potplayer" }, path: POT, action: "inner" }),
    check: ({ store }) =>
      store.player_torrent === "inner" && store.player === "inner" && store.player_iptv === "inner",
  },
  {
    name: "переключение на встроенный сохраняет путь к внешнему",
    run: () => runMode({ start: { player_torrent: "potplayer" }, path: POT, action: "inner" }),
    check: ({ store }) => store.player_nw_path === POT,
  },
  {
    name: "встроенный → внешний: возвращается прежний плеер",
    run: () => runMode({ start: { player_torrent: "inner" }, path: POT, saved: "potplayer", action: "external" }),
    check: ({ result, store }) => result.id === "potplayer" && store.player_torrent === "potplayer",
  },
  {
    name: "внешний без сохранённого выбора: плеер угадывается по пути",
    run: () => runMode({ start: { player_torrent: "inner" }, path: POT, action: "external" }),
    check: ({ result }) => result.id === "potplayer" && !result.needsSetup,
  },
  {
    name: "внешний без пути и без выбора: просим настроить",
    run: () => runMode({ start: { player_torrent: "inner" }, path: "", action: "external" }),
    check: ({ result }) => result.needsSetup === true,
  },
  {
    name: "через мост: setPlayerSelection зовётся с inner и без пути",
    run: () => runMode({ start: { player_torrent: "potplayer" }, path: POT, action: "inner", withBridge: true }),
    check: ({ bridgeCalls, store }) =>
      bridgeCalls.length === 1 &&
      bridgeCalls[0].id === "inner" &&
      !bridgeCalls[0].playerPath &&
      store.player_torrent === "inner" &&
      store.player_nw_path === POT,
  },
  {
    name: "текущий режим определяется по player_torrent",
    run: () => runMode({ start: { player_torrent: "inner" }, path: "", action: "inner" }),
    check: ({ before }) => before === "inner",
  },
];

let failed = 0;
for (const testCase of cases) {
  const calls = run(testCase.args);
  const target = calls[0]?.target ?? "ничего";
  const ok = target === testCase.expect;
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${testCase.name}: ${target}${ok ? "" : ` (ожидалось ${testCase.expect})`}`);
}

for (const testCase of modeCases) {
  let ok = false;
  let detail = "";
  try {
    const outcome = testCase.run();
    ok = Boolean(testCase.check(outcome));
    detail = JSON.stringify(outcome.result);
  } catch (error) {
    detail = String(error && error.message ? error.message : error);
  }
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${testCase.name}${ok ? "" : ` -> ${detail}`}`);
}

const total = cases.length + modeCases.length;
console.log(failed ? `\n${failed} из ${total} не прошли` : `\nвсе ${total} проверки пройдены`);
process.exit(failed ? 1 : 0);
