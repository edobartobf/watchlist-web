import { decryptVault } from "./vault.js";
import { GitHubStore, Tmdb, IMG, pickProviders, DEFAULT_RULES, rankResults } from "./api.js";
import { DemoStore, DemoTmdb } from "./demo.js";

// App installabile (Android: "Installa" nell'header o dal menu di Chrome).
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
let installPrompt = null;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  document.querySelector("#btn-install").hidden = false;
});
addEventListener("appinstalled", () => {
  installPrompt = null;
  document.querySelector("#btn-install").hidden = true;
});
document.querySelector("#btn-install").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  document.querySelector("#btn-install").hidden = true;
});

// config.js si carica qui e non con un tag <script>: GitHub Pages fa tenere i file
// in cache fino a 10 minuti, e dopo aver rigenerato i token servirebbe Ctrl+Shift+R.
async function loadConfig() {
  await new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = `config.js?t=${Date.now()}`;
    s.onload = s.onerror = resolve;
    document.head.append(s);
  });
  return window.WATCHLIST_CONFIG || {};
}
const cfg = await loadConfig();
const SECRETS_KEY = "watchlist.secrets";
const USER_KEY = "watchlist.user";
const DEMO = new URLSearchParams(location.search).has("demo");

const $ = (s) => document.querySelector(s);
const state = { db: null, userId: null, filter: "all", info: new Map(), busy: false, selecting: false, selected: new Set() };
let store, tmdb;

// ---------- utilità ----------

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c);
  return n;
}

const fmtDate = (iso) => (iso ? new Date(iso + "T12:00:00").toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" }) : "");
const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD locale
const yearOf = (d) => (d ? Number(String(d).slice(0, 4)) || null : null);

let toastTimer;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), isErr ? 6000 : 3500);
}

function poster(path, title, size = "w185", cls = "poster") {
  if (path) return el("img", { class: cls, src: IMG + size + path, alt: "", loading: "lazy" });
  const initials = (title || "?").replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return el("div", { class: cls, "aria-hidden": "true" }, initials || "?");
}

function slug(name) {
  const base = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "utente";
  return base;
}

function confirmDialog(title, text, okLabel = "Conferma") {
  const dlg = $("#dlg-confirm");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = okLabel;
  dlg.showModal();
  return new Promise((resolve) => {
    const ok = () => { cleanup(); dlg.close(); resolve(true); };
    const close = () => { cleanup(); resolve(false); };
    const cleanup = () => { $("#confirm-ok").removeEventListener("click", ok); dlg.removeEventListener("close", close); };
    $("#confirm-ok").addEventListener("click", ok);
    dlg.addEventListener("close", close);
  });
}

// ---------- accesso ----------

