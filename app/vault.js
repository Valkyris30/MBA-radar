/* Device pairing. The data files are published encrypted (AES-256-GCM over gzip, see
   collector/vault.py); a device can read them only once its owner has pasted the device key.
   The key stays in this device's storage and is never sent anywhere. */
window.Vault = (() => {
  const STORE = 'mr.deviceKey';
  const ALG = 'A256GCM+gzip';
  let key = null;

  class Locked extends Error {}

  function bytes(text) {
    const s = text.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  async function importKey(text) {
    const clean = String(text || '').replace(/\s+/g, '');
    let raw;
    try { raw = bytes(clean); } catch { raw = null; }
    if (!raw || raw.length !== 32) throw new Locked('That is not a device key.');
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  }

  function saved() { try { return localStorage.getItem(STORE); } catch { return null; } }

  async function ready() {
    if (key) return true;
    const text = saved();
    if (!text) return false;
    try { key = await importKey(text); return true; } catch { return false; }
  }

  async function open(doc, k = key) {
    if (!doc || doc.sealed !== ALG) return doc;
    if (!k) throw new Locked('This device is not paired.');
    let plain;
    try {
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(doc.iv) }, k, bytes(doc.data));
    } catch {
      throw new Locked('This key does not open the edition.');
    }
    const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  async function json(url, opts = { cache: 'no-store' }) {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return open(await res.json());
  }

  // Check the key against today's edition before remembering it.
  async function pair(text) {
    const k = await importKey(text);
    const res = await fetch('data/articles.json', { cache: 'no-store' }).catch(() => null);
    if (res && res.ok) await open(await res.json(), k);
    try { localStorage.setItem(STORE, String(text).replace(/\s+/g, '')); } catch { /* kept for this visit only */ }
    key = k;
  }

  function forget() {
    key = null;
    try { localStorage.removeItem(STORE); } catch { /* nothing stored */ }
  }

  return { ready, open, json, pair, forget, Locked };
})();
