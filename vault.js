// Cifratura dei token con la master password (WebCrypto: PBKDF2-SHA256 + AES-GCM).
// Lo stesso codice serve a setup.html (cifra) e alla app (decifra).

const ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(b64.replace(/\s/g, ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptVault(secrets, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITERATIONS);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(secrets))),
  );
  return { v: 1, kdf: "PBKDF2-SHA256", iterations: ITERATIONS, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
}

// Ritorna i segreti in chiaro, oppure lancia un errore se la password è sbagliata.
export async function decryptVault(vault, password) {
  const key = await deriveKey(password, fromB64(vault.salt), vault.iterations);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(vault.iv) }, key, fromB64(vault.ct));
  } catch {
    throw new Error("Password sbagliata");
  }
  return JSON.parse(dec.decode(plain));
}
