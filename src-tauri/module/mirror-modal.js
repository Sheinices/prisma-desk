(function () {
  "use strict";

  if (window.__prismaMirror) return;

  const core = window.__TAURI__ && window.__TAURI__.core;
  if (!core) return;

  const invoke = core.invoke;

  // Оформление повторяет стартовый экран выбора зеркала (web/styles.css).
  const CSS = `
    .prisma-mirror-overlay {
      position: fixed; inset: 0; margin: 0;
      display: flex; align-items: center; justify-content: center;
      background: radial-gradient(circle at 50% 0%, rgba(35, 40, 56, 0.97) 0%, rgba(15, 17, 23, 0.97) 60%);
      color: #e7e9ee;
      font: 14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif;
    }
    .prisma-mirror-overlay * { box-sizing: border-box; }
    .prisma-mirror-card {
      width: min(460px, 88vw); padding: 28px; border-radius: 14px;
      background: rgba(27, 30, 38, 0.9);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
      text-align: center;
    }
    .prisma-mirror-card__title {
      margin: 0 0 18px; font-size: 22px; letter-spacing: 0.08em; text-transform: uppercase;
    }
    .prisma-mirror-card__hint { margin: 0 0 14px; font-size: 12px; opacity: 0.65; }
    .prisma-mirror-card input {
      width: 100%; height: 40px; padding: 0 12px;
      border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 8px;
      background: #12141a; color: #fff; font-size: 14px; outline: none; text-align: center;
      -webkit-user-select: text; user-select: text;
    }
    .prisma-mirror-card input:focus { border-color: #4f7cff; }
    .prisma-mirror-card__status { min-height: 18px; margin: 10px 0 0; font-size: 12px; opacity: 0.8; }
    .prisma-mirror-card__status--ok { color: #4ad07f; opacity: 1; }
    .prisma-mirror-card__status--err { color: #ff6b6b; opacity: 1; }
    .prisma-mirror-card__row { display: flex; gap: 8px; margin-top: 14px; }
    .prisma-mirror-card__row button {
      flex: 1; height: 38px; border: 0; border-radius: 8px; cursor: pointer; font-size: 13px;
    }
    .prisma-mirror-card__row button[disabled] { opacity: 0.5; cursor: default; }
    .prisma-btn--primary { background: #4f7cff; color: #fff; }
    .prisma-btn--ghost { background: rgba(255, 255, 255, 0.1); color: #e7e9ee; }
    .prisma-mirror-card__cancel {
      margin-top: 12px; border: 0; background: transparent;
      color: rgba(231, 233, 238, 0.55); font-size: 12px; text-decoration: underline; cursor: pointer;
    }
    .prisma-mirror-card__cancel[disabled] { opacity: 0.4; cursor: default; }
  `;

  const MARKUP = `
    <div class="prisma-mirror-card">
      <h1 class="prisma-mirror-card__title">Prisma</h1>
      <p class="prisma-mirror-card__hint">
        Укажите адрес зеркала Prisma. Он сохранится и будет открываться при запуске.
      </p>
      <input type="text" spellcheck="false" autocomplete="off" placeholder="http://prisma.ws" />
      <p class="prisma-mirror-card__status"></p>
      <div class="prisma-mirror-card__row">
        <button class="prisma-btn--primary" data-act="apply">Проверить и перейти</button>
        <button class="prisma-btn--ghost" data-act="reset">По умолчанию</button>
      </div>
      <button class="prisma-mirror-card__cancel" data-act="cancel">Отмена</button>
    </div>
  `;

  let host = null; // iframe или div, смонтированный в страницу
  let keyGuards = [];

  function removeKeyGuards() {
    keyGuards.splice(0).forEach((off) => off());
  }

  // Запасной вариант (если iframe заблокирован CSP): не даём обработчикам
  // страницы увидеть клавиатурные события, адресованные модали.
  function installKeyGuards(root) {
    ["keydown", "keypress", "keyup", "input"].forEach((type) => {
      const handler = (event) => {
        if (root.contains(event.target)) event.stopPropagation();
      };

      [window, document].forEach((target) => {
        target.addEventListener(type, handler, true);
        keyGuards.push(() => target.removeEventListener(type, handler, true));
      });
    });
  }

  function wire(doc, root, state) {
    const input = root.querySelector("input");
    const status = root.querySelector(".prisma-mirror-card__status");
    const buttons = root.querySelectorAll("button");
    input.value = (state && state.url) || "";

    function setStatus(text, kind) {
      status.textContent = text;
      status.className =
        "prisma-mirror-card__status" +
        (kind ? ` prisma-mirror-card__status--${kind}` : "");
    }

    function busy(disabled) {
      buttons.forEach((button) => {
        button.disabled = disabled;
      });
    }

    async function check() {
      const url = input.value.trim();
      if (!url) {
        setStatus("Введите адрес", "err");
        return null;
      }

      busy(true);
      setStatus("Проверяем доступность…");
      const result = await invoke("mirror_check", { url }).catch((e) => ({
        ok: false,
        message: String(e),
      }));
      busy(false);

      setStatus(result.message || (result.ok ? "Доступно" : "Недоступно"), result.ok ? "ok" : "err");
      return result;
    }

    async function apply() {
      const result = await check();
      if (!result || !result.ok) return;

      busy(true);
      setStatus("Переходим на зеркало…", "ok");
      await invoke("mirror_apply", { url: input.value.trim() }).catch((e) => {
        busy(false);
        setStatus(String(e), "err");
      });
    }

    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-act]");

      if (!button) {
        if (event.target === root) close();
        return;
      }

      if (button.dataset.act === "cancel") {
        close();
      } else if (button.dataset.act === "reset") {
        input.value = (state && state.default) || "http://prisma.ws";
        setStatus("");
        input.focus();
      } else if (button.dataset.act === "apply") {
        apply();
      }
    });

    root.addEventListener("keydown", (event) => {
      // Внутри модали клавиши обрабатываем сами: страница их не увидит.
      event.stopPropagation();
      if (event.key === "Escape") close();
      if (event.key === "Enter" && event.target === input) apply();
    });

    doc.defaultView.focus();
    input.focus();
    input.select();
  }

  function buildOverlay(doc) {
    const overlay = doc.createElement("div");
    overlay.className = "prisma-mirror-overlay";
    overlay.innerHTML = MARKUP;
    return overlay;
  }

  function addStyle(doc) {
    const style = doc.createElement("style");
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  // Основной путь: модаль живёт в отдельном документе (iframe), поэтому
  // клавиатурные обработчики Prisma до неё не достают вообще.
  function openInFrame(state) {
    return new Promise((resolve) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("srcdoc", "<!doctype html><html><head></head><body></body></html>");
      frame.style.cssText =
        "position:fixed;inset:0;width:100%;height:100%;border:0;margin:0;z-index:2147483100;background:transparent;color-scheme:dark;";

      let settled = false;
      let wired = false;

      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      frame.addEventListener("load", () => {
        const doc = frame.contentDocument;
        if (!doc || !doc.body) {
          finish(false);
          return;
        }

        doc.documentElement.style.height = "100%";
        doc.body.style.cssText = "margin:0;height:100%;";
        addStyle(doc);

        const overlay = buildOverlay(doc);
        doc.body.appendChild(overlay);
        wire(doc, overlay, state);
        wired = true;
        finish(true);
      });

      frame.addEventListener("error", () => finish(false));

      host = frame;
      document.body.appendChild(frame);
      setTimeout(() => finish(wired), 1200);
    });
  }

  function openInline(state) {
    addStyle(document);
    const overlay = buildOverlay(document);
    overlay.style.zIndex = "2147483100";
    host = overlay;
    document.body.appendChild(overlay);
    installKeyGuards(overlay);
    wire(document, overlay, state);
  }

  async function open() {
    if (host) return;

    const state = await invoke("mirror_state").catch(() => ({ url: "" }));

    const framed = await openInFrame(state);
    if (framed) return;

    close();
    openInline(state);
  }

  function close() {
    removeKeyGuards();
    if (!host) return;
    host.remove();
    host = null;
  }

  window.__prismaMirror = { open, close };
})();