function readSecrets() {
  try {
    const s = sessionStorage.getItem(SECRETS_KEY) || localStorage.getItem(SECRETS_KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function writeSecrets(secrets, remember) {
  try {
    (remember ? localStorage : sessionStorage).setItem(SECRETS_KEY, JSON.stringify(secrets));
  } catch {}
}

function logout() {
  try {
    sessionStorage.removeItem(SECRETS_KEY);
    localStorage.removeItem(SECRETS_KEY);
  } catch {}
  location.href = location.pathname;
}

function showLogin(message) {
  $("#app").hidden = true;
  $("#login").hidden = false;
  const err = $("#login-error");
  if (!cfg.vault) {
    err.textContent = "Configurazione mancante: genera config.js con setup.html.";
    err.hidden = false;
    $("#login-btn").disabled = true;
    return;
  }
  err.hidden = !message;
  err.textContent = message || "";
  $("#login-pw").focus();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#login-btn");
  const err = $("#login-error");
  btn.disabled = true;
  btn.textContent = "Verifico…";
  err.hidden = true;
  try {
    const secrets = await decryptVault(cfg.vault, $("#login-pw").value);
    writeSecrets(secrets, $("#login-remember").checked);
    await start(secrets);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    $("#login-pw").select();
  } finally {
    btn.disabled = false;
    btn.textContent = "Entra";
  }
});

// ---------- dati ----------

function currentUser() {
  return state.db?.users.find((u) => u.id === state.userId) || null;
}

async function reload() {
  state.db = await store.load();
  if (!currentUser()) state.userId = state.db.users[0]?.id || null;
  render();
}

// Applica una modifica e la salva; se nel frattempo qualcun altro ha salvato
// (conflitto di sha), ricarica e riapplica la modifica.
async function mutate(change, message) {
  if (state.busy) throw new Error("Attendi il salvataggio in corso");
  state.busy = true;
  try {
    for (let attempt = 0; ; attempt++) {
      const db = attempt === 0 ? structuredClone(state.db) : await store.load();
      change(db);
      try {
        await store.save(db, message);
        state.db = db;
        render();
        return;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 3) continue;
        throw e;
      }
    }
  } finally {
    state.busy = false;
  }
}

function handleError(e) {
  console.error(e);
  if (e.status === 401) return logout();
  toast(e.message || "Qualcosa è andato storto", true);
}

// Regole sulle piattaforme: quelle in db.json, altrimenti i default.
function rules() {
  return { ...DEFAULT_RULES, ...(state.db?.settings?.providers || {}) };
}

// Dettagli + disponibilità da TMDB, in cache per la sessione.
function info(id) {
  if (!state.info.has(id)) {
    const p = tmdb.details(id).then((d) => ({
      poster_path: d.poster_path,
      original_title: d.original_title,
      providers: pickProviders(d["watch/providers"]?.results, rules()),
    }));
    p.catch(() => state.info.delete(id));
    state.info.set(id, p);
  }
  return state.info.get(id);
}

// ---------- rendering ----------

function render() {
  renderTabs();
  renderList();
}

function renderTabs() {
  const nav = $("#user-tabs");
  nav.replaceChildren(
    ...state.db.users.map((u) =>
      el("button", {
        class: "tab", role: "tab", "aria-selected": String(u.id === state.userId),
        onclick: () => selectUser(u.id),
      }, u.name, el("span", { class: "n" }, String(u.movies.length))),
    ),
    el("button", { class: "tab add", onclick: openUsers, title: "Aggiungi o elimina utenti" }, "+ Utente"),
  );
}

function selectUser(id) {
  if (id !== state.userId) stopSelecting();
  state.userId = id;
  try { localStorage.setItem(USER_KEY, id); } catch {}
  render();
}

function isAvailable(m) {
  const cached = state.info.get(m.tmdb_id);
  return Boolean(m.notified) || Boolean(cached?.resolved?.providers.wanted.length);
}

function visibleMovies(user) {
  return [...user.movies]
    .sort((a, b) => (b.added_date || "").localeCompare(a.added_date || ""))
    .filter((m) => state.filter === "all" || (state.filter === "available") === isAvailable(m));
}

function renderList() {
  const user = currentUser();
  const grid = $("#movies");
  const empty = $("#empty");
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.filter === state.filter)));

  if (!user) {
    $("#list-title").textContent = "Nessun utente";
    grid.replaceChildren();
    $("#btn-select").hidden = true;
    empty.hidden = false;
    empty.replaceChildren(el("strong", {}, "Crea il primo utente"), "Ogni utente ha la sua watchlist.", el("div", { style: "margin-top:14px" }, el("button", { class: "btn primary", onclick: openUsers }, "Crea utente")));
    $("#q").disabled = true;
    renderSelectBar();
    return;
  }
  $("#q").disabled = false;
  $("#q").placeholder = `Aggiungi un film per ${user.name}…`;
  $("#list-title").textContent = `La lista di ${user.name}`;
  $("#btn-select").hidden = user.movies.length === 0;
  $("#btn-select").textContent = state.selecting ? "Fine" : "Seleziona";

  // la selezione tiene solo film che esistono ancora
  for (const id of state.selected) if (!user.movies.some((m) => m.tmdb_id === id)) state.selected.delete(id);

  const movies = visibleMovies(user);
  grid.classList.toggle("selecting", state.selecting);
  grid.replaceChildren(...movies.map((m) => card(user, m)));
  empty.hidden = movies.length > 0;
  if (!movies.length) {
    empty.replaceChildren(
      ...(user.movies.length
        ? [el("strong", {}, "Niente qui"), "Nessun film corrisponde al filtro."]
        : [el("strong", {}, "La lista è vuota"), "Cerca un film qui sopra: ti avviso via mail quando arriva in streaming."]),
    );
  }
  renderSelectBar();
}

