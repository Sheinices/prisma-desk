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
let history = [];

function setStatus(text, kind) {
  status.textContent = text || "";
  status.className = "setup__status" + (kind ? ` setup__status--${kind}` : "");
}

function renderHistory() {
  const box = document.querySelector("#history");
  const others = history.filter((item) => item !== input.value.trim());

  box.innerHTML = "";
  box.hidden = others.length === 0;

  others.forEach((item) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = item;
    chip.addEventListener("click", () => {
      input.value = item;
      setStatus("");
      renderHistory();
      input.focus();
    });
    box.appendChild(chip);
  });
}

function showForm(url, message, kind) {
  splash.hidden = true;
  form.hidden = false;
  input.value = url || defaultUrl;
  setStatus(message, kind);
  renderHistory();
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
  renderHistory();
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
  history = Array.isArray(state.history) ? state.history : [];
  const url = state.url || defaultUrl;

  if (!state.confirmed) {
    showForm(url, "");
    return;
  }

  // Сохранённый адрес, затем ранее рабочие зеркала — первое живое открываем сами.
  const candidates = [url, ...history.filter((item) => item !== url)];
  let lastMessage = "";

  for (const candidate of candidates) {
    splashText.textContent = `Проверяем ${candidate}…`;

    const result = await invoke("mirror_check", { url: candidate }).catch((error) => ({
      ok: false,
      message: String(error),
    }));

    if (!result.ok) {
      lastMessage = result.message || "Зеркало недоступно";
      continue;
    }

    try {
      await apply(candidate);
      return;
    } catch (error) {
      lastMessage = String(error);
    }
  }

  showForm(url, `${lastMessage}. Укажите другое зеркало.`, "err");
}

boot();
