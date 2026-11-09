# 🎬 Watchlist (pagina web)

Pagina statica per gestire le watchlist di [watchlist-scraper](https://github.com/edobartobf/watchlist-scraper)
(repo privato, fa da database e manda le mail).

- `index.html` · `app.js` · `style.css`: la app (login, utenti, ricerca con conferma, lista).
- `vault.js`: cifratura dei token con la master password (PBKDF2-SHA256 + AES-GCM, WebCrypto).
- `api.js`: GitHub Contents API per `data/db.json`, TMDB per ricerca e disponibilità.
- `setup.html`: verifica i token e genera `config.js`.
- `config.js`: repo dei dati e token cifrati. È pubblico, ma senza password non serve a niente.
- `demo.js`: dati finti per `index.html?demo`.
- `manifest.webmanifest` · `sw.js` · `icons/`: app installabile (Android: bottone «Installa» o menu di Chrome →
  *Aggiungi a schermata Home*; iPhone: Safari → Condividi → *Aggiungi alla schermata Home*).
  Il service worker prende sempre i file dalla rete e usa la copia solo offline;
  se cambi l'elenco dei file in `SHELL`, alza la versione di `CACHE`.

Nessuna build: si pubblica così com'è con GitHub Pages (*Settings → Pages → main / root*).
In locale: `python3 -m http.server 8765` e `http://localhost:8765/?demo`.
