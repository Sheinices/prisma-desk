const { invoke } = window.__TAURI__.core;

const splash = document.querySelector("#splash");
const splashText = document.querySelector("#splash-text");
const form = document.querySelector("#form");
const input = document.querySelector("#url-input");
const status = document.querySelector("#status");
const continueButton = document.querySelector("#continue");
const resetButton = document.querySelector("#reset");
const skipButton = document.querySelector("#skip");

let defaultUrl = "http://prisma.ws";

function setStatus(text, kind) {
  status.textContent = text || "";
  status.className = "setup__status" + (kind ? ` setup__status--${kind}` : "");
}

function showForm(url, message, kind) {
  splash.hidden = true;
  form.hidden = false;
  input.value = url || defaultUrl;
  setStatus(message, kind);
  input.focus();
  input.select();
}

function busy(state) {
  [continueButton, resetButton, skipButton].forEach((button) => {
    button.disabled = state;
  });
}

async function apply(url) {
  // mirror_apply сохраняет адрес и уводит окно на зеркало.
  await invoke("mirror_apply", { url });
}

async function checkAndContinue() {
  const url = input.value.trim();
  if (!url) {
    setStatus("Введите адрес зеркала", "err");
    return;
  }

  busy(true);
  setStatus("Проверяем доступность…");

  const result = await invoke("mirror_check", { url }).catch((error) => ({
    ok: false,
    message: String(error),
  }));

  if (!result.ok) {
    busy(false);
    setStatus(result.message || "Зеркало недоступно", "err");
    return;
  }

  setStatus(result.message, "ok");
  try {
    await apply(url);
  } catch (error) {
    busy(false);
    setStatus(String(error), "err");
  }
}

continueButton.addEventListener("click", checkAndContinue);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") checkAndContinue();
});

resetButton.addEventListener("click", () => {
  input.value = defaultUrl;
  setStatus("");
  input.focus();
});

skipButton.addEventListener("click", async () => {
  const url = input.value.trim() || defaultUrl;
  busy(true);
  try {
    await apply(url);
  } catch (error) {
    busy(false);
    setStatus(String(error), "err");
  }
});

async function boot() {
  const state = await invoke("mirror_state").catch(() => null);

  if (!state) {
    showForm(defaultUrl, "Не удалось прочитать настройки", "err");
    return;
  }

  defaultUrl = state.default || defaultUrl;
  const url = state.url || defaultUrl;

  if (!state.confirmed) {
    showForm(url, "");
    return;
  }

  splashText.textContent = `Проверяем ${url}…`;

  const result = await invoke("mirror_check", { url }).catch((error) => ({
    ok: false,
    message: String(error),
  }));

  if (result.ok) {
    try {
      await apply(url);
      return;
    } catch (error) {
      showForm(url, String(error), "err");
      return;
    }
  }

  showForm(url, `${result.message}. Укажите другое зеркало.`, "err");
}

boot();
