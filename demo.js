// Modalità demo (index.html?demo): dati finti in memoria, niente GitHub né TMDB.
// Serve a provare la pagina senza token.

const FILMS = [
  { id: 693134, title: "Dune - Parte due", original_title: "Dune: Part Two", release_date: "2024-02-27", runtime: 166, director: "Denis Villeneuve", overview: "Paul Atreides si unisce a Chani e ai Fremen.", prov: ["Netflix", "Timvision"] },
  { id: 438631, title: "Dune", original_title: "Dune", release_date: "2021-09-15", runtime: 155, director: "Denis Villeneuve", overview: "Il figlio di una famiglia nobile è chiamato a proteggere il pianeta più prezioso della galassia.", prov: ["Netflix"] },
  { id: 841, title: "Dune", original_title: "Dune", release_date: "1984-12-14", runtime: 137, director: "David Lynch", overview: "Nel lontano futuro, la spezia è la sostanza più preziosa dell'universo.", prov: [] },
  { id: 786892, title: "Furiosa: A Mad Max Saga", original_title: "Furiosa: A Mad Max Saga", release_date: "2024-05-22", runtime: 149, director: "George Miller", overview: "La giovane Furiosa viene strappata al Luogo Verde.", prov: ["Sky Go", "Now TV"] },
  { id: 701387, title: "Bugonia", original_title: "Bugonia", release_date: "2025-10-23", runtime: 118, director: "Yorgos Lanthimos", overview: "Due giovani rapiscono l'amministratrice di una grande azienda.", prov: [] },
  { id: 13980, title: "Sword of the Stranger", original_title: "ストレンヂア 無皇刃譚", release_date: "2007-09-29", runtime: 103, director: "Masahiro Andō", overview: "Un ronin senza nome protegge un bambino inseguito.", prov: [] },
  { id: 1220564, title: "L'agente segreto", original_title: "O Agente Secreto", release_date: "2025-11-05", runtime: 158, director: "Kleber Mendonça Filho", overview: "Brasile, 1977. Un professore fugge da un passato misterioso.", prov: ["MUBI"] },
];

const byId = new Map(FILMS.map((f) => [f.id, f]));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export class DemoStore {
  constructor() {
    this.db = {
      version: 2,
      users: [
        {
          id: "edoardo",
          name: "Edoardo",
          created: "2026-04-16",
          movies: [
            { tmdb_id: 693134, title: "Dune - Parte due", year: 2024, added_date: "2026-04-16", notified: { date: "2026-04-16", providers: ["Netflix", "Timvision"] } },
            { tmdb_id: 701387, title: "Bugonia", year: 2025, added_date: "2026-04-16" },
            { tmdb_id: 13980, title: "Sword of the Stranger", year: 2007, added_date: "2026-05-06" },
          ],
        },
        { id: "giulia", name: "Giulia", created: "2026-11-01", movies: [] },
      ],
    };
  }
  async load() {
    await wait(200);
    return structuredClone(this.db);
  }
  async save(db) {
    await wait(300);
    this.db = structuredClone(db);
  }
  async runCheck() {
    await wait(300);
  }
}

function asResult(f) {
  return { id: f.id, title: f.title, original_title: f.original_title, release_date: f.release_date, poster_path: null, overview: f.overview };
}

function providersOf(f) {
  const list = f.prov.map((name, i) => ({ id: i, name, logo: null, type: "flatrate" }));
  return { list, link: null, rentOrBuy: f.prov.length === 0 };
}

export class DemoTmdb {
  async search(text) {
    await wait(150);
    const q = text.toLowerCase().trim();
    return FILMS.filter((f) => f.title.toLowerCase().includes(q) || f.original_title.toLowerCase().includes(q)).map(asResult);
  }
  async details(id) {
    await wait(200);
    const f = byId.get(id);
    return {
      ...asResult(f),
      runtime: f.runtime,
      credits: { crew: [{ job: "Director", name: f.director }] },
      "watch/providers": { results: f.prov.length ? { IT: { flatrate: f.prov.map((n, i) => ({ provider_id: i, provider_name: n, logo_path: null })) } } : {} },
    };
  }
  async providers(id) {
    await wait(100);
    const f = byId.get(id);
    return f ? providersOf(f) : { list: [], link: null, rentOrBuy: false };
  }
}
