/* Spearhead Fieldbook — persistence, undo and battle history (no DOM). */
(function (root) {
  'use strict';
  const KEY = 'spearhead-fieldbook-v2', LEGACY_KEY = 'spearhead-fieldbook-v1', MAX_UNDO = 60;

  // keySuffix lets two "devices" share one browser during development (?device=2).
  function create({ engine, Engine, storage, keySuffix = '', now = () => new Date().toISOString(), uuid = () => root.crypto.randomUUID() }) {
    const KEY_ = KEY + (keySuffix ? '.' + keySuffix : '');
    const clone = Engine.clone;
    const fresh = () => ({ schema: 2, prefs: { lang: 'ko', mode: 'guided', device: 'linked' }, game: null, history: [], undo: [], draft: {}, link: null });
    let db = fresh();
    const status = { corruptKey: null, legacyFound: false, saveError: false };

    const validGame = g => !!g && typeof g === 'object' && g.schema === 2 && typeof g.id === 'string' &&
      !!g.config && Array.isArray(g.rounds) && typeof g.stage === 'string' && Number.isInteger(g.rev) &&
      (g.decks === null || (Array.isArray(g.decks.players) && g.decks.players.length === 2 && !!g.decks.twist));
    const validDb = v => !!v && v.schema === 2 && !!v.prefs && typeof v.prefs === 'object' &&
      Array.isArray(v.history) && Array.isArray(v.undo) && (v.game === null || validGame(v.game)) &&
      v.history.every(validGame) && v.undo.every(validGame);

    function load() {
      let raw = null;
      try { raw = storage.getItem(KEY_); } catch (e) { status.saveError = true; return db; }
      if (raw === null) {
        try { status.legacyFound = storage.getItem(LEGACY_KEY) !== null; } catch (e) { /* ignore */ }
        return db;
      }
      try {
        const v = JSON.parse(raw);
        if (!validDb(v)) throw new Error('invalid');
        v.draft = v.draft && typeof v.draft === 'object' ? v.draft : {};
        v.prefs = { lang: v.prefs.lang === 'en' ? 'en' : 'ko', mode: v.prefs.mode === 'quick' ? 'quick' : 'guided',
          device: ['shared', 'solo', 'linked'].includes(v.prefs.device) ? v.prefs.device : 'linked' };
        v.link = v.link && typeof v.link.room === 'string' ? v.link : null;
        db = v;
      } catch (e) {
        // Keep the damaged value instead of overwriting it, then start clean.
        status.corruptKey = KEY_ + '.corrupt.' + Date.now();
        try { storage.setItem(status.corruptKey, raw); } catch (e2) { /* ignore */ }
        db = fresh();
      }
      return db;
    }
    function save() {
      try { storage.setItem(KEY_, JSON.stringify(db)); status.saveError = false; }
      catch (e) {
        // Storage full: drop the oldest undo snapshots before giving up.
        if (db.undo.length > 5) { db.undo.splice(0, db.undo.length - 5); try { storage.setItem(KEY_, JSON.stringify(db)); status.saveError = false; return; } catch (e2) { /* fallthrough */ } }
        status.saveError = true;
      }
    }
    // Which seat is "me" on this device (history is kept from that player's point of view).
    const mySeat = g => (g.play === 'solo' ? g.me : g.play === 'linked' ? (db.link?.seat ?? 0) : 0);
    function syncHistory() {
      const g = db.game; if (!g) return;
      db.history = db.history.filter(h => h.id !== g.id);
      if (g.status === 'finished') db.history.unshift({ ...clone(g), mySeat: mySeat(g) });
    }
    // Linked play: the synced game replaces the local copy (undo lives in the shared room).
    function applyRemote(game, link) {
      db.link = { ...(db.link || {}), ...link };
      if (game && !validGame(game)) return false;
      db.game = game; db.undo = [];
      syncHistory(); save();
      return true;
    }
    function setLink(link) { db.link = link; if (!link) { db.game = null; db.undo = []; } save(); }

    // Creates a game object without storing it (linked play pushes it to the room first).
    const makeGame = payload => engine.newGame({ ...payload, id: uuid(), now: now() });
    function startGame(payload) {
      db.game = makeGame(payload);
      db.undo = []; db.draft = {};
      save();
      return db.game;
    }
    // One game action = one undo snapshot. `rev` rejects double clicks from a stale screen.
    function dispatch(name, payload = {}, rev) {
      const g = db.game;
      if (!g) throw new Engine.RuleError('E_NO_GAME');
      if (rev !== undefined && rev !== g.rev) throw new Engine.RuleError('E_STALE');
      const fn = engine.actions[name];
      if (!fn) throw new Error('unknown action ' + name);
      const snapshot = clone(g);
      try { fn(g, { now: now(), ...payload }); }
      catch (e) { db.game = snapshot; throw e; }
      g.rev = snapshot.rev + 1;
      db.undo.push(snapshot);
      if (db.undo.length > MAX_UNDO) db.undo.shift();
      syncHistory(); save();
      return g;
    }
    function undo() {
      if (!db.game || !db.undo.length) return false;
      const id = db.game.id;
      db.game = db.undo.pop();
      db.history = db.history.filter(h => h.id !== id);
      syncHistory(); save();
      return true;
    }
    function abandon() { db.game = null; db.undo = []; db.draft = {}; db.link = null; save(); }
    function setPref(k, v) { db.prefs[k] = v; save(); }
    function setDraft(k, v) { if (v === undefined) delete db.draft[k]; else db.draft[k] = v; save(); }
    function setNotes(v) { if (db.game) { db.game.notes = String(v).slice(0, 5000); syncHistory(); save(); } }
    function exportData() { return JSON.stringify({ ...db, undo: [] }, null, 2); }
    function importData(json) {
      const v = JSON.parse(json);
      if (!validDb({ ...v, undo: v.undo || [] })) throw new Engine.RuleError('E_IMPORT');
      db = { ...fresh(), ...v, undo: [], prefs: db.prefs };
      save();
    }
    function reload() { db = fresh(); return load(); }

    return {
      get db() { return db; }, status, load, save, startGame, makeGame, dispatch, undo, abandon, applyRemote, setLink, mySeat, syncHistory,
      setPref, setDraft, setNotes, exportData, importData, reload, KEY: KEY_, validGame
    };
  }
  const Engine = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;
  const api = { create: opts => create({ Engine, ...opts }), KEY, LEGACY_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Store = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