function card(user, m) {
  const pos = el("div", {}, poster(m.poster_path, m.title));
  const status = el("div", { class: "status" }, el("span", { class: "skeleton" }));
  const tmdbUrl = `https://www.themoviedb.org/movie/${m.tmdb_id}`;
  const sub = [m.year, m.original_title && m.original_title !== m.title ? m.original_title : null].filter(Boolean).join(" · ");
  const selected = state.selected.has(m.tmdb_id);

  const node = el("article", {
      class: "card" + (selected ? " selected" : ""),
      ...(state.selecting ? { role: "checkbox", "aria-checked": String(selected), tabindex: "0" } : {}),
    },
    state.selecting ? el("span", { class: "tick", "aria-hidden": "true" }) : null,
    pos,
    el("div", { class: "card-main" },
      el("div", { class: "card-top" },
        el("div", { class: "card-title" }, state.selecting ? m.title : el("a", { href: tmdbUrl, target: "_blank", rel: "noopener" }, m.title)),
        state.selecting ? null : el("button", { class: "icon-btn", title: "Togli dalla lista", "aria-label": `Togli ${m.title} dalla lista`, onclick: () => removeMovie(user, m) }, "🗑"),
      ),
      sub ? el("div", { class: "card-sub" }, sub) : null,
      el("div", { class: "card-sub" }, `Aggiunto il ${fmtDate(m.added_date)}`),
      status,
    ),
  );
  if (state.selecting) {
    const toggle = () => {
      if (state.selected.has(m.tmdb_id)) state.selected.delete(m.tmdb_id);
      else state.selected.add(m.tmdb_id);
      const on = state.selected.has(m.tmdb_id);
      node.classList.toggle("selected", on);
      node.setAttribute("aria-checked", String(on));
      renderSelectBar();
    };
    node.addEventListener("click", toggle);
    node.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); } });
  }

  info(m.tmdb_id)
    .then((i) => {
      state.info.get(m.tmdb_id).resolved = i;
      if (!m.poster_path && i.poster_path) pos.replaceChildren(poster(i.poster_path, m.title));
      status.replaceChildren(...statusBits(m, i.providers));
    })
    .catch(() => status.replaceChildren(...statusBits(m, null)));
  return node;
}

function providerChips(list) {
  return el("span", { class: "prov-list" }, list.map((p) =>
    el("span", { class: "prov", title: p.type === "free" ? "Gratis" : "Abbonamento" },
      p.logo ? el("img", { src: IMG + "w45" + p.logo, alt: "" }) : null, p.name)));
}

function statusBits(m, prov) {
  if (prov?.wanted.length) {
    return [el("span", { class: "badge ok" }, "In streaming"), providerChips(prov.wanted)];
  }
  if (m.notified) {
    return [el("span", { class: "badge ok", title: `Notificato il ${fmtDate(m.notified.date)}` }, `Era su ${m.notified.providers.join(", ")}`)];
  }
  const bits = [el("span", { class: "badge wait" }, "In attesa")];
  if (prov?.watchOnly.length) bits.push(el("span", { class: "badge sky", title: "Lo segnalo, ma aspetto una delle altre piattaforme" }, "C'è su"), providerChips(prov.watchOnly));
  else if (!prov && m.watch_only) bits.push(el("span", { class: "badge sky" }, `C'era su ${m.watch_only.providers.join(", ")}`));
  if (prov?.other.length) bits.push(el("span", { class: "card-sub note" }, `anche su ${prov.other.map((p) => p.name).join(", ")} (non conta)`));
  else if (prov?.rentOrBuy && !prov.watchOnly.length) bits.push(el("span", { class: "card-sub note" }, "per ora solo noleggio/acquisto"));
  return bits;
}

// ---------- selezione multipla ----------

function startSelecting() {
  state.selecting = true;
  state.selected.clear();
  renderList();
}

function stopSelecting() {
  state.selecting = false;
  state.selected.clear();
}

function renderSelectBar() {
  const bar = $("#select-bar");
  bar.hidden = !state.selecting;
  if (!state.selecting) return;
  const n = state.selected.size;
  const user = currentUser();
  const visible = user ? visibleMovies(user) : [];
  const allOn = visible.length > 0 && visible.every((m) => state.selected.has(m.tmdb_id));
  $("#select-count").textContent = n === 0 ? "Tocca i film da togliere" : n === 1 ? "1 selezionato" : `${n} selezionati`;
  $("#select-all").textContent = allOn ? "Nessuno" : "Tutti";
  $("#select-del").disabled = n === 0;
  $("#select-del").textContent = n ? `Togli ${n}` : "Togli";
}

