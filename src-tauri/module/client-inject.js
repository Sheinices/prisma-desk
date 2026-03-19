(function () {
  "use strict";

  var action_icon =
    '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M10 0C4.48 0 0 4.48 0 10C0 15.52 4.48 20 10 20C15.52 20 20 15.52 20 10C20 4.48 15.52 0 10 0ZM13.53 11.23L8.35 14.82C7.59 15.35 7.15 15.04 7.37 14.15L8.32 10.31L6.67 9.9C5.92 9.72 5.83 9.2 6.46 8.76L11.64 5.17C12.4 4.64 12.84 4.95 12.62 5.84L11.67 9.68L13.32 10.09C14.07 10.28 14.16 10.79 13.53 11.23Z" fill="white"/>' +
    '</svg>';

  function toBool(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const v = value.trim().toLowerCase();
      return v === "1" || v === "true" || v === "yes" || v === "on";
    }
    return false;
  }

  function normalizeTsPort(value) {
    const parsed = Number.parseInt(String(value == null ? "" : value).trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return String(parsed);
    }
    return "8090";
  }

  function syncTorrServerRuntime(tsPortLike) {
    const port = normalizeTsPort(tsPortLike);
    const url = `http://localhost:${port}`;

    try {
      localStorage.setItem("torrserver_url", url);
      localStorage.setItem("torrserver_use_link", "one");
    } catch {
      // noop
    }

    if (window.Prisma && Prisma.Storage) {
      try {
        Prisma.Storage.set("torrserver_url", url);
        Prisma.Storage.set("torrserver_use_link", "one");
      } catch {
        // noop
      }
    }

    return port;
  }

  class SettingsManager {
    constructor(componentName) {
      this.queue = [];
      this.componentName = componentName;
    }

    addToQueue(paramConfig) {
      this.queue.push({
        ...paramConfig,
        order: paramConfig.order || this.queue.length + 1,
      });
      return this;
    }

    async loadAsyncSetting(key, paramConfig) {
      try {
        const value = await window.desktopAPI.store.get(key);
        localStorage.setItem(`${this.componentName}_${key}`, value);

        this.addToQueue({
          ...paramConfig,
          param: {
            ...paramConfig.param,
            default: value,
          },
        });
      } catch (error) {
        window.__ts_autostart_last = "exception: " + String(error);
        console.error(`APP Failed to load ${key}:`, error);
      }
    }

    apply() {
      this.queue.sort((a, b) => (a.order || 999) - (b.order || 999));

      this.queue.forEach((item) => {
        Prisma.SettingsApi.addParam({
          component: this.componentName,
          param: item.param,
          field: item.field,
          onChange: item.onChange,
        });
      });

      this.queue = [];
    }
  }

  function addAppSettings() {
    Prisma.Lang.add({
      // Основные настройки
      app_settings: {
        ru: "Настройки Десктоп",
        en: "Desktop Settings",
        uk: "Настройки Десктоп",
      },
      app_settings_fullscreen_field_name: {
        ru: "Запускать в полноэкранном режиме",
        en: "Launch in fullscreen mode",
        uk: "Запускати в повноекранному режимі",
      },
      app_settings_autoupdate_field_name: {
        ru: "Автообновление",
        en: "Auto-update",
        uk: "Автообновлення",
      },
      app_settings_prisma_url_placeholder: {
        ru: "Введите адрес Prisma, начиная с http...",
        en: "Enter Prisma URL starting with http...",
        uk: "Введіть адресу Prisma, починаючи з http...",
      },
      app_settings_prisma_url_name: {
        ru: "Адрес Prisma",
        en: "Prisma URL",
        uk: "Адреса Prisma",
      },
      app_settings_prisma_url_ok: {
        ru: "Сохранено, ожидайте перехода...",
        en: "Saved, waiting for redirect...",
        uk: "Збережено, очікуйте переходу...",
      },
      app_settings_prisma_url_error: {
        ru: "Неверный адрес",
        en: "Invalid URL",
        uk: "Невірний ",
      },
      app_settings_about_field_name: {
        ru: "О приложении",
        en: "About",
        uk: "Про додаток",
      },
      app_settings_about_field_description: {
        ru: "Версия и информация о приложении",
        en: "App version and info",
        uk: "Версія та інформація про додаток",
      },

      // TorrServer
      app_settings_ts_field_name: {
        ru: "Настройки встроенного TS",
        en: "Embedded TS settings",
        uk: "Налаштування вбудованого TS",
      },
      app_settings_ts_autostart_field_name: {
        ru: "Автозапуск TorrServer при старте",
        en: "Autostart on TorrServer launch",
        uk: "Автозапуск під час старту",
      },
      app_settings_ts_port_name: {
        ru: "Порт TS",
        en: "TS port",
        uk: "Порт TS",
      },
      app_settings_ts_port_description: {
        ru: "Если не знаете, зачем это нужно, оставьте 8090",
        en: "If you're not sure what this is for, leave it at 8090",
        uk: "Якщо не знаєте, для чого це потрібно, залиште 8090",
      },
      app_settings_ts_port_ok: {
        ru: "Сохранено. Перезапустите TorrServer",
        en: "Saved. Restart TorrServer",
        uk: "Збережено. Перезапустіть TorrServer",
      },
      app_settings_ts_status_name: {
        ru: "Статус",
        en: "Status",
        uk: "Статус",
      },
      app_settings_ts_version_name: {
        ru: "Версия",
        en: "Version",
        uk: "Версія",
      },
      app_settings_ts_autostart_debug_name: {
        ru: "Автостарт (debug)",
        en: "Autostart (debug)",
        uk: "Автостарт (debug)",
      },
      app_settings_ts_status_installed_running: {
        ru: "Запущен",
        en: "Running",
        uk: "Запущено",
      },
      app_settings_ts_status_installed_stopped: {
        ru: "Остановлен",
        en: "Stopped",
        uk: "Зупинено",
      },
      app_settings_ts_status_not_installed: {
        ru: "Не установлен",
        en: "Not installed",
        uk: "Не встановлено",
      },
      app_settings_ts_status_install_prompt: {
        ru: "Нажмите «Запуск», чтобы установить TorrServer",
        en: "Press Start to install TorrServer",
        uk: "Натисніть «Запуск», щоб встановити TorrServer",
      },

      // Кнопки управления TorrServer
      app_settings_ts_start_name: {
        ru: "Запустить",
        en: "Start",
        uk: "Запустити",
      },
      app_settings_ts_stop_name: {
        ru: "Остановить",
        en: "Stop",
        uk: "Зупинити",
      },
      app_settings_ts_restart_name: {
        ru: "Перезапустить",
        en: "Restart",
        uk: "Перезапустити",
      },
      app_settings_ts_check_update_name: {
        ru: "Проверить обновления",
        en: "Check for updates",
        uk: "Перевірити оновлення",
      },
      app_settings_ts_open_path_name: {
        ru: "Открыть папку TS",
        en: "Open TS folder",
        uk: "Відкрити папку TS",
      },
      app_settings_ts_open_web_name: {
        ru: "Открыть веб TorrServer",
        en: "Open TorrServer Web UI",
        uk: "Відкрити веб TorrServer",
      },
      app_settings_ts_uninstall_name: {
        ru: "Полностью удалить TorrServer",
        en: "Completely uninstall TorrServer",
        uk: "Повністю видалити TorrServer",
      },
      app_settings_ts_uninstall_keep_data_name: {
        ru: "Удалить TorrServer с сохранением данных",
        en: "Uninstall TorrServer and keep data",
        uk: "Видалити TorrServer зі збереженням даних",
      },

      // Статусы загрузки TorrServer
      app_settings_ts_start_loading: {
        ru: "Запуск TorrServer...",
        en: "Starting TorrServer...",
        uk: "Запуск TorrServer...",
      },
      app_settings_ts_download_loading: {
        ru: "Скачивание и запуск TorrServer...",
        en: "Downloading and starting TorrServer...",
        uk: "Завантаження та запуск TorrServer...",
      },
      app_settings_ts_stop_loading: {
        ru: "Остановка TorrServer...",
        en: "Stopping TorrServer...",
        uk: "Зупинка TorrServer...",
      },
      app_settings_ts_restart_loading: {
        ru: "Перезапуск TorrServer...",
        en: "Restarting TorrServer...",
        uk: "Перезапуск TorrServer...",
      },
      app_settings_ts_check_update_loading: {
        ru: "Проверка обновлений TorrServer...",
        en: "Checking TorrServer updates...",
        uk: "Перевірка оновлень TorrServer...",
      },
      app_settings_ts_update_loading: {
        ru: "Обновление TorrServer...",
        en: "Updating TorrServer...",
        uk: "Оновлення TorrServer...",
      },
      app_settings_ts_uninstall_loading: {
        ru: "Полное удаление TorrServer...",
        en: "Completely uninstalling TorrServer...",
        uk: "Повне видалення TorrServer...",
      },
      app_settings_ts_uninstall_keep_data_loading: {
        ru: "Удаление TorrServer...",
        en: "Uninstalling TorrServer...",
        uk: "Видалення TorrServer...",
      },
      app_settings_ts_install_prompt: {
        ru: "Сначала установите TorrServer, нажав «Запуск»",
        en: "First install TorrServer by pressing Start",
        uk: "Спочатку встановіть TorrServer, натиснувши «Запуск»",
      },

      // Обновления TorrServer
      app_settings_ts_update_found_title: {
        ru: "Найдено обновление TorrServer",
        en: "TorrServer update found",
        uk: "Знайдено оновлення TorrServer",
      },
      app_settings_ts_update_found_message: {
        ru: "Найдено обновление TorrServer.",
        en: "TorrServer update found.",
        uk: "Знайдено оновлення TorrServer.",
      },
      app_settings_ts_update_installed: {
        ru: "Установлена: {current_version}",
        en: "Installed: {current_version}",
        uk: "Встановлена: {current_version}",
      },
      app_settings_ts_update_latest: {
        ru: "Последняя версия: {latest_version}",
        en: "Latest version: {latest_version}",
        uk: "Остання версія: {latest_version}",
      },
      app_settings_ts_update_button: {
        ru: "Обновить",
        en: "Update",
        uk: "Оновити",
      },
      app_settings_ts_update_success: {
        ru: "Успешно обновлено",
        en: "Successfully updated",
        uk: "Успішно оновлено",
      },
      app_settings_ts_update_no_updates: {
        ru: "Обновлений нет, у вас последняя версия",
        en: "No updates, you have the latest version",
        uk: "Оновлень немає, у вас остання версія",
      },

      // Импорт/Экспорт
      app_settings_ie_field_name: {
        ru: "Экспорт/Импорт настроек",
        en: "Export/Import settings",
        uk: "Експорт/Імпорт налаштувань",
      },
      app_settings_ie_field_description: {
        ru: "Резервная копия данных",
        en: "Backup data or transfer from another application",
        uk: "Резервна копія даних або перенесення з іншого додатку",
      },
      app_settings_ie_btn_export_title: {
        ru: "Экспорт",
        en: "Export",
        uk: "Експорт",
      },
      app_settings_ie_btn_export_subtitle: {
        ru: "Сохранить настройки в файл",
        en: "Save settings to file",
        uk: "Зберегти налаштування у файл",
      },
      app_settings_ie_btn_import_title: {
        ru: "Импорт",
        en: "Import",
        uk: "Імпорт",
      },
      app_settings_ie_btn_import_subtitle: {
        ru: "Импортировать настройки из файла",
        en: "Import settings from file",
        uk: "Імпортувати налаштування з файлу",
      },
      app_settings_noty_waiting: {
        ru: "Ожидайте...",
        en: "Please wait...",
        uk: "Зачекайте...",
      },
      app_settings_ie_import_success: {
        ru: "Импорт выполнен успешно",
        en: "Import completed successfully",
        uk: "Імпорт виконано успішно",
      },
      app_settings_ie_import_error: {
        ru: "Ошибка импорта",
        en: "Import error",
        uk: "Помилка імпорту",
      },

      // Разделители
      app_settings_separator_main_name: {
        ru: "Основные",
        en: "Main",
        uk: "Основні",
      },
      app_settings_separator_other_name: {
        ru: "Остальные",
        en: "Other",
        uk: "Інші",
      },
      app_settings_ts_separator_main_title: {
        ru: "Управление",
        en: "Management",
        uk: "Керування",
      },
      app_settings_ts_separator_settings_title: {
        ru: "Настройки",
        en: "Settings",
        uk: "Налаштування",
      },
      app_settings_ts_separator_danger_title: {
        ru: "Остальное",
        en: "More",
        uk: "Інше",
      },

      app_settings_ie_separator_local_title: {
        ru: "Локально",
        en: "Local",
        uk: "Локально",
      },

      // Плееры
      app_settings_player_find: {
        ru: "Поиск плеера",
        en: "Player search",
        uk: "Пошук плеєра",
      },
      app_settings_player_find_description: {
        ru: "Автоматически найти VLC",
        en: "Auto-detect VLC",
        uk: "Автоматично знайти VLC",
      },

      // О приложении
      app_about_title: {
        ru: "Десктоп-клиент для Prisma.",
        en: "Client application for Prisma.",
        uk: "Додаток-клієнт для Prisma.",
      },
      app_about_version_app: {
        ru: "Версия приложения: {current_version}",
        en: "App version: {current_version}",
        uk: "Версія додатку: {current_version}",
      },
      app_about_version_latest: {
        ru: "Последняя версия: {latest_version}",
        en: "Latest version: {latest_version}",
        uk: "Остання версія: {latest_version}",
      },
      app_about_version_prisma: {
        ru: "Версия Prisma: {prisma_version}",
        en: "Prisma version: {prisma_version}",
        uk: "Версія Prisma: {prisma_version}",
      },
      app_about_github: {
        ru: "GitHub",
        en: "GitHub",
        uk: "GitHub",
      },
      app_about_loading: {
        ru: "Загружаю данные...",
        en: "Loading data...",
        uk: "Завантажую дані...",
      },

      // Горячие клавиши
      hotkey_search: {
        ru: "Поиск",
        en: "Search",
        uk: "Пошук",
      },
      hotkey_fullscreen: {
        ru: "Полноэкранный режим",
        en: "Fullscreen mode",
        uk: "Повноекранний режим",
      },
      hotkey_close: {
        ru: "Закрытие приложения",
        en: "Close application",
        uk: "Закриття додатку",
      },

      app_error: {
        ru: "Ошибка",
        en: "Error",
        uk: "Помилка",
      },
    });

    Prisma.SettingsApi.addComponent({
      component: "app_settings",
      name: Prisma.Lang.translate("app_settings"),
      icon: action_icon,
      after: "more",
    });

    Prisma.Template.add(
      "settings_app_settings_ts",
      '<div><div class="settings-param" data-static="true" data-name="app_settings_ts_tsStatus"><div class="settings-param__name">' +
        Prisma.Lang.translate("app_settings_ts_status_name") +
        '</div><div class="settings-param__descr">🔄</div></div>' +
        '<div><div class="settings-param" data-static="true" data-name="app_settings_ts_tsVersion"><div class="settings-param__name">' +
        Prisma.Lang.translate("app_settings_ts_version_name") +
        '</div><div class="settings-param__descr">🔄</div></div>' +
        '<div><div class="settings-param" data-static="true" data-name="app_settings_ts_tsAutoStartDebug"><div class="settings-param__name">' +
        Prisma.Lang.translate("app_settings_ts_autostart_debug_name") +
        '</div><div class="settings-param__descr">🔄</div></div>',
    );

    const settingsManager = new SettingsManager("app_settings");

    Prisma.SettingsApi.addParam({
      component: "player",
      param: {
        name: "player_find",
        type: "button",
      },
      field: {
        name: Prisma.Lang.translate("app_settings_player_find"),
        description: Prisma.Lang.translate(
          "app_settings_player_find_description",
        ),
      },
      onChange: async () => {
        Prisma.Loading.start(
          () => {},
          `${Prisma.Lang.translate("app_settings_player_find")}...`,
        );
        const result = await window.desktopAPI.findPlayer();
        Prisma.Loading.stop();
        // Prisma.Settings.create("player", {});
        Prisma.Settings.update();
        Prisma.Noty.show(
          result.success
            ? result.message
            : `${Prisma.Lang.translate("app_error")}: ${result.message}`,
        );
      },
      onRender: function (element) {
        setTimeout(function () {
          var anchor = $('div[data-name="player_nw_path"]');
          if (anchor.length) anchor.after(element);
        }, 0);
      },
    });

    Promise.all([
      settingsManager.loadAsyncSetting("fullscreen", {
        order: 3,
        param: {
          name: "app_settings_fullscreen",
          type: "trigger",
        },
        field: {
          name: Prisma.Lang.translate("app_settings_fullscreen_field_name"),
        },
        onChange: async function (value) {
          await window.desktopAPI.store.set("fullscreen", toBool(value));
        },
      }),

      settingsManager.loadAsyncSetting("autoUpdate", {
        order: 4,
        param: {
          name: "app_settings_autoUpdate",
          type: "trigger",
        },
        field: {
          name: Prisma.Lang.translate("app_settings_autoupdate_field_name"),
        },
        onChange: async function (value) {
          await window.desktopAPI.store.set("autoUpdate", toBool(value));
        },
      }),

      settingsManager.loadAsyncSetting("prismaUrl", {
        order: 5,
        param: {
          name: "app_settings_prismaUrl",
          type: "input",
          placeholder: Prisma.Lang.translate(
            "app_settings_prisma_url_placeholder",
          ),
          values: "",
        },
        field: {
          name: Prisma.Lang.translate("app_settings_prisma_url_name"),
        },
        onChange: async function (value) {
          if (URL.canParse(value)) {
            // Prisma.Settings.update();
            Prisma.Noty.show(Prisma.Lang.translate("app_settings_prisma_url_ok"));
            setTimeout(
              async () => await window.desktopAPI.store.set("prismaUrl", value),
              1000,
            );
          } else {
            Prisma.Noty.show(
              Prisma.Lang.translate("app_settings_prisma_url_error"),
            );
          }
        },
      }),
    ]).then(() => {
      settingsManager
        .addToQueue({
          order: 1,
          param: {
            name: "app_settings_about",
            type: "button",
          },
          field: {
            name: Prisma.Lang.translate("app_settings_about_field_name"),
            description: Prisma.Lang.translate(
              "app_settings_about_field_description",
            ),
          },
          onChange: function () {
            Prisma.Loading.start(
              () => {},
              Prisma.Lang.translate("app_about_loading"),
            );
            const network = new Prisma.Reguest();
            network.silent(
              "https://api.github.com/repos/Sheinices/prisma-desk/releases/latest",
              (data) => {
                window.desktopAPI
                  .getAppVersion()
                  .then((current_version) => {
                    const latest_version = data.tag_name.replace("v", "");

                    Prisma.Template.add(
                      "about_modal",
                      `<div class="app-modal-about">
                        ` +
                        Prisma.Lang.translate("app_about_title") +
                        `
                        <ul>
                            <li>` +
                        Prisma.Lang.translate("app_about_version_app").replace(
                          "{current_version}",
                          current_version,
                        ) +
                        `</li>
                            <li>` +
                        Prisma.Lang.translate(
                          "app_about_version_latest",
                        ).replace("{latest_version}", latest_version) +
                        `</li>
                            <li>` +
                        Prisma.Lang.translate("app_about_version_prisma").replace(
                          "{prisma_version}",
                          Prisma.Platform.version("app"),
                        ) +
                        `</li>
                        </ul>
                        <div class="simple-button selector github">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                            </svg>
                            <span>` +
                        Prisma.Lang.translate("app_about_github") +
                        `</span>
                        </div>
                      </div>`,
                    );

                    let about_html = Prisma.Template.get("about_modal", {});
                    about_html.find(".github").on("hover:enter", function () {
                      window.open(
                        "https://github.com/Sheinices/prisma-desk",
                        "_blank",
                      );
                    });

                    Prisma.Modal.open({
                      title: Prisma.Lang.translate(
                        "app_settings_about_field_name",
                      ),
                      html: about_html,
                      size: "small",
                      onBack: function () {
                        Prisma.Modal.close();
                        Prisma.Controller.toggle("settings_component");
                      },
                    });
                    Prisma.Loading.stop();
                    Prisma.Controller.toggle("modal");
                  })
                  .catch((error) => {
                    console.error(
                      "APP",
                      "Не удалось получить appVersion",
                      error,
                    );
                  });
              },
              () => {
                Prisma.Loading.stop();
              },
              null,
              {
                cache: { life: 10 },
              },
            );
          },
        })
        .addToQueue({
          order: 2,
          param: {
            name: "app_settings_separator_main",
            type: "title",
          },
          field: {
            name: Prisma.Lang.translate("app_settings_separator_main_name"),
          },
        })
        .addToQueue({
          component: "app_settings_player_find",
          order: 5.5,
          param: {
            name: "player_find",
            type: "button",
          },
          field: {
            name: Prisma.Lang.translate("app_settings_player_find"),
            description: Prisma.Lang.translate(
              "app_settings_player_find_description",
            ),
          },
          onChange: async () => {
            Prisma.Loading.start(
              () => {},
              `${Prisma.Lang.translate("app_settings_player_find")}...`,
            );
            const result = await window.desktopAPI.findPlayer();
            Prisma.Loading.stop();
            Prisma.Noty.show(
              result.success
                ? result.message
                : `${Prisma.Lang.translate("app_error")}: ${result.message}`,
            );
          },
        })
        .addToQueue({
          order: 6,
          param: {
            name: "app_settings_separator_main",
            type: "title",
          },
          field: {
            name: "TorrServer",
          },
        })
        .addToQueue({
          order: 7,
          param: {
            name: "app_settings_ts",
            type: "button",
          },
          field: {
            name: Prisma.Lang.translate("app_settings_ts_field_name"),
          },
          onChange: () => {
            Prisma.Settings.create("app_settings_ts", {
              onBack: () => Prisma.Settings.create("app_settings"),
            });
          },
        })
        .addToQueue({
          order: 8,
          param: {
            name: "app_settings_separator_other",
            type: "title",
          },
          field: {
            name: Prisma.Lang.translate("app_settings_separator_other_name"),
          },
        })
        .addToQueue({
          order: 9,
          param: {
            name: "app_settings_ie",
            type: "button",
          },
          field: {
            name: Prisma.Lang.translate("app_settings_ie_field_name"),
            description: Prisma.Lang.translate(
              "app_settings_ie_field_description",
            ),
          },
          onChange: () => {
            Prisma.Select.show({
              title: Prisma.Lang.translate("app_settings_ie_field_name"),
              items: [
                {
                  title: Prisma.Lang.translate(
                    "app_settings_ie_btn_export_title",
                  ),
                  subtitle: Prisma.Lang.translate(
                    "app_settings_ie_btn_export_subtitle",
                  ),
                  action: "e-file",
                },
                {
                  title: Prisma.Lang.translate(
                    "app_settings_ie_btn_import_title",
                  ),
                  subtitle: Prisma.Lang.translate(
                    "app_settings_ie_btn_import_subtitle",
                  ),
                  action: "i-file",
                },
              ],
              onSelect: async (a) => {
                Prisma.Noty.show(
                  Prisma.Lang.translate("app_settings_noty_waiting"),
                );

                try {
                  let result;

                  if (a.action === "e-file") {
                    result = await window.desktopAPI.exportSettingsToFile();
                    if (result && result.message) {
                      Prisma.Noty.show(result.message);
                    }
                  } else if (a.action === "i-file") {
                    result = await window.desktopAPI.importSettingsFromFile();
                    if (result && result.message) {
                      Prisma.Noty.show(result.message);
                    }
                  }
                } catch (error) {
                  Prisma.Noty.show(error.toString());
                }
              },
              onBack: () => {
                Prisma.Controller.toggle("settings_component");
              },
            });
          },
        })
        .apply();
    });

    const settingsTsManager = new SettingsManager("app_settings_ts");

    Promise.all([
      settingsTsManager.loadAsyncSetting("tsAutoStart", {
        order: 6,
        param: {
          name: "app_settings_ts_tsAutostart",
          type: "trigger",
        },
        field: {
          name: Prisma.Lang.translate("app_settings_ts_autostart_field_name"),
        },
        onChange: async function (value) {
          // Prisma.Settings.update();
          await window.desktopAPI.store.set("tsAutoStart", toBool(value));
        },
      }),
      settingsTsManager.loadAsyncSetting("tsPort", {
        order: 8,
        param: {
          name: "app_settings_ts_tsPort",
          type: "input",
          values: "",
        },
        field: {
          name: Prisma.Lang.translate("app_settings_ts_port_name"),
          description: Prisma.Lang.translate("app_settings_ts_port_description"),
        },
        onChange: async function (value) {
          // Prisma.Settings.update();
          Prisma.Noty.show(Prisma.Lang.translate("app_settings_ts_port_ok"));
          setTimeout(
            async () => await window.desktopAPI.store.set("tsPort", value),
            1000,
          );
        },
      }),
    ]).then(() => {
      settingsTsManager
        .addToQueue({
          order: 1,
          param: {
            name: "app_settings_ts_separator_main",
            type: "title",
          },
          field: {
            name: Prisma.Lang.translate("app_settings_ts_separator_main_title"),
          },
        })
        .addToQueue({
          component: "app_settings_ts",
          order: 2,
          param: {
            name: "ts_start",
            type: "button",
          },
          field: {
            name: Prisma.Lang.translate("app_settings_ts_start_name"),
          },
          onChange: async () => {
            const status = await window.desktopAPI.torrServer.getStatus();
            if (status && status.running) {
              Prisma.Noty.show("TorrServer уже запущен");
              return;
            }

            if (status.installed) {
              Prisma.Loading.start(
                () => {},
                Prisma.Lang.translate("app_settings_ts_start_loading"),
              );
            } else {
              Prisma.Loading.start(
                () => {},
                Prisma.Lang.translate("app_settings_ts_download_loading"),
              );
            }

            const tsPort = normalizeTsPort(await window.desktopAPI.store.get("tsPort"));
            const result = await window.desktopAPI.torrServer.start([]);
            if (result && result.success) syncTorrServerRuntime(tsPort);

            updateTsStatus();

            Prisma.Loading.stop();
            Prisma.Noty.show(
              result.success
                ? result.message
                : `${Prisma.Lang.translate("app_error")}: ${result.message}`,
            );
          },
        })
        .addToQueue({
          component: "app_settings_ts",
          order: 3,
          param: {
            name: "ts_stop",
            type: "button",
          },
          field: {
            name: Prisma.Lang.translate("app_settings_ts_stop_name"),
          },
          onChange: async () => {
            Prisma.Loading.start(
              () => {},
              Prisma.Lang.translate("app_settings_ts_stop_loading"),
            );
            const result = await window.desktopAPI.torrServer.stop();
            Prisma.Loading.stop();
            updateTsStatus();
            Prisma.Noty.show(
              result.success
                ? result.message
                : `${Prisma.Lang.translate("app_error")}: ${result.message}`,
            );
          },
        })
        .addToQueue({
          component: "app_settings_ts",
          order: 4,
          param: {
            name: "ts_restart",
            type: "button",
          },
          field: {
            name: Prisma.Lang.translate("app_settings_ts_restart_name"),
          },
          onChange: async () => {
            Prisma.Loading.start(
              () => {},
              Prisma.Lang.translate("app_settings_ts_restart_loading"),
            );

            const tsPort = normalizeTsPort(await window.desktopAPI.store.get("tsPort"));
            const result = await window.desktopAPI.torrServer.restart([]);
            if (result && result.success) syncTorrServerRuntime(tsPort);

            updateTsStatus();
            Prisma.Loading.stop();
            Prisma.Noty.show(
              result.success
                ? result.message
                : `${Prisma.Lang.translate("app_error")}: ${result.message}`,
            );
          },
        })
        .addToQueue({
          component: "app_settings_ts",
          order: 4.1,
          param: {
            name: "ts_check_update",
            type: "button",
          },
          field: {
            name: Prisma.Lang.translate("app_settings_ts_check_update_name"),
          },
          onChange: async () => {
            Prisma.Loading.start(
              () => {},
              Prisma.Lang.translate("app_settings_ts_check_update_loading"),
            );
            const result = await window.desktopAPI.torrServer.checkUpdate();
            // Создаем модальное окно если есть обновление
            if (result.hasUpdate) {
              Prisma.Template.add(
                "ts_update_modal",
                `<div class="app-modal-ts-update">
                        ` +
                  Prisma.Lang.translate("app_settings_ts_update_found_message") +
                  `
                        <ul>
                            <li>` +
                  Prisma.Lang.translate(
                    "app_settings_ts_update_installed",
                  ).replace("{current_version}", result.current) +
                  `</li>
                            <li>` +
                  Prisma.Lang.translate("app_settings_ts_update_latest").replace(
                    "{latest_version}",
                    result.latest,
                  ) +
                  `</li>
                        </ul>
                        <div class="simple-button selector ts_update">` +
                  Prisma.Lang.translate("app_settings_ts_update_button") +
                  `</div>
                      </div>`,
              );

              let ts_update_modal_html = Prisma.Template.get(
                "ts_update_modal",
                {},
              );
              ts_update_modal_html
                .find(".ts_update")
                .on("hover:enter", async function () {
                  Prisma.Loading.start(
                    () => {},
                    Prisma.Lang.translate("app_settings_ts_update_loading"),
                  );
                  const result = await window.desktopAPI.torrServer.update();
                  Prisma.Loading.stop();
                  Prisma.Modal.close();
                  Prisma.Controller.toggle("settings_component");
                  updateTsStatus();
                  Prisma.Noty.show(
                    result.success
                      ? Prisma.Lang.translate("app_settings_ts_update_success")
                      : `${Prisma.Lang.translate("app_error")}: ${result.message}`,
                  );
                });

              Prisma.Modal.open({
                title: Prisma.Lang.translate(
                  "app_settings_ts_update_found_title",
                ),
                html: ts_update_modal_html,
                size: "small",
                onBack: function () {
                  Prisma.Modal.close();
                  Prisma.Controller.toggle("settings_component");
                },
              });
              Prisma.Loading.stop();
              // И убеждаемся, что фокус на модальном окне
              Prisma.Controller.toggle("modal");
            } else {
              Prisma.Noty.show(
                Prisma.Lang.translate("app_settings_ts_update_no_updates"),
              );
              Prisma.Loading.stop();
            }
          },
        })
        .addToQueue({
          component: "app_settings_ts",
          order: 4.2,
          param: {
            name: "ts_open_path",
            type: "button",
          },
          field: {
            name: Prisma.Lang.translate("app_settings_ts_open_path_name"),
          },
          onChange: async () => {
            const status = await window.desktopAPI.torrServer.getStatus();

            if (status.installed) {
              await window.desktopAPI.folder.open(status.executableDir);
            } else {
              Prisma.Noty.show(
                Prisma.Lang.translate("app_settings_ts_install_prompt"),
              );
            }
          },
        })
        .addToQueue({
          component: "app_settings_ts",
          order: 4.3,
          param: {
            name: "ts_open_web",
            type: "button",
          },
          field: {
            name: Prisma.Lang.translate("app_settings_ts_open_web_name"),
          },
          onChange: async () => {
            const status = await window.desktopAPI.torrServer.getStatus();
            if (!status || !status.running) {
              Prisma.Noty.show("TorrServer не запущен");
              return;
            }

            if (status.installed) {
              const url = `http://${status.host}:${status.port}`;
              const result = await window.desktopAPI.external.open(url);
              if (result && result.success === false && result.message) {
                Prisma.Noty.show(result.message);
              }
            } else {
              Prisma.Noty.show(
                Prisma.Lang.translate("app_settings_ts_install_prompt"),
              );
            }
          },
        })
        .addToQueue({
          order: 5,
          param: {
            name: "app_settings_ts_separator_settings",
            type: "title",
          },
          field: {
            name: Prisma.Lang.translate(
              "app_settings_ts_separator_settings_title",
            ),
          },
        })
        .addToQueue({
          order: 9,
          param: {
            name: "app_settings_ts_separator_danger",
            type: "title",
          },
          field: {
            name: Prisma.Lang.translate(
              "app_settings_ts_separator_danger_title",
            ),
          },
        })
        .addToQueue({
          component: "app_settings_ts",
          order: 10,
          param: {
            name: "ts_uninstall",
            type: "button",
          },
          field: {
            name: Prisma.Lang.translate("app_settings_ts_uninstall_name"),
          },
          onChange: async () => {
            Prisma.Noty.show(
              Prisma.Lang.translate("app_settings_ts_uninstall_loading"),
            );
            const result = await window.desktopAPI.torrServer.uninstall();
            updateTsStatus();
            Prisma.Noty.show(
              result.success
                ? result.message
                : `${Prisma.Lang.translate("app_error")}: ${result.message}`,
            );
          },
        })
        .addToQueue({
          component: "app_settings_ts",
          order: 11,
          param: {
            name: "ts_uninstall_keep_data",
            type: "button",
          },
          field: {
            name: Prisma.Lang.translate(
              "app_settings_ts_uninstall_keep_data_name",
            ),
          },
          onChange: async () => {
            Prisma.Noty.show(
              Prisma.Lang.translate(
                "app_settings_ts_uninstall_keep_data_loading",
              ),
            );
            const result = await window.desktopAPI.torrServer.uninstall(true);
            updateTsStatus();
            Prisma.Noty.show(
              result.success
                ? result.message
                : `${Prisma.Lang.translate("app_error")}: ${result.message}`,
            );
          },
        })
        .apply();
    });

    let tsStatusPollTimer = null;

    function clearTsStatusPolling() {
      if (tsStatusPollTimer !== null) {
        clearInterval(tsStatusPollTimer);
        tsStatusPollTimer = null;
      }
    }

    function updateTsStatus() {
      Promise.all([
        window.desktopAPI.torrServer.getStatus(),
        window.desktopAPI.store.get("tsAutoStart").catch(() => null),
        window.desktopAPI.store.get("tsPort").catch(() => null),
      ])
        .then(([status, tsAutoStartStore, tsPortStore]) => {
          $('[data-name="app_settings_ts_tsVersion"]')
            .find(".settings-param__descr")
            .text(
              status.version !== null
                ? status.version
                : Prisma.Lang.translate("app_settings_ts_status_install_prompt"),
            );

          const statusText = status.installed
            ? status.running
              ? Prisma.Lang.translate("app_settings_ts_status_installed_running")
              : Prisma.Lang.translate("app_settings_ts_status_installed_stopped")
            : Prisma.Lang.translate("app_settings_ts_status_not_installed");

          const statusColor = status.installed
            ? status.running
              ? "#2ad164"
              : "#ff6b6b"
            : "#a1a1aa";

          $('[data-name="app_settings_ts_tsStatus"]')
            .find(".settings-param__descr")
            .text(statusText)
            .css({ color: statusColor, fontWeight: "700" });

          const localTsAutoStart = localStorage.getItem("tsAutoStart");
          const normalize = (value) => {
            if (typeof value === "boolean") return value;
            if (typeof value === "number") return value !== 0;
            if (typeof value === "string") {
              const v = value.trim().toLowerCase();
              return v === "1" || v === "true" || v === "yes" || v === "on";
            }
            return false;
          };

          const storeEnabled = normalize(tsAutoStartStore);
          const localEnabled = normalize(localTsAutoStart);
          const port = normalizeTsPort(tsPortStore);
          if (status && status.running) {
            syncTorrServerRuntime(port);
          }
          const last = window.__ts_autostart_last || "n/a";

          const debugText =
            "store=" + String(tsAutoStartStore) +
            " (" + (storeEnabled ? "ON" : "OFF") + ")" +
            ", local=" + String(localTsAutoStart) +
            " (" + (localEnabled ? "ON" : "OFF") + ")" +
            ", port=" + port +
            ", last=" + last;

          $('[data-name="app_settings_ts_tsAutoStartDebug"]')
            .find(".settings-param__descr")
            .text(debugText)
            .css({ color: "#c7c7c7", fontSize: "13px" });
        })
        .catch(() => {
          $('[data-name="app_settings_ts_tsStatus"]')
            .find(".settings-param__descr")
            .text(Prisma.Lang.translate("app_error"))
            .css({ color: "#ff6b6b", fontWeight: "700" });
        });
    }

    Prisma.Settings.listener.follow("open", function (e) {
      if (e.name === "app_settings_ts") {
        updateTsStatus();
        clearTsStatusPolling();
        tsStatusPollTimer = setInterval(updateTsStatus, 3000);
        return;
      }

      clearTsStatusPolling();
    });
  }

  /**
   * Класс для управления курсором и горячими клавишами
   */
  class InputManager {
    constructor(options = {}) {
      this.cursorVisible = true;
      this.mouseMoveTimer = null;
      this.debug = options.debug || false;

      this.keyHandlers = new Map();

      this.modifiers = {
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
      };

      this.cursorSettings = {
        hideOnKeyPress: options.hideOnKeyPress ?? true,
        showOnMouseMove: options.showOnMouseMove ?? true,
        hideCursorStyle: options.hideCursorStyle || "none",
        showCursorStyle: options.showCursorStyle || "default",
        mouseInactivityTimeout: options.mouseInactivityTimeout || 0,
      };

      this.ignoredSelectors = [
        "input",
        "textarea",
        '[contenteditable="true"]',
        "select",
        // "button",
        // "a",
      ];

      this.init();
    }

    init() {
      if (this.cursorSettings.hideOnKeyPress) {
        document.addEventListener("keydown", this.handleKeyDown.bind(this));
      }

      if (this.cursorSettings.showOnMouseMove) {
        document.addEventListener("mousemove", this.handleMouseMove.bind(this));
        document.addEventListener(
          "mousedown",
          this.handleMouseAction.bind(this),
        );
        document.addEventListener("mouseup", this.handleMouseAction.bind(this));
        document.addEventListener("wheel", this.handleMouseAction.bind(this));
      }

      document.addEventListener("keyup", this.handleKeyUp.bind(this));
      window.addEventListener("blur", this.handleWindowBlur.bind(this));

      this.log("InputManager инициализирован");
    }

    hideCursor() {
      if (!this.cursorSettings.hideOnKeyPress) return;

      if (this.cursorVisible) {
        document.body.style.cursor = this.cursorSettings.hideCursorStyle;
        this.cursorVisible = false;

        const style = document.createElement("style");
        style.id = "input-manager-cursor-style";
        style.textContent = `* { cursor: ${this.cursorSettings.hideCursorStyle} !important; }`;

        const oldStyle = document.getElementById("input-manager-cursor-style");
        if (oldStyle) oldStyle.remove();

        document.head.appendChild(style);
        this.log("Курсор скрыт");
      }
    }

    showCursor() {
      if (this.cursorVisible) return;

      document.body.style.cursor = this.cursorSettings.showCursorStyle;
      this.cursorVisible = true;

      const style = document.getElementById("input-manager-cursor-style");
      if (style) style.remove();

      this.log("Курсор показан");
    }

    toggleCursor() {
      if (this.cursorVisible) {
        this.hideCursor();
      } else {
        this.showCursor();
      }
    }

    updateCursorSettings(settings) {
      Object.assign(this.cursorSettings, settings);
      this.log("Настройки курсора обновлены");
    }

    /**
     * Проверяет, находится ли фокус в игнорируемом элементе
     */
    isIgnoredElement(element = document.activeElement) {
      if (!element) return false;

      for (const selector of this.ignoredSelectors) {
        if (element.matches && element.matches(selector)) {
          return true;
        }
      }

      // Проверяем, является ли элемент формой или частью формы
      return element.form !== undefined;
    }

    /**
     * Добавить селектор для игнорирования
     */
    addIgnoredSelector(selector) {
      if (!this.ignoredSelectors.includes(selector)) {
        this.ignoredSelectors.push(selector);
        this.log(`Добавлен игнорируемый селектор: ${selector}`);
      }
      return this;
    }

    /**
     * Удалить селектор из игнорируемых
     */
    removeIgnoredSelector(selector) {
      const index = this.ignoredSelectors.indexOf(selector);
      if (index !== -1) {
        this.ignoredSelectors.splice(index, 1);
        this.log(`Удален игнорируемый селектор: ${selector}`);
      }
      return this;
    }

    /**
     * Установить список игнорируемых селекторов
     */
    setIgnoredSelectors(selectors) {
      this.ignoredSelectors = [...selectors];
      this.log("Список игнорируемых селекторов обновлен");
      return this;
    }

    /**
     * Подписаться на нажатие клавиши
     * @param {string|string[]} key - клавиша или массив клавиш
     * @param {Function} handler - обработчик
     * @param {Object} options - опции
     * @param {boolean} options.ignoreIfInput - игнорировать если фокус в поле ввода (по умолчанию true)
     * @param {boolean} options.ignoreIfModal - игнорировать если открыто модальное окно
     * @param {Function} options.condition - дополнительное условие для выполнения
     */
    on(key, handler, options = {}) {
      if (Array.isArray(key)) {
        key.forEach((k) => this.on(k, handler, options));
        return this;
      }

      const keyId = key.toLowerCase();

      if (!this.keyHandlers.has(keyId)) {
        this.keyHandlers.set(keyId, []);
      }

      this.keyHandlers.get(keyId).push({
        handler,
        requireCtrl: options.ctrl || false,
        requireAlt: options.alt || false,
        requireShift: options.shift || false,
        requireMeta: options.meta || false,
        preventDefault: options.preventDefault || false,
        description: options.description || "",
        once: options.once || false,
        ignoreIfInput: options.ignoreIfInput !== false,
        ignoreIfModal: options.ignoreIfModal || false,
        condition: options.condition || null,
        ignoreSelectors: options.ignoreSelectors || [], // дополнительные селекторы для этого обработчика
      });

      this.log(`Добавлен обработчик для клавиши: ${keyId}`, options);
      return this;
    }

    /**
     * Подписаться на одноразовое нажатие
     */
    once(key, handler, options = {}) {
      return this.on(key, handler, { ...options, once: true });
    }

    /**
     * Отписаться от клавиши
     */
    off(key, handler) {
      const keyId = key.toLowerCase();

      if (this.keyHandlers.has(keyId)) {
        if (handler) {
          const handlers = this.keyHandlers.get(keyId);
          const index = handlers.findIndex((h) => h.handler === handler);
          if (index !== -1) {
            handlers.splice(index, 1);
            this.log(`Удален обработчик для клавиши: ${keyId}`);
          }
        } else {
          this.keyHandlers.delete(keyId);
          this.log(`Удалены все обработчики для клавиши: ${keyId}`);
        }
      }
      return this;
    }

    /**
     * Очистить все обработчики
     */
    clearAllHandlers() {
      this.keyHandlers.clear();
      this.log("Все обработчики удалены");
    }

    /**
     * Получить список всех зарегистрированных горячих клавиш
     */
    getRegisteredKeys() {
      const keys = [];
      for (const [keyId, handlers] of this.keyHandlers) {
        handlers.forEach((h) => {
          keys.push({
            key: keyId,
            modifiers: {
              ctrl: h.requireCtrl,
              alt: h.requireAlt,
              shift: h.requireShift,
              meta: h.requireMeta,
            },
            description: h.description,
            ignoreIfInput: h.ignoreIfInput,
            ignoreIfModal: h.ignoreIfModal,
          });
        });
      }
      return keys;
    }

    /**
     * Показать справку по горячим клавишам
     */
    showHelp() {
      console.log("=== Зарегистрированные горячие клавиши ===");
      const keys = this.getRegisteredKeys();
      if (keys.length === 0) {
        console.log("Нет зарегистрированных клавиш");
      } else {
        keys.forEach((k) => {
          const modifiers = [];
          if (k.modifiers.ctrl) modifiers.push("Ctrl");
          if (k.modifiers.alt) modifiers.push("Alt");
          if (k.modifiers.shift) modifiers.push("Shift");
          if (k.modifiers.meta) modifiers.push("Meta");

          const modifierStr =
            modifiers.length > 0 ? modifiers.join("+") + "+" : "";
          const flags = [];
          if (k.ignoreIfInput) flags.push("🚫 input");
          console.log(
            `  ${modifierStr}${k.key.toUpperCase()} - ${k.description || "нет описания"} ${flags.length ? `(${flags.join(", ")})` : ""}`,
          );
        });
      }
    }

    /**
     * Проверяет, можно ли выполнить обработчик
     */
    canExecuteHandler(item, event) {
      // Проверка на фокус в поле ввода
      if (item.ignoreIfInput) {
        const activeElement = document.activeElement;
        if (this.isIgnoredElement(activeElement)) {
          this.log(`Игнорируем: фокус в поле ввода (${activeElement.tagName})`);

          // Дополнительно проверяем игнорируемые селекторы для этого обработчика
          if (item.ignoreSelectors && item.ignoreSelectors.length > 0) {
            for (const selector of item.ignoreSelectors) {
              if (activeElement.matches && activeElement.matches(selector)) {
                return false;
              }
            }
          }

          return false;
        }
      }

      if (item.ignoreIfModal) {
        const modal = document.querySelector(
          '.modal[style*="display: block"], .modal.show, [role="dialog"][aria-hidden="false"]',
        );
        if (modal) {
          this.log("Игнорируем: открыто модальное окно");
          return false;
        }
      }

      if (item.condition && typeof item.condition === "function") {
        if (!item.condition(event)) {
          this.log("Игнорируем: не выполнено пользовательское условие");
          return false;
        }
      }

      return true;
    }

    handleKeyDown(event) {
      const code = event.code.toLowerCase();
      const key = event.key.toLowerCase();

      const ctrl = event.ctrlKey;
      const alt = event.altKey;
      const shift = event.shiftKey;
      const meta = event.metaKey;

      this.modifiers = { ctrl, alt, shift, meta };

      this.hideCursor();

      if (this.cursorSettings.mouseInactivityTimeout > 0) {
        clearTimeout(this.mouseMoveTimer);
      }

      let handlerExecuted = false;

      // Проверяем обработчики по CODE
      if (this.keyHandlers.has(code)) {
        handlerExecuted =
          this.executeHandlers(code, event, ctrl, alt, shift, meta) ||
          handlerExecuted;
      }

      // Проверяем обработчики по KEY
      if (this.keyHandlers.has(key) && code !== key) {
        handlerExecuted =
          this.executeHandlers(key, event, ctrl, alt, shift, meta) ||
          handlerExecuted;
      }

      this.log(
        `Нажата: code=${code}, key=${key}, выполнен=${handlerExecuted}, activeElement=${document.activeElement?.tagName}`,
      );
    }

    /**
     * Выполнить обработчики для указанного идентификатора клавиши
     */
    executeHandlers(keyId, event, ctrl, alt, shift, meta) {
      if (!this.keyHandlers.has(keyId)) return false;

      const handlers = this.keyHandlers.get(keyId);
      let executed = false;

      for (let i = 0; i < handlers.length; i++) {
        const item = handlers[i];

        if (
          item.requireCtrl === ctrl &&
          item.requireAlt === alt &&
          item.requireShift === shift &&
          item.requireMeta === meta
        ) {
          if (!this.canExecuteHandler(item, event)) {
            continue;
          }

          this.log(`Выполняется действие для: ${keyId}`, {
            modifiers: this.modifiers,
            ignoreIfInput: item.ignoreIfInput,
          });

          if (item.preventDefault) {
            event.preventDefault();
          }

          // Вызываем обработчик с расширенной информацией
          item.handler(event, {
            ...this.modifiers,
            code: event.code.toLowerCase(),
            key: event.key.toLowerCase(),
            activeElement: document.activeElement,
            isInInput: this.isIgnoredElement(document.activeElement),
          });

          executed = true;

          // Если одноразовый - удаляем
          if (item.once) {
            handlers.splice(i, 1);
            i--;
          }
        }
      }

      return executed;
    }

    handleKeyUp(event) {
      this.modifiers = {
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey,
      };
    }

    handleMouseMove() {
      this.showCursor();

      if (this.cursorSettings.mouseInactivityTimeout > 0) {
        clearTimeout(this.mouseMoveTimer);
        this.mouseMoveTimer = setTimeout(() => {
          this.hideCursor();
        }, this.cursorSettings.mouseInactivityTimeout);
      }
    }

    handleMouseAction() {
      this.showCursor();
    }

    handleWindowBlur() {
      this.showCursor();
      this.modifiers = { ctrl: false, alt: false, shift: false, meta: false };
    }

    log(message, data = null) {
      if (this.debug) {
        if (data) {
          console.log(`[InputManager] ${message}`, data);
        } else {
          console.log(`[InputManager] ${message}`);
        }
      }
    }

    /**
     * Очистка ресурсов
     */
    destroy() {
      document.removeEventListener("keydown", this.handleKeyDown);
      document.removeEventListener("keyup", this.handleKeyUp);
      document.removeEventListener("mousemove", this.handleMouseMove);
      document.removeEventListener("mousedown", this.handleMouseAction);
      document.removeEventListener("mouseup", this.handleMouseAction);
      document.removeEventListener("wheel", this.handleMouseAction);
      window.removeEventListener("blur", this.handleWindowBlur);

      clearTimeout(this.mouseMoveTimer);
      this.showCursor();
      this.keyHandlers.clear();

      this.log("InputManager уничтожен");
    }
  }

  function initInputManager() {
    const input = new InputManager({
      hideOnKeyPress: true,
      showOnMouseMove: true,
    });

    input
      .on(
        "keys",
        () => {
          Prisma.Search.open();
        },
        {
          description: Prisma.Lang.translate("hotkey_search"),
          condition: () => {
            return !document.body.classList.contains("search--open");
          },
        },
      )
      .on(
        "keyf",
        () => {
          Prisma.Utils.toggleFullscreen();
        },
        {
          description: Prisma.Lang.translate("hotkey_fullscreen"),
        },
      )
      .on(
        "f4",
        () => {
          window.desktopAPI.closeApp();
        },
        {
          description: Prisma.Lang.translate("hotkey_close"),
          alt: true,
          ignoreIfInput: false,
        },
      );
  }

  function removeMic() {
    function ensureInputFocus() {
      document
        .querySelectorAll(
          '.hg-button[data-skbtn="{MIC}"], .simple-keyboard-mic',
        )
        .forEach((el) => el.remove());
      const input = document.querySelector(".simple-keyboard-input");
      if (input && input !== document.activeElement) {
        input.focus();
      }
    }

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (
            node.nodeType === 1 &&
            (node.matches(".simple-keyboard") ||
              node.querySelector(".simple-keyboard"))
          ) {
            setTimeout(ensureInputFocus, 0);
          }
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    ensureInputFocus();
  }


  function bindHeadExitToDesktopClose() {
    const closeApp = () => window.desktopAPI.closeApp();

    const bind = () => {
      const exitButtons = document.querySelectorAll(".open--exit");
      if (!exitButtons.length) return;

      exitButtons.forEach((button) => {
        if (button.dataset.desktopExitBound === "1") return;

        const $button = $(button);
        $button.off("hover:enter");
        $button.on("hover:enter", closeApp);
        $button.on("click", (event) => {
          if (window.DeviceInput) {
            const nativeEvent = event?.originalEvent || event;
            if (!window.DeviceInput.canClick(nativeEvent)) return;
          }
          closeApp();
        });
        button.dataset.desktopExitBound = "1";
      });
    };

    bind();
    const observer = new MutationObserver(() => bind());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function syncAppSettingsFolderPlacement() {
    const apply = () => {
      const appFolder = document.querySelector('[data-component="app_settings"]');
      const moreFolder = document.querySelector('[data-component="more"]');
      if (!appFolder || !moreFolder) return;

      appFolder.classList.add("settings-folder--wide");

      if (appFolder.parentElement === moreFolder.parentElement && appFolder.previousElementSibling !== moreFolder) {
        moreFolder.insertAdjacentElement("afterend", appFolder);
      }
    };

    apply();

    const observer = new MutationObserver(() => apply());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function overwriteToggleFullscreen() {
    Prisma.Utils.toggleFullscreen = function () {
      window.desktopAPI.toggleFullscreen();
    };
  }

  function enforceDesktopPlatformCompatibility() {
    try {
      if (window.Prisma && Prisma.Platform && typeof Prisma.Platform.desktop === "function") {
        const originalDesktop = Prisma.Platform.desktop.bind(Prisma.Platform);
        Prisma.Platform.desktop = function () {
          const isDesktop = originalDesktop();
          const isMacOs = typeof Prisma.Platform.macOS === "function" ? Prisma.Platform.macOS() : false;
          return isDesktop || isMacOs;
        };
      }
    } catch (error) {
      console.warn("APP failed to enforce desktop platform", error);
    }
  }

  function patchExternalProtocolNavigation() {
    if (!window.desktopAPI || !window.desktopAPI.external) return;
    if (window.__desktop_protocol_patch_applied) return;

    const isExternalProtocol = (url) => {
      if (typeof url !== "string") return false;
      const normalized = url.trim();
      if (!/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return false;
      return !/^https?:/i.test(normalized);
    };

    const nativeOpen = window.desktopAPI.external.open;

    try {
      const locationProto = Object.getPrototypeOf(window.location);
      const originalAssign = locationProto && typeof locationProto.assign === "function"
        ? locationProto.assign
        : window.location.assign;

      if (typeof originalAssign === "function") {
        const wrappedAssign = function (url) {
          if (isExternalProtocol(url)) {
            nativeOpen(url);
            return;
          }
          return originalAssign.call(this, url);
        };

        if (locationProto && typeof locationProto.assign === "function") {
          locationProto.assign = wrappedAssign;
        } else {
          window.location.assign = wrappedAssign;
        }
      }
    } catch (error) {
      console.warn("APP failed to patch location.assign", error);
    }

    try {
      const originalOpen = window.open ? window.open.bind(window) : null;
      if (originalOpen) {
        window.open = function (url, target, features) {
          if (isExternalProtocol(url)) {
            nativeOpen(url);
            return null;
          }

          return originalOpen(url, target, features);
        };
      }
    } catch (error) {
      console.warn("APP failed to patch window.open", error);
    }

    window.__desktop_protocol_patch_applied = true;
  }

  function patchPlayerExternalLaunch() {
    if (!window.desktopAPI || !window.Prisma || !Prisma.Player || Prisma.Player.__desktopPatched) return;

    const resolvePlayerNeed = (data, mode) => {
      if (mode === "iptv") return "player_iptv";
      return data && data.torrent_hash ? "player_torrent" : "player";
    };

    const buildExternalUrl = (player, data) => {
      const safeUrl = String((data && data.url) || "").replace("&preload", "&play");
      if (!safeUrl) return null;

      const url = encodeURIComponent(safeUrl);
      const uri = encodeURI(safeUrl);

      const map = {
        mpv: "mpv://" + uri,
        iina: "iina://weblink?url=" + url,
        nplayer: "nplayer-" + uri,
        infuse: "infuse://x-callback-url/play?url=" + url,
        vlc: "vlc://" + safeUrl,
      };

      return map[player] || null;
    };

    const tryLaunch = async (data, mode) => {
      const needKey = resolvePlayerNeed(data, mode);
      const player = Prisma.Storage.field(needKey);
      if (!player) return false;

      const safeUrl = String((data && data.url) || "").replace("&preload", "&play");
      if (!safeUrl) return false;

      if (player === "other") {
        const path = Prisma.Storage.field("player_nw_path");
        if (!path) return false;

        try {
          const spawn = window.require("child_process").spawn;
          spawn(path, [encodeURI(safeUrl)]);
          return true;
        } catch (error) {
          console.warn("APP external other-player spawn failed", error);
          return false;
        }
      }

      const externalUrl = buildExternalUrl(player, data);
      if (!externalUrl) return false;

      try {
        await window.desktopAPI.external.open(externalUrl);
        return true;
      } catch (error) {
        console.warn("APP external player open failed", error);
        return false;
      }
    };

    const originalPlay = Prisma.Player.play.bind(Prisma.Player);
    Prisma.Player.play = function (data) {
      if (Prisma.Platform && typeof Prisma.Platform.macOS === "function" && Prisma.Platform.macOS()) {
        tryLaunch(data, "play").then((opened) => {
          if (!opened) originalPlay(data);
        });
        return;
      }

      return originalPlay(data);
    };

    const originalIptv = Prisma.Player.iptv ? Prisma.Player.iptv.bind(Prisma.Player) : null;
    if (originalIptv) {
      Prisma.Player.iptv = function (data) {
        if (Prisma.Platform && typeof Prisma.Platform.macOS === "function" && Prisma.Platform.macOS()) {
          tryLaunch(data, "iptv").then((opened) => {
            if (!opened) originalIptv(data);
          });
          return;
        }

        return originalIptv(data);
      };
    }

    Prisma.Player.__desktopPatched = true;
  }
  async function initTsAutoStart() {
    if (window.__ts_autostart_done) return;
    window.__ts_autostart_done = true;

    try {
      const normalizeBool = (value) => {
        if (typeof value === "boolean") return value;
        if (typeof value === "number") return value !== 0;
        if (typeof value === "string") {
          const v = value.trim().toLowerCase();
          return v === "1" || v === "true" || v === "yes" || v === "on";
        }
        return false;
      };

      let autoStart = false;
      try {
        autoStart = normalizeBool(await window.desktopAPI.store.get("tsAutoStart"));
      } catch {
        autoStart = false;
      }

      if (!autoStart) {
        const localTsAutoStart = localStorage.getItem("tsAutoStart");
        autoStart = normalizeBool(localTsAutoStart);
      }

      if (!autoStart) {
        window.__ts_autostart_last = "disabled";
        return;
      }

      const rawPort = await window.desktopAPI.store.get("tsPort");
      const tsPort = normalizeTsPort(rawPort);

      const status = await window.desktopAPI.torrServer.getStatus();
      if (status && status.running) {
        window.__ts_autostart_last = "already-running";
        syncTorrServerRuntime(tsPort);
        return;
      }

      const result = await window.desktopAPI.torrServer.start([]);
      if (result && result.success) {
        window.__ts_autostart_last = "started";
        syncTorrServerRuntime(tsPort);
      } else if (result && result.message) {
        window.__ts_autostart_last = "failed: " + result.message;
        console.warn("APP TorrServer autostart failed:", result.message);
      }
    } catch (error) {
      console.warn("APP TorrServer autostart exception:", error);
    }
  }
  function init() {
    enforceDesktopPlatformCompatibility(); // Совместимость веток desktop в Prisma
    patchExternalProtocolNavigation(); // Открытие iina://, infuse:// и др. через нативный opener
    patchPlayerExternalLaunch(); // Прямой запуск внешних плееров на macOS в Tauri
    initTsAutoStart(); // Надежный автозапуск TorrServer на старте клиента
    overwriteToggleFullscreen(); // Переопределение функции Utils.toggleFullscreen
    bindHeadExitToDesktopClose(); // Штатная кнопка выхода в шапке
    addAppSettings(); // Настройки приложения внутри Prisma
    syncAppSettingsFolderPlacement(); // Папка "Приложение" после "more" и в wide-стиле
    initInputManager();
    removeMic();
  }

  if (!window.plugin_app_ready) {
    window.plugin_app_ready = true;
    if (window.appready) {
      init();
    } else {
      Prisma.Listener.follow("app", function (e) {
        if (e.type === "ready") init();
      });
    }
  }
})();
