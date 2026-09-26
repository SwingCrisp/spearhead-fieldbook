/* Spearhead Fieldbook — rules engine (pure state transitions, no DOM).
 * Engine.create(cardData) returns an API bound to the card JSON.
 * Every action mutates the game object passed in and throws RuleError on invalid input;
 * the store takes a snapshot first, so a thrown action leaves nothing half-applied. */
(function (root) {
  'use strict';

  const PHASES = ['start', 'hero', 'movement', 'shooting', 'charge', 'combat', 'end'];
  const SCHEMA = 2;

  class RuleError extends Error {
    constructor(code, vars) { super(code); this.code = code; this.vars = vars || {}; }
  }
  const fail = (code, vars) => { throw new RuleError(code, vars); };
  const clone = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

  function integer(v, min, max) {
    if (v === '' || v === null || v === undefined) fail('E_INT', { min, max });
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) fail('E_INT', { min, max });
    return n;
  }
  const text = (v, max = 300) => String(v ?? '').trim().slice(0, max);
  const who = v => { const n = Number(v); if (n !== 0 && n !== 1) fail('E_PLAYER'); return n; };

  // Unbiased random integer in [0, n) using rejection sampling on crypto random values.
  function randomInt(n) {
    const c = root.crypto;
    if (!c || !c.getRandomValues) fail('E_NO_CRYPTO');
    const limit = Math.floor(0x100000000 / n) * n, buf = new Uint32Array(1);
    let x;
    do { c.getRandomValues(buf); x = buf[0]; } while (x >= limit);
    return x % n;
  }
  function shuffle(list, rand = randomInt) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  // Command timing text -> phase windows. Used only to list *timing candidates*, never to
  // decide that a card's conditions are met.
  function timingWindows(timingEn) {
    const s = String(timingEn || '');
    const whose = /\benemy\b/i.test(s) ? 'enemy' : /\b(your)\b/i.test(s) ? 'own' : 'any';
    const phases = [];
    if (/hero phase/i.test(s)) phases.push('hero');
    if (/movement phase/i.test(s) || /RETREAT/.test(s)) phases.push('movement');
    if (/SHOOT/.test(s)) phases.push('shooting');
    if (/ATTACK/.test(s)) phases.push('shooting', 'combat');
    if (/charge phase/i.test(s) || /CHARGE/.test(s)) phases.push('charge');
    if (/combat phase/i.test(s)) phases.push('combat');
    if (/end of (either|your|the) turn/i.test(s)) phases.push('end');
    return { whose, phases: [...new Set(phases)], reaction: /^Reaction/i.test(s) };
  }

  function create(data) {
    if (!data || !Array.isArray(data.packs)) throw new Error('card data missing');
    const packs = {}, cards = {};
    for (const p of data.packs) {
      packs[p.id] = p;
      for (const c of [...p.tactics, ...p.twists]) cards[c.id] = { ...c, packId: p.id };
    }
    const pack = id => packs[id] || fail('E_PACK');
    const card = id => cards[id] || fail('E_CARD', { id });

    /* ---------- setup ---------- */
    function setupSteps(g) {
      const c = g.config, s = ['players', 'rolloff', 'roles', 'atkRegiment', 'atkEnhancement', 'defRegiment', 'defEnhancement', 'realm', 'deployment'];
      if (c.pack === 'fire') s.push('terrainDef', 'terrainAtk');
      if (c.pack === 'sand') { if (c.realm === 'ossia') s.push('crypt'); s.push('terrainGroupDef', 'terrainGroupAtk'); }
      if (c.pack === 'ash') s.push('fortifyDef', 'fortifyAtk', 'relicDef', 'relicAtk');
      s.push('deployAtk', 'deployDef', 'deployAbilities', 'decks', 'summary');
      return s;
    }

    // play: 'shared' (one device, both players), 'solo' (this device tracks only player g.me),
    // 'linked' (two devices share one synced game; each device shows its own seat).
    function newGame({ id, now, pack: packId, players, play = 'shared' }) {
      if (!['shared', 'solo', 'linked'].includes(play)) fail('E_PLAY');
      pack(packId);
      const ps = [0, 1].map(i => {
        const p = players?.[i] || {};
        return { name: text(p.name, 40), faction: text(p.faction, 80), army: text(p.army, 100), regiment: '', enhancement: '' };
      });
      if (ps.some(p => !p.name || !p.faction || !p.army)) fail('E_PLAYERS_REQUIRED');
      return {
        schema: SCHEMA, id, created: now, rev: 0, status: 'setup', stage: 'setup', play, me: play === 'solo' ? 0 : null,
        config: { pack: packId, realm: null, players: ps, rolloff: null, attacker: null,
          deployment: { map: '', territories: '' }, terrain: {}, relics: null },
        setup: { step: 'rolloff', log: { players: 'done' } },
        decks: null, rounds: [], turn: null, features: [], notes: '', finished: null
      };
    }

    const defender = g => 1 - g.config.attacker;
    // In solo play the opponent's cards live on the opponent's own device.
    const isUntracked = (g, p) => g.play === 'solo' && p !== g.me;
    function needStep(g, step) {
      if (g.stage !== 'setup') fail('E_STAGE');
      if (g.setup.step !== step) fail('E_STEP');
    }
    function advance(g, status = 'done') {
      const steps = setupSteps(g), i = steps.indexOf(g.setup.step);
      g.setup.log[g.setup.step] = status;
      g.setup.step = steps[i + 1];
    }

    function setupAction(g, step, v = {}) {
      needStep(g, step);
      const c = g.config;
      switch (step) {
        case 'rolloff': {
          if (v.rolls) {
            const a = integer(v.rolls[0], 1, 6), b = integer(v.rolls[1], 1, 6);
            if (a === b) fail('E_ROLL_TIE');
            c.rolloff = { winner: a > b ? 0 : 1, rolls: [a, b] };
          } else c.rolloff = { winner: who(v.winner), rolls: null };
          break;
        }
        case 'roles': {
          if (v.choice !== 'attacker' && v.choice !== 'defender') fail('E_REQUIRED');
          c.attacker = v.choice === 'attacker' ? c.rolloff.winner : 1 - c.rolloff.winner;
          c.rolloff.choice = v.choice;
          break;
        }
        case 'atkRegiment': case 'defRegiment': case 'atkEnhancement': case 'defEnhancement': {
          const p = step.startsWith('atk') ? c.attacker : defender(g);
          const value = text(v.value, 120);
          if (!value && !(v.status === 'none' && isUntracked(g, p))) fail('E_REQUIRED');
          c.players[p][step.endsWith('Regiment') ? 'regiment' : 'enhancement'] = value;
          break;
        }
        case 'realm': {
          if (!pack(c.pack).realms.some(r => r.id === v.realm)) fail('E_REALM');
          c.realm = v.realm;
          break;
        }
        case 'deployment': {
          const map = text(v.map, 150); if (!map) fail('E_REQUIRED');
          c.deployment = { map, territories: text(v.territories, 300) };
          break;
        }
        case 'terrainGroupDef': {
          if (v.group !== 'A' && v.group !== 'B') fail('E_REQUIRED');
          c.terrain.groups = { [defender(g)]: v.group, [c.attacker]: v.group === 'A' ? 'B' : 'A' };
          c.terrain.terrainGroupDef = text(v.note, 300);
          break;
        }
        case 'relicDef': {
          const start = pack('ash').relicSetup.startingRelics[c.realm];
          if (!start.includes(v.relic)) fail('E_REQUIRED');
          const other = start.find(r => r !== v.relic);
          c.relics = { [defender(g)]: v.relic, [c.attacker]: other };
          g.features = start.map(id => ({ id, owner: id === v.relic ? defender(g) : c.attacker, round: 0, placedBy: 'setup', removed: false }));
          break;
        }
        case 'decks': buildDecks(g, v.rand); break;
        case 'summary': g.stage = 'roundStart'; g.status = 'playing'; break;
        default: // terrainDef, terrainAtk, crypt, terrainGroupAtk, fortifyDef, fortifyAtk, relicAtk, deployAtk, deployDef, deployAbilities
          if (v.status === 'none' && step !== 'deployAbilities') fail('E_REQUIRED_STEP');
          c.terrain[step] = text(v.note, 500);
          if (step === 'crypt') addFeatures(g, ['crypt-of-blood'], 0, 'setup');
      }
      if (step === 'summary') { g.setup.log.summary = 'done'; g.setup.step = 'done'; }
      else advance(g, v.status === 'none' ? 'none' : 'done');
    }

    // "Previous step" while still in setup. Values stay filled in; decks lock the setup.
    function setupBack(g) {
      if (g.stage !== 'setup') fail('E_STAGE');
      if (g.decks) fail('E_DECKS_LOCKED');
      const steps = setupSteps(g), i = steps.indexOf(g.setup.step);
      if (i <= 1) fail('E_STEP');
      g.setup.step = steps[i - 1];
    }

    // Quick tracker: everything in one form. Continues an existing guided setup if any.
    function quickSetup(g, v) {
      if (g.stage !== 'setup') fail('E_STAGE');
      const c = g.config;
      const players = [0, 1].map(i => ({
        name: text(v.players[i].name, 40), faction: text(v.players[i].faction, 80), army: text(v.players[i].army, 100),
        regiment: text(v.players[i].regiment, 120), enhancement: text(v.players[i].enhancement, 120)
      }));
      if (players.some(p => !p.name || !p.faction || !p.army)) fail('E_PLAYERS_REQUIRED');
      if (g.decks && (v.pack !== c.pack || v.realm !== c.realm)) fail('E_DECKS_LOCKED');
      pack(v.pack);
      if (!pack(v.pack).realms.some(r => r.id === v.realm)) fail('E_REALM');
      c.pack = v.pack; c.realm = v.realm; c.players = players;
      c.attacker = who(v.attacker);
      c.rolloff = v.rolloffWinner === 0 || v.rolloffWinner === 1 ? { winner: v.rolloffWinner, rolls: null } : c.rolloff;
      c.deployment = { map: text(v.map, 150), territories: text(v.territories, 300) };
      if (c.pack === 'sand') {
        const grp = v.group === 'B' ? 'B' : 'A';
        c.terrain.groups = { [1 - c.attacker]: grp, [c.attacker]: grp === 'A' ? 'B' : 'A' };
      }
      g.features = [];
      if (c.pack === 'sand' && c.realm === 'ossia') g.features.push({ id: 'crypt-of-blood', owner: null, round: 0, placedBy: 'setup', removed: false });
      if (c.pack === 'ash') {
        const start = pack('ash').relicSetup.startingRelics[c.realm];
        const mine = start.includes(v.relic) ? v.relic : start[0];
        c.relics = { [1 - c.attacker]: mine, [c.attacker]: start.find(r => r !== mine) };
        g.features = start.map(id => ({ id, owner: id === mine ? 1 - c.attacker : c.attacker, round: 0, placedBy: 'setup', removed: false }));
      }
      for (const s of setupSteps(g)) if (!g.setup.log[s]) g.setup.log[s] = 'quick';
      if (!g.decks) buildDecks(g, v.rand);
      g.setup.step = 'done'; g.stage = 'roundStart'; g.status = 'playing';
    }

    function buildDecks(g, rand) {
      if (g.decks) fail('E_DECKS_LOCKED');
      const p = pack(g.config.pack), m = p.deckManifest;
      const twistIds = m.twistsByRealm[g.config.realm];
      if (!twistIds) fail('E_REALM');
      g.decks = {
        players: [0, 1].map(p => (isUntracked(g, p) ? null : { draw: shuffle(m.tacticsPerPlayer, rand), hand: [], out: [] })),
        twist: { draw: shuffle(twistIds, rand), active: null, used: [] },
        realm: g.config.realm, pack: g.config.pack
      };
    }

    /* ---------- scores ---------- */
    const turnTotal = t => (t ? t.total : 0);
    function totals(g) {
      return g.rounds.reduce((s, r) => s.map((v, i) => v + turnTotal(r.turns[i]) + (r.closed ? r.bonus[i] : 0)), [0, 0]);
    }
    const underdogOf = s => (s[0] === s[1] ? null : s[0] < s[1] ? 0 : 1);
    function objectiveScore(own, enemy) { return Number(own >= 1) + Number(own >= 2) + Number(own > enemy); }

    /* ---------- round start ---------- */
    function beginRound(g, v) {
      if (g.stage !== 'roundStart' || g.rounds.length >= 4) fail('E_STAGE');
      const number = g.rounds.length + 1, prev = g.rounds.at(-1) || null;
      const first = who(v.first);
      let priorityWinner = null, tie = false, decider;
      if (number === 1) decider = g.config.attacker;
      else if (v.tie) { tie = true; decider = prev.first; }
      else { priorityWinner = who(v.priorityWinner); decider = priorityWinner; }
      const before = totals(g), underdog = underdogOf(before), gap = Math.abs(before[0] - before[1]);
      // Seizing the initiative: last round's second player won priority and chose to go first.
      const seized = !!prev && !tie && priorityWinner === first && prev.first !== first;
      const exception = seized && underdog === first && gap >= 5;
      const blocked = [0, 1].map(p => seized && p === first && !exception);
      g.rounds.push({
        number, priorityWinner, tie, decider, first, before, underdog, gap, seized, exception, blocked,
        step: 'underdog', twist: null, twistNote: '', hands: [0, 1].map(p => (isUntracked(g, p) ? { discarded: [], drawn: [], untracked: true } : { discarded: null, drawn: null })),
        abilities: null, abilitiesNote: '', turns: [null, null], bonus: [0, 0], bonusNote: '', closed: false
      });
      g.stage = 'roundPrep';
    }
    const round = g => g.rounds.at(-1);
    function needPrep(g) { if (g.stage !== 'roundPrep') fail('E_STAGE'); return round(g); }

    function ackUnderdog(g) { const r = needPrep(g); if (r.step !== 'underdog') fail('E_STEP'); r.step = 'twist'; }

    function revealTwist(g, v) {
      const r = needPrep(g);
      if (r.step !== 'underdog' && r.step !== 'twist') fail('E_STEP');
      if (r.twist) fail('E_ALREADY');
      const deck = g.decks.twist;
      if (!deck.draw.length) fail('E_DECK_EMPTY');
      if (v && v.id) { // the card was drawn on the opponent's device: remove that card from this device's twist deck
        if (g.play !== 'solo' || !deck.draw.includes(v.id)) fail('E_CARD', { id: v.id });
        deck.draw.splice(deck.draw.indexOf(v.id), 1);
        r.twist = v.id;
      } else r.twist = deck.draw.shift();
      deck.active = r.twist;
      r.step = 'twistResolve';
    }
    function resolveTwist(g, v = {}) {
      const r = needPrep(g);
      if (r.step !== 'twistResolve') fail('E_STEP');
      r.twistNote = text(v.note, 1000);
      addFeatures(g, v.features, r.number, 'twist');
      r.step = 'hands';
    }
    function addFeatures(g, ids, roundNo, by) {
      for (const id of ids || []) if (!g.features.some(f => f.id === id && !f.removed)) g.features.push({ id, owner: null, round: roundNo, placedBy: by, removed: false });
    }
    function toggleFeature(g, v) {
      const f = g.features.find(f => f.id === v.id && !f.removed);
      if (f) f.removed = true; else addFeatures(g, [v.id], g.rounds.length, 'manual');
    }

    function needHandWindow(g, p) {
      const r = needPrep(g);
      if (!g.decks.players[p]) fail('E_UNTRACKED');
      if (!r.twist) fail('E_TWIST_FIRST');
      if (r.step !== 'twistResolve' && r.step !== 'hands') fail('E_STEP');
      return r;
    }
    function confirmDiscard(g, v) {
      const p = who(v.player), r = needHandWindow(g, p), h = r.hands[p], deck = g.decks.players[p];
      if (h.discarded !== null) fail('E_ALREADY');
      const ids = [...new Set(v.ids || [])];
      if (ids.length !== (v.ids || []).length || ids.some(id => !deck.hand.includes(id))) fail('E_CARD_NOT_IN_HAND');
      for (const id of ids) {
        deck.hand.splice(deck.hand.indexOf(id), 1);
        deck.out.push({ id, status: 'discarded', round: r.number });
      }
      h.discarded = ids;
    }
    function drawHand(g, v) {
      const p = who(v.player), r = needHandWindow(g, p), h = r.hands[p], deck = g.decks.players[p];
      if (h.discarded === null) {
        if (deck.hand.length) fail('E_DISCARD_FIRST');
        h.discarded = [];
      }
      if (h.drawn !== null) fail('E_ALREADY');
      if (r.blocked[p]) { h.drawn = []; return; }
      const need = Math.max(0, 3 - deck.hand.length), got = deck.draw.splice(0, need);
      deck.hand.push(...got);
      h.drawn = got;
    }
    const handDone = (r, p) => r.hands[p].discarded !== null && r.hands[p].drawn !== null;

    // Ends round preparation and starts the first player's turn.
    function startTurns(g, v = {}) {
      const r = needPrep(g);
      if (!r.twist) fail('E_TWIST_FIRST');
      if (![0, 1].every(p => handDone(r, p))) fail('E_HANDS_FIRST');
      if (r.step === 'twistResolve') { r.twistNote = text(v.twistNote ?? r.twistNote, 1000); addFeatures(g, v.features, r.number, 'twist'); }
      const status = v.abilities === 'done' || v.abilities === 'none' ? v.abilities : 'unrecorded';
      r.abilities = status; r.abilitiesNote = text(v.note, 500);
      r.step = 'turns';
      g.stage = 'turn';
      g.turn = newTurn(r.first, v.tracked);
    }
    const newTurn = (player, tracked) => ({ player, phase: tracked ? 0 : null, log: PHASES.map(() => null), afterScore: false });

    /* ---------- turn ---------- */
    function needTurn(g) { if (g.stage !== 'turn' || !g.turn) fail('E_STAGE'); return g.turn; }
    function setPhase(g, v) {
      const t = needTurn(g); if (t.afterScore) fail('E_STEP');
      const idx = integer(v.phase, 0, PHASES.length - 1);
      if (t.phase !== null && idx < t.phase) fail('E_STEP');
      for (let i = 0; i < idx; i++) if (!t.log[i]) t.log[i] = 'unrecorded';
      t.phase = idx;
    }
    function completePhase(g, v = {}) {
      const t = needTurn(g);
      if (t.phase === null || t.afterScore) fail('E_STEP');
      if (t.phase >= PHASES.length - 1) fail('E_STEP'); // end phase closes with endTurn
      if (v.phase !== undefined && v.phase !== t.phase) fail('E_STALE');
      t.log[t.phase] = v.status === 'none' ? 'none' : 'done';
      t.phase++;
    }
    function useCommand(g, v) {
      const t = needTurn(g), p = who(v.player), deck = g.decks.players[p];
      if (!deck) fail('E_UNTRACKED');
      if (!deck.hand.includes(v.id)) fail('E_CARD_NOT_IN_HAND');
      deck.hand.splice(deck.hand.indexOf(v.id), 1);
      deck.out.push({ id: v.id, status: 'command', round: g.rounds.length, turnOf: t.player, phase: t.phase === null ? null : PHASES[t.phase] });
    }

    function scoreTurn(v, tacticIds) {
      const own = integer(v.own, 0, 20), enemy = integer(v.enemy, 0, 20);
      const tactics = tacticIds.reduce((s, id) => s + (card(id).score?.vp ?? 1), 0);
      const twistVp = integer(v.twistVp ?? 0, 0, 20), extra = integer(v.extra ?? 0, -20, 20);
      const objective = objectiveScore(own, enemy);
      return { own, enemy, objective, tactics, twistVp, extra, total: objective + tactics + twistVp + extra };
    }
    function previewTurn(v) { return scoreTurn(v, v.ids || []); }

    function endTurn(g, v) {
      const t = needTurn(g); if (t.afterScore) fail('E_ALREADY');
      const r = round(g), p = t.player, deck = g.decks.players[p];
      if (r.turns[p]) fail('E_ALREADY');
      if (!deck) { // solo play: the opponent scored on their own device and reports the total
        const total = integer(v.manualTotal, 0, 30);
        if (totals(g)[p] + total < 0) fail('E_NEGATIVE');
        t.log = t.log.map(x => x || 'unrecorded');
        r.turns[p] = { manual: true, own: null, enemy: null, objective: 0, tactics: 0, twistVp: 0, extra: 0, total, ids: [], reason: text(v.reason, 500), twistId: null, phaseLog: t.log.slice() };
        if (v.afterScore) t.afterScore = true; else nextTurn(g, v.tracked);
        return;
      }
      const ids = v.ids || [];
      if (new Set(ids).size !== ids.length || ids.some(id => !deck.hand.includes(id))) fail('E_CARD_NOT_IN_HAND');
      const s = scoreTurn(v, ids);
      const reason = text(v.reason, 500);
      if (s.extra && !reason) fail('E_REASON');
      if (s.total < 0) fail('E_NEGATIVE');
      if (totals(g)[p] + s.total < 0) fail('E_NEGATIVE');
      for (const id of ids) {
        deck.hand.splice(deck.hand.indexOf(id), 1);
        deck.out.push({ id, status: 'scored', round: r.number });
      }
      t.log = t.log.map((x, i) => x || (i === PHASES.length - 1 ? 'done' : 'unrecorded'));
      r.turns[p] = { ...s, ids, reason, twistId: s.twistVp ? r.twist : null, phaseLog: t.log.slice() };
      if (v.afterScore) t.afterScore = true; else nextTurn(g, v.tracked);
    }
    function ackAfterScore(g, v = {}) {
      const t = needTurn(g); if (!t.afterScore) fail('E_STEP');
      nextTurn(g, v.tracked);
    }
    function nextTurn(g, tracked) {
      const r = round(g), other = 1 - r.first;
      if (!r.turns[other]) g.turn = newTurn(other, tracked);
      else { g.turn = null; g.stage = 'roundEnd'; }
    }

    /* ---------- round end / result ---------- */
    function closeRound(g, v) {
      if (g.stage !== 'roundEnd') fail('E_STAGE');
      const r = round(g), bonus = [integer(v.bonus?.[0] ?? 0, -20, 20), integer(v.bonus?.[1] ?? 0, -20, 20)];
      const note = text(v.note, 500);
      if (bonus.some(Boolean) && !note) fail('E_REASON');
      const t = totals(g);
      if (t.some((x, i) => x + bonus[i] < 0)) fail('E_NEGATIVE');
      Object.assign(r, { bonus, bonusNote: note, closed: true });
      g.decks.twist.used.push(r.twist); g.decks.twist.active = null;
      if (r.number === 4) { g.stage = 'finished'; g.status = 'finished'; g.finished = v.now || new Date().toISOString(); }
      else g.stage = 'roundStart';
    }
    function result(g) {
      if (g.status !== 'finished') return null;
      const s = totals(g);
      return { scores: s, winner: s[0] === s[1] ? null : s[0] > s[1] ? 0 : 1 };
    }

    const actions = {
      setupAction: (g, v) => setupAction(g, v.step, v), setupBack, quickSetup,
      beginRound, ackUnderdog, revealTwist, resolveTwist, toggleFeature, confirmDiscard, drawHand, startTurns,
      setPhase, completePhase, useCommand, endTurn, ackAfterScore, closeRound
    };
    return {
      PHASES, SCHEMA, data, packs, cards, pack, card, setupSteps, newGame, actions,
      totals, underdogOf, objectiveScore, previewTurn, handDone, result, round, timingWindows, isUntracked
    };
  }

  const api = { create, RuleError, clone, shuffle, randomInt, integer, timingWindows, PHASES, SCHEMA };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Engine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