$("#btn-select").addEventListener("click", () => {
  if (state.selecting) { stopSelecting(); renderList(); } else startSelecting();
});
$("#select-cancel").addEventListener("click", () => { stopSelecting(); renderList(); });
$("#select-all").addEventListener("click", () => {
  const visible = visibleMovies(currentUser());
  const allOn = visible.every((m) => state.selected.has(m.tmdb_id));
  for (const m of visible) allOn ? state.selected.delete(m.tmdb_id) : state.selected.add(m.tmdb_id);
  renderList();
});
$("#select-del").addEventListener("click", async () => {
  const user = currentUser();
  const ids = new Set(state.selected);
  const titles = user.movies.filter((m) => ids.has(m.tmdb_id)).map((m) => m.title);
  if (!titles.length) return;
  const preview = titles.slice(0, 5).map((t) => `«${t}»`).join(", ") + (titles.length > 5 ? ` e altri ${titles.length - 5}` : "");
  const ok = await confirmDialog(`Togliere ${titles.length === 1 ? "1 film" : `${titles.length} film`}?`, `${preview} escono dalla lista di ${user.name}.`, "Togli");
  if (!ok) return;
  try {
    await mutate((db) => {
      const u = db.users.find((x) => x.id === user.id);
      if (u) u.movies = u.movies.filter((x) => !ids.has(x.tmdb_id));
    }, titles.length === 1 ? `web: ${user.name} toglie "${titles[0]}"` : `web: ${user.name} toglie ${titles.length} film`);
    stopSelecting();
    renderList();
    toast(titles.length === 1 ? `«${titles[0]}» tolto dalla lista` : `${titles.length} film tolti dalla lista`);
  } catch (e) {
    handleError(e);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.selecting && !document.querySelector("dialog[open]")) { stopSelecting(); renderList(); }
});

// ---------- azioni ----------

async function removeMovie(user, m) {
  const ok = await confirmDialog("Togliere il film?", `«${m.title}» esce dalla lista di ${user.name}.`, "Togli");
  if (!ok) return;
  try {
    await mutate((db) => {
      const u = db.users.find((x) => x.id === user.id);
      if (u) u.movies = u.movies.filter((x) => x.tmdb_id !== m.tmdb_id);
    }, `web: ${user.name} toglie "${m.title}"`);
    toast(`«${m.title}» tolto dalla lista`);
  } catch (e) {
    handleError(e);
  }
}

async function addMovie(user, d, prov) {
  const entry = {
    tmdb_id: d.id,
    title: d.title,
    original_title: d.original_title,
    year: yearOf(d.release_date),
    poster_path: d.poster_path || null,
    added_date: today(),
  };
  // Quello che vedi già nella scheda non arriva anche per mail.
  if (prov.wanted.length) entry.notified = { date: today(), providers: prov.wanted.map((p) => p.name), on_add: true };
  else if (prov.watchOnly.length) entry.watch_only = { date: today(), providers: prov.watchOnly.map((p) => p.name), on_add: true };
  await mutate((db) => {
    const u = db.users.find((x) => x.id === user.id);
    if (!u) throw new Error("Utente non trovato: forse è stato eliminato");
    if (!u.movies.some((x) => x.tmdb_id === d.id)) u.movies.push(entry);
  }, `web: ${user.name} aggiunge "${d.title}"`);
  toast(`«${d.title}» aggiunto alla lista di ${user.name}`);
}

$("#btn-check").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await store.runCheck();
    toast("Controllo avviato: se c'è qualcosa di nuovo la mail arriva tra un paio di minuti.");
  } catch (ex) {
    if (ex.status === 403 || ex.status === 404) toast("Il token GitHub non ha il permesso «Actions: read and write».", true);
    else handleError(ex);
  } finally {
    setTimeout(() => (btn.disabled = false), 4000);
  }
});

$("#btn-logout").addEventListener("click", logout);
$("#btn-users").addEventListener("click", openUsers);
document.querySelectorAll(".seg button").forEach((b) =>
  b.addEventListener("click", () => { state.filter = b.dataset.filter; renderList(); }));
document.querySelectorAll("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
document.querySelectorAll("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));

// ---------- utenti ----------

function openUsers() {
  renderUsers();
  $("#dlg-users").showModal();
  $("#user-name").focus();
}

function renderUsers() {
  $("#users-list").replaceChildren(...state.db.users.map((u) =>
    el("li", {},
      el("span", { class: "u-name" }, u.name),
      el("span", { class: "u-n" }, u.movies.length === 1 ? "1 film" : `${u.movies.length} film`),
      el("button", { class: "icon-btn", title: "Elimina utente", "aria-label": `Elimina ${u.name}`, onclick: () => removeUser(u) }, "🗑"),
    )));
  if (!state.db.users.length) $("#users-list").append(el("li", { class: "muted" }, "Nessun utente"));
}

$("#user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#user-name").value.trim();
  if (!name) return;
  if (state.db.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) return toast(`Esiste già un utente «${name}»`, true);
  let id;
  try {
    await mutate((db) => {
      const base = slug(name);
      id = base;
      for (let i = 2; db.users.some((u) => u.id === id); i++) id = `${base}-${i}`;
      db.users.push({ id, name, created: today(), movies: [] });
    }, `web: nuovo utente ${name}`);
    $("#user-name").value = "";
    renderUsers();
    selectUser(id);
    toast(`Utente ${name} creato`);
  } catch (ex) {
    handleError(ex);
  }
});

