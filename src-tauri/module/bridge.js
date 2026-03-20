(function () {
  if (window.desktopAPI) return;

  const core = window.__TAURI__?.core;
  const eventApi = window.__TAURI__?.event;

  if (!core || !eventApi) {
    console.warn("Tauri API is unavailable in this context");
    return;
  }

  const { invoke } = core;
  const { listen, emit } = eventApi;

  function localStorageSnapshot() {
    return Object.assign({}, localStorage);
  }

  async function appSnapshot() {
    return await invoke("store_all");
  }

  async function applyImportedSettings(settings) {
    const currentUrlBefore = await invoke("store_get", { key: "prismaUrl" });

    let pendingPrismaUrl = null;
    if (settings.app && typeof settings.app === "object") {
      for (const [key, value] of Object.entries(settings.app)) {
        const hasKey = await invoke("store_has", { key });
        if (!hasKey) continue;

        if (key === "prismaUrl") {
          pendingPrismaUrl = value;
          continue;
        }

        await invoke("store_set", { key, value });
      }
    }

    if (settings.prisma && typeof settings.prisma === "object") {
      if (settings.prisma.plugins) {
        try {
          const pluginsArray = JSON.parse(settings.prisma.plugins);
          const filteredPlugins = pluginsArray.filter((plugin) => {
            const cleanUrl = plugin.url.replace(/^https?:\/\//, "").replace(/^\/\//, "");
            return cleanUrl !== "prisma.kim/is.js";
          });
          settings.prisma.plugins = JSON.stringify(filteredPlugins, null, 2);
        } catch (e) {
          console.warn('Ошибка при обработке поля "plugins":', e);
        }
      }

      localStorage.clear();
      if (window.Prisma?.Cache?.clearAll) {
        try {
          window.Prisma.Cache.clearAll();
        } catch {
          // noop
        }
      }

      Object.entries(settings.prisma).forEach(([key, value]) => {
        localStorage.setItem(key, value);
      });
    }

    if (pendingPrismaUrl) {
      await invoke("store_set", { key: "prismaUrl", value: pendingPrismaUrl });
    }


    const newUrl = await invoke("store_get", { key: "prismaUrl" });
    const currentUrl = window.location.href;

    if (newUrl && newUrl !== currentUrlBefore) {
      window.location.href = newUrl;
      return;
    }

    if (currentUrl.includes(newUrl || currentUrlBefore || "")) {
      window.location.reload();
    }
  }

  window.require = function (module) {
    if (module === "fs") {
      return {
        existsSync: function (path) {
          return invoke("fs_exists_sync", { path });
        },
      };
    }

    if (module === "child_process") {
      return {
        spawn: function (command, args, options) {
          const id = Math.random().toString(36).slice(2, 11);
          const listeners = [];

          const on = async function (event, callback) {
            if (event === "error") {
              const unlisten = await listen(`child-process-spawn-error-${id}`, (ev) => callback(ev.payload));
              listeners.push(unlisten);
            } else if (event === "exit") {
              const unlisten = await listen(`child-process-spawn-exit-${id}`, (ev) => callback(ev.payload));
              listeners.push(unlisten);
            }
          };

          const stdoutOn = async function (event, callback) {
            if (event !== "data") return;
            const unlisten = await listen(`child-process-spawn-stdout-${id}`, (ev) => callback(ev.payload));
            listeners.push(unlisten);
          };

          const stderrOn = async function (event, callback) {
            if (event !== "data") return;
            const unlisten = await listen(`child-process-spawn-stderr-${id}`, (ev) => callback(ev.payload));
            listeners.push(unlisten);
          };

          invoke("child_process_spawn", {
            req: {
              id,
              cmd: command,
              args: Array.isArray(args) ? args : [],
              cwd: options?.cwd || null,
              env: options?.env || null,
            },
          }).catch((error) => {
            const message = String(error);
            console.warn("APP child_process_spawn invoke failed", { command, args, message });
            emit(`child-process-spawn-error-${id}`, message);
          });

          return {
            on,
            stdout: { on: stdoutOn },
            stderr: { on: stderrOn },
            removeAllListeners: function () {
              listeners.splice(0).forEach((unlisten) => {
                try {
                  unlisten();
                } catch {
                  // noop
                }
              });
            },
          };
        },
      };
    }

    return undefined;
  };

  window.desktopAPI = {
    closeApp: () => invoke("close_app"),
    toggleFullscreen: () => invoke("toggle_fullscreen"),
    loadUrl: (url) => invoke("load_url", { url }),
    getAppVersion: () => invoke("get_app_version"),

    appUpdater: {
      info: () =>
        invoke("app_installation_info").catch((e) => ({
          portable: false,
          message: String(e),
        })),
      check: () =>
        invoke("app_check_update").catch((e) => ({
          available: false,
          message: String(e),
        })),
      install: () =>
        invoke("app_install_update").catch((e) => ({
          success: false,
          updated: false,
          message: String(e),
        })),
    },


    store: {
      get: (key) => invoke("store_get", { key }),
      set: (key, value) => invoke("store_set", { key, value }),
      has: (key) => invoke("store_has", { key }),
      delete: (key) => invoke("store_delete", { key }),
    },

    exportSettingsToFile: async () => {
      try {
        const settings = {
          appVersion: await invoke("get_app_version"),
          dateCreated: new Date().toISOString(),
          app: await appSnapshot(),
          prisma: localStorageSnapshot(),
        };

        return await invoke("export_settings_to_file", { settings });
      } catch (err) {
        return { success: false, message: `Не удалось экспортировать настройки: ${err?.message || err}` };
      }
    },

    importSettingsFromFile: async () => {
      try {
        const result = await invoke("import_settings_from_file");
        if (!result?.success) {
          return result || { success: false, message: "Не удалось импортировать настройки" };
        }

        const settings = result.settings;
        if (typeof settings !== "object" || settings === null) {
          return { success: false, message: "Неверный формат файла" };
        }

        await applyImportedSettings(settings);
        return {
          success: true,
          message: "Настройки успешно импортированы, производим перезапуск...",
        };
      } catch (err) {
        return { success: false, message: `Не удалось импортировать настройки: ${err?.message || err}` };
      }
    },

    torrServer: {
      start: (args) =>
        invoke("torrserver_start", {
          args: Array.isArray(args) ? args.map((v) => String(v)) : [],
        }).catch((e) => ({ success: false, message: String(e) })),
      stop: () =>
        invoke("torrserver_stop").catch((e) => ({ success: false, message: String(e) })),
      restart: (args) =>
        invoke("torrserver_restart", {
          args: Array.isArray(args) ? args.map((v) => String(v)) : [],
        }).catch((e) => ({ success: false, message: String(e) })),
      getStatus: () =>
        invoke("torrserver_status").catch((e) => ({
          success: false,
          message: String(e),
          status: "error",
          running: false,
        })),
      download: (version) =>
        invoke("torrserver_download", {
          version: version == null ? null : String(version),
        }).catch((e) => ({ success: false, message: String(e) })),
      checkUpdate: () =>
        invoke("torrserver_check_update").catch((e) => ({
          hasUpdate: false,
          message: String(e),
        })),
      update: () =>
        invoke("torrserver_update").catch((e) => ({ success: false, message: String(e) })),
      onOutput: async (callback) => {
        const unlisten = await listen("torrserver-output", (event) => callback(event.payload));
        return () => unlisten();
      },
      isRunning: async () => {
        const status = await invoke("torrserver_status").catch(() => ({ running: false }));
        return Boolean(status?.running);
      },
      uninstall: (keepData = false) =>
        invoke("torrserver_uninstall", { keepData: Boolean(keepData) }).catch((e) => ({
          success: false,
          message: String(e),
        })),
      isInstalled: () =>
        invoke("torrserver_is_installed").catch((e) => ({
          installed: false,
          executableExists: false,
          message: String(e),
        })),
    },

    folder: {
      open: (path) => invoke("open_folder", { path }),
    },

    external: {
      open: (url) => invoke("open_external_url", { url }),
    },

    findPlayer: async () => {
      const result = await invoke("find_player");
      if (result?.success && result?.path) {
        const playerPath = String(result.path);
        localStorage.setItem("player_nw_path", playerPath);
        localStorage.setItem("player_torrent", "other");
        if (window.Prisma?.Storage) {
          try {
            window.Prisma.Storage.set("player_nw_path", playerPath);
            window.Prisma.Storage.set("player_torrent", "other");
          } catch {
            // noop
          }
        }
      }
      return result;
    },
  };

  console.log("Tauri bridge injected: window.desktopAPI is available");
})();
