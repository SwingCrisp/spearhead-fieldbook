/* Linked play: two devices share one game through a room.
 * Room layout (any transport):
 *   rooms/{code}/sync       = { seq, undoKey, game: JSON string | null, at }
 *   rooms/{code}/undo/{key} = { snapshot: JSON string, prevKey }
 * Games are stored as JSON strings because Firebase drops empty arrays and nulls.
 * Every change is a compare-and-set on `seq`, so two phones pressing at once cannot both win. */
(function (root) {
  'use strict';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols: unbiased from 32-bit randoms, no 0/O/1/I
  const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
  function roomCode() {
    const b = new Uint32Array(6); root.crypto.getRandomValues(b);
    return Array.from(b, x => CODE_CHARS[x % 32]).join('');
  }

  function create({ store, engine, Engine, transport, onChange = () => {}, onStatus = () => {} }) {
    const Rule = Engine.RuleError;
    let room = null, seat = null, seq = null, undoKey = null, unsub = null;

    function receive(sync) {
      if (!sync) return;
      if (seq !== null && sync.seq < seq) return; // stale echo
      seq = sync.seq; undoKey = sync.undoKey || null;
      const game = sync.game ? JSON.parse(sync.game) : null;
      store.applyRemote(game, { room, seat, seq });
      onChange();
    }
    function attach(code, s) {
      detach();
      room = code; seat = s; seq = null; undoKey = null;
      store.setLink({ room, seat, seq: null });
      onStatus('connecting');
      unsub = transport.subscribe(code, sync => { onStatus('online'); receive(sync); }, () => onStatus('offline'));
    }
    function detach() { if (unsub) unsub(); unsub = null; }

    async function createRoom(s = 0) {
      for (let i = 0; i < 5; i++) {
        const code = roomCode();
        const ok = await transport.transact(code, cur => (cur ? undefined : { seq: 0, undoKey: null, game: null, at: Date.now() }));
        if (ok) { attach(code, s); return code; }
      }
      throw new Rule('E_ROOM_CREATE');
    }
    async function joinRoom(code, s = 1) {
      code = String(code || '').trim().toUpperCase();
      if (!CODE_RE.test(code)) throw new Rule('E_ROOM_CODE');
      if (!(await transport.exists(code))) throw new Rule('E_ROOM_NOT_FOUND');
      attach(code, s);
      return code;
    }
    function resume() { const l = store.db.link; if (l?.room) attach(l.room, l.seat); }
    function leave() { detach(); room = null; seq = null; store.setLink(null); onChange(); }
    function setSeat(s) { seat = s; store.db.link = { ...store.db.link, seat }; store.save(); onChange(); }

    async function commit(next, base) {
      if (seq === null) throw new Rule('E_OFFLINE');
      const baseSeq = seq;
      const key = base ? await transport.pushUndo(room, { snapshot: JSON.stringify(base), prevKey: undoKey }) : undoKey;
      const ok = await transport.transact(room, cur => (cur && cur.seq === baseSeq
        ? { seq: baseSeq + 1, undoKey: key, game: JSON.stringify(next), at: Date.now() } : undefined));
      if (!ok) throw new Rule('E_SYNC_CONFLICT');
      if (seq === baseSeq) receive({ seq: baseSeq + 1, undoKey: key, game: JSON.stringify(next) });
    }
    // Same contract as store.dispatch, but asynchronous and shared with the other device.
    async function dispatch(name, payload = {}, rev) {
      const base = store.db.game;
      if (!base) throw new Rule('E_NO_GAME');
      if (rev !== undefined && rev !== base.rev) throw new Rule('E_STALE');
      const next = Engine.clone(base);
      engine.actions[name](next, { now: new Date().toISOString(), ...payload }); // throws RuleError on invalid input
      next.rev = base.rev + 1;
      await commit(next, base);
    }
    async function startGame(payload) {
      if (store.db.game) throw new Rule('E_ALREADY');
      await commit(store.makeGame({ ...payload, play: 'linked' }), null);
    }
    async function undo() {
      if (!undoKey || seq === null) return false;
      const baseSeq = seq, entry = await transport.getUndo(room, undoKey);
      if (!entry) return false;
      const ok = await transport.transact(room, cur => (cur && cur.seq === baseSeq
        ? { seq: baseSeq + 1, undoKey: entry.prevKey || null, game: entry.snapshot, at: Date.now() } : undefined));
      if (!ok) throw new Rule('E_SYNC_CONFLICT');
      if (seq === baseSeq) receive({ seq: baseSeq + 1, undoKey: entry.prevKey || null, game: entry.snapshot });
      return true;
    }
    return {
      createRoom, joinRoom, resume, leave, setSeat, dispatch, startGame, undo,
      get room() { return room; }, get seat() { return seat; }, get canUndo() { return !!undoKey; }, get ready() { return seq !== null; }
    };
  }

  /* ---------- transports ---------- */
  // In-memory room store shared by several clients (tests).
  function memoryTransport(shared = { rooms: {} }) {
    const subs = shared.subs || (shared.subs = {});
    const notify = code => (subs[code] || []).forEach(cb => cb(clone(shared.rooms[code]?.sync ?? null)));
    const clone = x => (x == null ? x : JSON.parse(JSON.stringify(x)));
    return {
      shared,
      subscribe(code, cb) { (subs[code] = subs[code] || []).push(cb); cb(clone(shared.rooms[code]?.sync ?? null)); return () => { subs[code] = subs[code].filter(x => x !== cb); }; },
      async transact(code, fn) {
        const r = shared.rooms[code] || (shared.rooms[code] = { sync: null, undo: {} });
        const next = fn(clone(r.sync));
        if (next === undefined) return false;
        r.sync = clone(next); notify(code); return true;
      },
      async pushUndo(code, entry) { const k = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); shared.rooms[code].undo[k] = clone(entry); return k; },
      async getUndo(code, key) { return clone(shared.rooms[code]?.undo[key] ?? null); },
      async exists(code) { return !!shared.rooms[code]?.sync; }
    };
  }

  // Development: two tabs of one browser (open the app with ?device=2&transport=local in the second tab).
  function localTransport() {
    const key = code => 'sf-room.' + code;
    const read = code => { try { return JSON.parse(localStorage.getItem(key(code))) || null; } catch (e) { return null; } };
    const channels = {};
    const chan = code => channels[code] || (channels[code] = new BroadcastChannel('sf-room.' + code));
    return {
      subscribe(code, cb) {
        const c = chan(code), h = () => cb(read(code)?.sync ?? null);
        c.addEventListener('message', h); h();
        return () => c.removeEventListener('message', h);
      },
      async transact(code, fn) {
        const r = read(code) || { sync: null, undo: {} };
        const next = fn(r.sync ? JSON.parse(JSON.stringify(r.sync)) : null);
        if (next === undefined) return false;
        r.sync = next; localStorage.setItem(key(code), JSON.stringify(r)); chan(code).postMessage(1);
        return true;
      },
      async pushUndo(code, entry) { const r = read(code); const k = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); r.undo[k] = entry; localStorage.setItem(key(code), JSON.stringify(r)); return k; },
      async getUndo(code, k) { return read(code)?.undo[k] ?? null; },
      async exists(code) { return !!read(code)?.sync; }
    };
  }

  // Firebase Realtime Database (config in firebase-config.js). SDK is loaded only when linked play is used.
  const FB = 'https://www.gstatic.com/firebasejs/10.14.1/';
  const loadScript = src => new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Engine.RuleError('E_LINK_LOAD')); document.head.append(s); });
  async function firebaseTransport(config) {
    if (!root.firebase?.database) { await loadScript(FB + 'firebase-app-compat.js'); await loadScript(FB + 'firebase-database-compat.js'); }
    const app = root.firebase.apps.length ? root.firebase.app() : root.firebase.initializeApp(config);
    const db = app.database(), ref = (code, p) => db.ref(`rooms/${code}/${p}`);
    return {
      subscribe(code, cb, onErr) {
        const r = ref(code, 'sync'), h = snap => cb(snap.val());
        r.on('value', h, onErr);
        return () => r.off('value', h);
      },
      async transact(code, fn) {
        // With a live 'value' listener the local cache holds the current value, so `cur` is accurate.
        const res = await ref(code, 'sync').transaction(cur => fn(cur), undefined, false);
        return res.committed;
      },
      async pushUndo(code, entry) { const r = ref(code, 'undo').push(); await r.set(entry); return r.key; },
      async getUndo(code, key) { return (await ref(code, 'undo/' + key).once('value')).val(); },
      async exists(code) { return (await ref(code, 'sync').once('value')).exists(); },
      onConnection(cb) { db.ref('.info/connected').on('value', s => cb(!!s.val())); }
    };
  }

  const api = { create, memoryTransport, localTransport, firebaseTransport, roomCode, CODE_RE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Link = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