async function removeUser(u) {
  $("#dlg-users").close();
  const n = u.movies.length;
  const ok = await confirmDialog(`Eliminare ${u.name}?`, n ? `Si perde anche la sua lista (${n} film).` : "La sua lista è vuota.", "Elimina");
  if (!ok) return openUsers();
  try {
    await mutate((db) => { db.users = db.users.filter((x) => x.id !== u.id); }, `web: elimina utente ${u.name}`);
    if (state.userId === u.id) state.userId = state.db.users[0]?.id || null;
    render();
    toast(`${u.name} eliminato`);
  } catch (ex) {
    handleError(ex);
  }
}

// ---------- ricerca e conferma ----------

const q = $("#q");
const results = $("#results");
let searchTimer, searchSeq = 0, active = -1, items = [];

function closeResults() {
  results.hidden = true;
  q.setAttribute("aria-expanded", "false");
  active = -1;
}

function setActive(i) {
  const lis = [...results.querySelectorAll("li[role=option]")];
  if (!lis.length) return;
  active = (i + lis.length) % lis.length;
  lis.forEach((li, j) => li.setAttribute("aria-selected", String(j === active)));
  lis[active].scrollIntoView({ block: "nearest" });
}

q.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const text = q.value.trim();
  if (text.length < 2) { closeResults(); $("#q-spin").hidden = true; return; }
  searchTimer = setTimeout(() => runSearch(text), 280);
});

async function runSearch(text) {
  const seq = ++searchSeq;
  $("#q-spin").hidden = false;
  try {
    const list = rankResults(await tmdb.search(text)).slice(0, 10);
    if (seq !== searchSeq) return;
    items = list;
    const user = currentUser();
    const have = new Set(user?.movies.map((m) => m.tmdb_id));
    results.replaceChildren(...(list.length
      ? list.map((r, i) => el("li", { role: "option", id: `opt-${i}`, onmousedown: (e) => { e.preventDefault(); pick(i); } },
          poster(r.poster_path, r.title, "w92", "r-poster poster"),
          el("div", { class: "r-main" },
            el("div", { class: "r-title" }, r.title, r.release_date ? ` (${r.release_date.slice(0, 4)})` : ""),
            el("div", { class: "r-sub" }, r.original_title && r.original_title !== r.title ? r.original_title : (r.overview || "").slice(0, 90) || " "),
          ),
          have.has(r.id) ? el("span", { class: "tag" }, "in lista") : null))
      : [el("li", { class: "none" }, "Nessun film trovato. Prova col titolo originale o aggiungi l'anno.")]));
    results.hidden = false;
    q.setAttribute("aria-expanded", "true");
    active = -1;
    if (list.length) setActive(0);
  } catch (e) {
    if (seq === searchSeq) handleError(e);
  } finally {
    if (seq === searchSeq) $("#q-spin").hidden = true;
  }
}

q.addEventListener("keydown", (e) => {
  if (results.hidden) return;
  if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
  else if (e.key === "Enter" && active >= 0 && items[active]) { e.preventDefault(); pick(active); }
  else if (e.key === "Escape") closeResults();
});
q.addEventListener("blur", () => setTimeout(closeResults, 120));
q.addEventListener("focus", () => { if (results.children.length && q.value.trim().length >= 2) { results.hidden = false; q.setAttribute("aria-expanded", "true"); } });

async function pick(i) {
  const r = items[i];
  const user = currentUser();
  if (!r || !user) return;
  closeResults();
  q.blur();
  const body = $("#add-body");
  body.replaceChildren(detailView(r, null, user));
  $("#dlg-add").showModal();
  try {
    const d = await tmdb.details(r.id);
    if (!$("#dlg-add").open) return;
    body.replaceChildren(detailView(d, pickProviders(d["watch/providers"]?.results, rules()), user));
  } catch (e) {
    $("#dlg-add").close();
    handleError(e);
  }
}

