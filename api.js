// Accesso ai dati: il "database" è data/db.json nel repo privato, letto e scritto
// con l'API Contents di GitHub. TMDB per la ricerca e la disponibilità in streaming.

import { toB64, fromB64 } from "./vault.js";

const GH = "https://api.github.com";
const TMDB = "https://api.themoviedb.org/3";
export const COUNTRY = "IT";
export const IMG = "https://image.tmdb.org/t/p/";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const utf8 = { enc: new TextEncoder(), dec: new TextDecoder() };

export class GitHubStore {
  constructor(cfg, token) {
    this.cfg = cfg;
    this.token = token;
    this.sha = null;
  }

  async req(method, url, body) {
    const res = await fetch(`${GH}${url}`, {
      method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = (await res.json()).message || msg;
      } catch {}
      if (res.status === 401) msg = "Token GitHub non valido o scaduto";
      throw new HttpError(res.status, `GitHub: ${msg}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async load() {
    const { repo, branch, dbPath } = this.cfg;
    const file = await this.req("GET", `/repos/${repo}/contents/${dbPath}?ref=${encodeURIComponent(branch)}`);
    this.sha = file.sha;
    return JSON.parse(utf8.dec.decode(fromB64(file.content)));
  }

  async save(db, message) {
    const { repo, branch, dbPath } = this.cfg;
    const content = toB64(utf8.enc.encode(JSON.stringify(db, null, 2) + "\n"));
    const out = await this.req("PUT", `/repos/${repo}/contents/${dbPath}`, {
      message,
      content,
      sha: this.sha,
      branch,
    });
    this.sha = out.content.sha;
  }

  async runCheck() {
    const { repo, branch, workflow } = this.cfg;
    await this.req("POST", `/repos/${repo}/actions/workflows/${workflow}/dispatches`, { ref: branch });
  }
}

export class Tmdb {
  constructor(token) {
    this.token = token;
    this.cache = new Map();
  }

  async get(path, params = {}) {
    const all = { language: "it-IT", ...params };
    const qs = new URLSearchParams(Object.entries(all).filter(([, v]) => v !== "" && v != null));
    const key = `${path}?${qs}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const p = fetch(`${TMDB}${path}?${qs}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
    }).then(async (res) => {
      if (!res.ok) {
        this.cache.delete(key);
        throw new HttpError(res.status, res.status === 401 ? "Token TMDB non valido" : `TMDB: errore ${res.status}`);
      }
      return res.json();
    });
    this.cache.set(key, p);
    return p;
  }

  // "dune 2021" cerca "dune" filtrando per anno
  async search(text) {
    const m = text.trim().match(/^(.*\S)\s+\(?((?:19|20)\d{2})\)?$/);
    const params = { query: m ? m[1] : text.trim(), include_adult: "false" };
    if (m) params.primary_release_year = m[2];
    const data = await this.get("/search/movie", params);
    return data.results;
  }

  details(id) {
    return this.get(`/movie/${id}`, { append_to_response: "watch/providers,credits" });
  }

}

// TMDB ordina per pertinenza. Qui portiamo in cima i film usciti da poco (ultimi 18 mesi)
// o in uscita nei prossimi 6, perché spesso si aggiunge quello appena uscito al cinema.
// Dentro ciascun gruppo resta l'ordine di TMDB. I titoli quasi sconosciuti (popolarità
// sotto 3) non salgono, così un omonimo oscuro non scavalca il film cercato.
const DAY = 864e5;
export function rankResults(list, now = Date.now()) {
  const recent = (r) => {
    const t = Date.parse(r.release_date || "");
    return t >= now - 548 * DAY && t <= now + 180 * DAY && (r.popularity || 0) >= 3;
  };
  return [...list.filter(recent), ...list.filter((r) => !recent(r))];
}

// Regole di default: le stesse di scripts/check_availability.py nel repo dei dati.
// Se data/db.json ha "settings.providers", vincono quelle.
export const DEFAULT_RULES = {
  wanted: ["Netflix", "Amazon Prime Video", "Disney Plus", "HBO Max", "Max", "Timvision"],
  watch_only: ["Sky Go", "Now TV", "Sky", "Apple TV"],
  free: true,
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function matches(name, patterns) {
  const n = name.toLowerCase();
  if (n.includes("channel")) return false;
  return patterns.some((p) => new RegExp(`^${escapeRe(p.toLowerCase())}(?![a-z0-9])`).test(n));
}

// Divide le piattaforme in Italia in:
//   wanted    chiudono l'attesa (abbonamenti scelti o gratis)
//   watchOnly da segnalare ma si continua ad aspettare (Sky)
//   other     abbonamenti che non contano (es. canali Amazon, MUBI)
export function pickProviders(results, rules = DEFAULT_RULES) {
  const c = (results || {})[COUNTRY] || {};
  const seen = new Set();
  const out = { wanted: [], watchOnly: [], other: [] };
  const add = (bucket, p, type) => {
    if (seen.has(p.provider_id)) return;
    seen.add(p.provider_id);
    out[bucket].push({ id: p.provider_id, name: p.provider_name, logo: p.logo_path, type });
  };
  for (const p of c.flatrate || []) {
    add(matches(p.provider_name, rules.wanted) ? "wanted" : matches(p.provider_name, rules.watch_only) ? "watchOnly" : "other", p, "flatrate");
  }
  for (const cat of ["free", "ads"]) for (const p of c[cat] || []) add(rules.free ? "wanted" : "other", p, "free");
  out.link = c.link || null;
  out.rentOrBuy = [...(c.rent || []), ...(c.buy || [])].length > 0;
  return out;
}