function detailView(d, prov, user) {
  const already = user.movies.some((m) => m.tmdb_id === d.id);
  const director = d.credits?.crew?.filter((c) => c.job === "Director").map((c) => c.name).join(", ");
  const meta = [d.release_date ? fmtDate(d.release_date) : "data sconosciuta", d.runtime ? `${d.runtime} min` : null].filter(Boolean).join(" · ");

  let avail;
  if (!prov) avail = el("div", { class: "avail" }, el("span", { class: "skeleton", style: "width:60%" }));
  else if (prov.wanted.length)
    avail = el("div", { class: "avail ok" },
      el("div", {}, el("strong", {}, "È già in streaming in Italia"), "Puoi guardarlo subito; se lo aggiungi lo stesso non ti arriva la mail."),
      providerChips(prov.wanted));
  else {
    const r = rules();
    const waitFor = r.wanted.filter((w) => w !== "Max").join(", ") + (r.free ? " o gratis" : "");
    avail = el("div", { class: prov.watchOnly.length ? "avail sky" : "avail wait" },
      prov.watchOnly.length
        ? el("div", {}, el("strong", {}, `C'è già su ${prov.watchOnly.map((p) => p.name).join(", ")}, ma continuo ad aspettare`), `Ti arriva una mail quando esce su ${waitFor}.`)
        : el("div", {}, el("strong", {}, "Non ancora sulle tue piattaforme"),
            prov.rentOrBuy && !prov.other.length ? "Per ora c'è solo a noleggio o acquisto. " : "",
            `Ti arriva una mail quando esce su ${waitFor}.`),
      prov.watchOnly.length ? providerChips(prov.watchOnly) : null,
      prov.other.length ? el("div", { class: "small muted" }, `Anche su ${prov.other.map((p) => p.name).join(", ")}, che non conta.`) : null);
  }

  const addBtn = el("button", { class: "btn primary", disabled: already || !prov ? true : null }, already ? "Già nella lista" : `Aggiungi alla lista di ${user.name}`);
  addBtn.addEventListener("click", async () => {
    addBtn.disabled = true;
    addBtn.textContent = "Salvo…";
    try {
      await addMovie(user, d, prov);
      $("#dlg-add").close();
      q.value = "";
      results.replaceChildren();
    } catch (e) {
      handleError(e);
      addBtn.disabled = false;
      addBtn.textContent = `Aggiungi alla lista di ${user.name}`;
    }
  });

  return el("div", {},
    el("div", { class: "detail" },
      poster(d.poster_path, d.title, "w342"),
      el("div", { class: "detail-main" },
        el("h3", {}, d.title),
        d.original_title && d.original_title !== d.title ? el("div", { class: "muted small" }, d.original_title) : null,
        el("div", { class: "muted small" }, meta),
        director ? el("div", { class: "small" }, "Regia di ", el("strong", {}, director)) : null,
        d.overview ? el("p", { class: "overview" }, d.overview) : null,
        el("a", { class: "small muted", href: `https://www.themoviedb.org/movie/${d.id}`, target: "_blank", rel: "noopener" }, "Scheda su TMDB ↗"),
      ),
    ),
    avail,
    el("div", { class: "actions" },
      el("button", { class: "btn ghost", onclick: () => $("#dlg-add").close() }, "Non è questo"),
      addBtn,
    ),
  );
}

// ---------- avvio ----------

async function start(secrets) {
  if (DEMO) {
    store = new DemoStore();
    tmdb = new DemoTmdb();
  } else {
    store = new GitHubStore(cfg, secrets.github_token);
    tmdb = new Tmdb(secrets.tmdb_token);
  }
  try { state.userId = localStorage.getItem(USER_KEY); } catch {}
  $("#login").hidden = true;
  $("#app").hidden = false;
  if (DEMO) document.title = "Watchlist (demo)";
  try {
    await reload();
  } catch (e) {
    if (e.status === 401) return showLogin("Il token GitHub non è più valido: rigenera config.js con setup.html.");
    if (e.status === 404) return showLogin(`Non trovo ${cfg.dbPath} in ${cfg.repo}: controlla config.js e i permessi del token.`);
    handleError(e);
  }
}

// Ricarica quando si torna sulla pagina (es. modifiche da un altro dispositivo).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.db && !state.busy && !document.querySelector("dialog[open]")) {
    reload().catch(handleError);
  }
});

const saved = readSecrets();
if (DEMO) start({});
else if (saved) start(saved);
else showLogin();
