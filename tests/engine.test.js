'use strict';
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../dist/engine.js');
const Store = require('../dist/store.js');
const data = require('../data/spearhead-cards.en-ko.json');
const E = Engine.create(data);

const REALMS = { fire: ['aqshy', 'ghyran'], sand: ['ossia', 'dolorum'], ash: ['shattered-crossroads', 'ashen-bastion'] };
const players = [{ name: 'A', faction: 'Stormcast Eternals', army: 'Vigilant Brotherhood' }, { name: 'B', faction: 'Skaven', army: 'Gnawfeast Clawpack' }];

function memoryStorage() { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), map: m }; }
function newStore(storage = memoryStorage()) { let n = 0; const s = Store.create({ engine: E, storage, uuid: () => 'g' + (++n) }); s.load(); return s; }

function quickGame(pack = 'fire', realm = REALMS[pack][0], attacker = 0, store = newStore()) {
  store.startGame({ pack, players });
  store.dispatch('quickSetup', { pack, realm, attacker, players: players.map(p => ({ ...p, regiment: 'R', enhancement: 'E' })), map: 'Map 1', group: 'A', relic: null });
  return store;
}
// Plays round start (priority -> twist -> hands) with no discards.
function startRound(s, first, priority) {
  const d = s.db.game.rounds.length ? (priority === 'tie' ? { first, tie: true } : { first, priorityWinner: priority ?? first }) : { first };
  s.dispatch('beginRound', d);
  s.dispatch('revealTwist');
  for (const p of [0, 1]) { s.dispatch('confirmDiscard', { player: p, ids: [] }); s.dispatch('drawHand', { player: p }); }
  s.dispatch('startTurns', { abilities: 'none' });
}
// Scores `vp` points of objectives/extra for the given player turn (objective only, simplest).
function playTurn(s, extra = 0, own = 0, enemy = 0) {
  s.dispatch('endTurn', { own, enemy, ids: [], extra, reason: extra ? 'test' : '' });
}
function playRound(s, first, priority, pts = [0, 0], bonus = [0, 0]) {
  startRound(s, first, priority);
  const r = s.db.game.rounds.at(-1);
  playTurn(s, pts[r.first]); playTurn(s, pts[1 - r.first]);
  s.dispatch('closeRound', { bonus, note: bonus.some(Boolean) ? 'bonus' : '' });
}

test('card data: every pack/realm builds 2 independent 12-card tactic decks and the right 6-card twist deck', () => {
  for (const [pack, realms] of Object.entries(REALMS)) for (const realm of realms) {
    const s = quickGame(pack, realm), d = s.db.game.decks;
    for (const p of [0, 1]) {
      assert.equal(d.players[p].draw.length, 12);
      assert.deepEqual([...d.players[p].draw].sort(), [...E.pack(pack).deckManifest.tacticsPerPlayer].sort());
    }
    assert.equal(d.twist.draw.length, 6);
    assert.ok(d.twist.draw.every(id => E.card(id).realmId === realm), `${pack}/${realm} twist realm`);
  }
});

test('shuffle is Fisher-Yates and unbiased enough (chi-square smoke check)', () => {
  const counts = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  for (let i = 0; i < 8000; i++) Engine.shuffle([0, 1, 2, 3]).forEach((v, pos) => counts[v][pos]++);
  for (const row of counts) for (const c of row) assert.ok(c > 1700 && c < 2300, 'position frequency ' + c);
});

test('round 1: 3 cards each, drawn from own deck, no duplicates; round 2 refills to 3', () => {
  const s = quickGame('sand', 'ossia');
  startRound(s, 0);
  const g = s.db.game;
  for (const p of [0, 1]) { assert.equal(g.decks.players[p].hand.length, 3); assert.equal(g.decks.players[p].draw.length, 9); }
  // Player 0 scores one tactic this turn.
  const scoredId = g.decks.players[0].hand[0];
  s.dispatch('endTurn', { own: 1, enemy: 0, ids: [scoredId] });
  assert.equal(s.db.game.rounds[0].turns[0].total, 3); // 1+0+1 objective (more than enemy) + 1 tactic
  playTurn(s);
  s.dispatch('closeRound', { bonus: [0, 0] });
  s.dispatch('beginRound', { first: 0, priorityWinner: 0 });
  s.dispatch('revealTwist');
  s.dispatch('confirmDiscard', { player: 0, ids: [] });
  s.dispatch('drawHand', { player: 0 });
  assert.equal(s.db.game.rounds[1].hands[0].drawn.length, 1, 'holding 2 -> draw only 1');
  assert.equal(s.db.game.decks.players[0].hand.length, 3);
  const all = [...s.db.game.decks.players[0].hand, ...s.db.game.decks.players[0].draw, ...s.db.game.decks.players[0].out.map(o => o.id)];
  assert.equal(new Set(all).size, 12, 'no card duplicated or lost');
});

test('discard must be confirmed before drawing, and cannot be repeated after seeing new cards', () => {
  const s = quickGame();
  playRound(s, 0);
  s.dispatch('beginRound', { first: 0, priorityWinner: 0 });
  assert.throws(() => s.dispatch('drawHand', { player: 0 }), { code: 'E_TWIST_FIRST' });
  s.dispatch('revealTwist');
  assert.throws(() => s.dispatch('drawHand', { player: 0 }), { code: 'E_DISCARD_FIRST' });
  const h = s.db.game.decks.players[0].hand.slice();
  s.dispatch('confirmDiscard', { player: 0, ids: [h[0]] });
  assert.throws(() => s.dispatch('confirmDiscard', { player: 0, ids: [h[1]] }), { code: 'E_ALREADY' });
  s.dispatch('drawHand', { player: 0 });
  assert.throws(() => s.dispatch('drawHand', { player: 0 }), { code: 'E_ALREADY' });
  assert.equal(s.db.game.decks.players[0].hand.length, 3);
  assert.deepEqual(s.db.game.decks.players[0].out.map(o => o.status), ['discarded']);
});

// ---- underdog / seize the initiative (mirrors the 30 audit scenarios for each pack) ----
function seizeCase(pack, gap, seizerBehind) {
  // Round 1: A goes first. Points make B (the round-1 second player) behind/ahead by `gap`.
  const s = quickGame(pack);
  playRound(s, 0, undefined, seizerBehind ? [gap, 0] : [0, gap]);
  s.dispatch('beginRound', { first: 1, priorityWinner: 1 }); // B won priority and takes first turn
  return s.db.game.rounds[1];
}
for (const pack of Object.keys(REALMS)) {
  test(`${pack}: underdog / seize / 5-point exception table`, () => {
    let r;
    const s0 = quickGame(pack); playRound(s0, 0); s0.dispatch('beginRound', { first: 0, priorityWinner: 0 });
    r = s0.db.game.rounds[1]; assert.equal(r.underdog, null); assert.equal(r.seized, false); assert.deepEqual(r.blocked, [false, false]);
    for (const [gap, blocked] of [[1, true], [4, true], [5, false], [6, false]]) {
      r = seizeCase(pack, gap, true);
      assert.equal(r.underdog, 1, `gap ${gap} underdog`); assert.equal(r.seized, true); assert.equal(r.blocked[1], blocked, `gap ${gap} blocked`); assert.equal(r.blocked[0], false);
    }
    r = seizeCase(pack, 5, false); assert.equal(r.underdog, 0); assert.equal(r.blocked[1], true, 'leader seizing is blocked');
    r = seizeCase(pack, 0, true); assert.equal(r.underdog, null); assert.equal(r.blocked[1], true, 'tie seizing is blocked');
    // A wins priority and hands the first turn to B: consecutive turns for B but no seize.
    const s1 = quickGame(pack); playRound(s1, 0, undefined, [4, 0]); s1.dispatch('beginRound', { first: 1, priorityWinner: 0 });
    r = s1.db.game.rounds[1]; assert.equal(r.seized, false); assert.deepEqual(r.blocked, [false, false]);
    // Priority tie: previous first player decides; giving it away is not a seize.
    const s2 = quickGame(pack); playRound(s2, 0); s2.dispatch('beginRound', { first: 1, tie: true });
    r = s2.db.game.rounds[1]; assert.equal(r.decider, 0); assert.equal(r.seized, false);
    // Underdog stays fixed within the round even after overtaking.
    const s3 = quickGame(pack); playRound(s3, 0, undefined, [0, 3]); startRound(s3, 0, 0);
    playTurn(s3, 5); assert.deepEqual(E.totals(s3.db.game), [5, 3]); assert.equal(s3.db.game.rounds[1].underdog, 0);
    // Round-end bonus counts before the next underdog check; a tie clears the underdog.
    const s4 = quickGame(pack); playRound(s4, 0, undefined, [2, 0], [0, 2]); s4.dispatch('beginRound', { first: 0, priorityWinner: 0 });
    assert.deepEqual(s4.db.game.rounds[1].before, [2, 2]); assert.equal(s4.db.game.rounds[1].underdog, null);
  });
}

test('blocked seizer keeps and can use existing hand but draws nothing', () => {
  const s = quickGame();
  playRound(s, 0, undefined, [3, 0]);
  s.dispatch('beginRound', { first: 1, priorityWinner: 1 });
  s.dispatch('revealTwist');
  s.dispatch('confirmDiscard', { player: 1, ids: [] });
  s.dispatch('drawHand', { player: 1 });
  assert.deepEqual(s.db.game.rounds[1].hands[1].drawn, []);
  assert.equal(s.db.game.decks.players[1].hand.length, 3);
});

test('command-used card cannot also score; score confirmation cannot run twice', () => {
  const s = quickGame(); startRound(s, 0);
  const g = s.db.game, id = g.decks.players[0].hand[0];
  s.dispatch('useCommand', { player: 0, id });
  assert.throws(() => s.dispatch('endTurn', { own: 0, enemy: 0, ids: [id] }), { code: 'E_CARD_NOT_IN_HAND' });
  assert.throws(() => s.dispatch('useCommand', { player: 0, id }), { code: 'E_CARD_NOT_IN_HAND' });
  // Opponent can use a command during this turn as well.
  s.dispatch('useCommand', { player: 1, id: s.db.game.decks.players[1].hand[0] });
  const rev = s.db.game.rev;
  s.dispatch('endTurn', { own: 0, enemy: 0, ids: [] }, rev);
  assert.throws(() => s.dispatch('endTurn', { own: 0, enemy: 0, ids: [] }, rev), { code: 'E_STALE' });
  assert.equal(s.db.game.turn.player, 1);
});

test('objective scoring 0:0, 1:1, 2:1 plus twist and extra points', () => {
  const t = v => E.previewTurn(v).total;
  assert.equal(t({ own: 0, enemy: 0 }), 0);
  assert.equal(t({ own: 1, enemy: 1 }), 1);
  assert.equal(t({ own: 2, enemy: 1 }), 3);
  assert.equal(t({ own: 1, enemy: 0 }), 2);
  assert.equal(t({ own: 2, enemy: 1, twistVp: 2, extra: 1 }), 6);
  const s = quickGame(); startRound(s, 0);
  assert.throws(() => s.dispatch('endTurn', { own: 0, enemy: 0, ids: [], extra: 1, reason: '' }), { code: 'E_REASON' });
  assert.equal(s.db.game.stage, 'turn', 'failed action leaves state untouched');
});

test('no early result: 8 turns + round-4 end bonus decide the winner; ties are draws; history saved once', () => {
  const s = quickGame('ash', 'ashen-bastion');
  playRound(s, 0, undefined, [3, 2]);
  playRound(s, 0, 0, [3, 2]);
  playRound(s, 1, 1, [0, 4]); // 6:4 -> B (behind by 2) seizes: no refill; round ends 6:8
  assert.equal(s.db.game.status, 'playing');
  startRound(s, 0, 0);
  playTurn(s, 1);
  assert.equal(s.db.game.stage, 'turn', 'game continues until both players finish round 4');
  assert.equal(s.db.history.length, 0);
  playTurn(s, 0);
  assert.equal(s.db.game.stage, 'roundEnd');
  const [a, b] = E.totals(s.db.game);
  s.dispatch('closeRound', { bonus: [0, a - b], note: 'twist round end' });
  assert.equal(s.db.game.status, 'finished');
  assert.equal(E.result(s.db.game).winner, null, 'tie is a draw');
  assert.equal(s.db.history.length, 1);
  s.undo();
  assert.equal(s.db.history.length, 0, 'undoing the final close removes the record');
  s.dispatch('closeRound', { bonus: [0, 0] });
  assert.equal(s.db.history.length, 1);
  assert.equal(E.result(s.db.game).winner, 1, '7:8 without the bonus');
  assert.throws(() => s.dispatch('beginRound', { first: 0 }), { code: 'E_STAGE' });
});

test('undo restores deck order: redrawing gives the same cards; reload keeps everything', () => {
  const storage = memoryStorage();
  const s = quickGame('fire', 'ghyran', 1, newStore(storage));
  s.dispatch('beginRound', { first: 1 });
  s.dispatch('revealTwist');
  const twist = s.db.game.rounds[0].twist;
  s.dispatch('drawHand', { player: 0 });
  const hand = s.db.game.decks.players[0].hand.slice();
  s.undo(); s.undo();
  assert.equal(s.db.game.rounds[0].twist, null);
  s.dispatch('revealTwist');
  s.dispatch('drawHand', { player: 0 });
  assert.equal(s.db.game.rounds[0].twist, twist);
  assert.deepEqual(s.db.game.decks.players[0].hand, hand);
  const s2 = newStore(storage);
  assert.deepEqual(s2.db.game, s.db.game, 'reload restores identical state');
  assert.equal(s2.db.undo.length, s.db.undo.length);
});

test('corrupt storage is preserved under a backup key, not overwritten silently', () => {
  const storage = memoryStorage();
  storage.setItem(Store.KEY, '{"schema":2, broken');
  const s = newStore(storage);
  assert.equal(s.db.game, null);
  assert.ok(s.status.corruptKey);
  assert.equal(storage.getItem(s.status.corruptKey), '{"schema":2, broken');
});

test('guided setup order and pack-specific branches', () => {
  const expect = {
    fire: ['terrainDef', 'terrainAtk'],
    sand: ['crypt', 'terrainGroupDef', 'terrainGroupAtk'],
    ash: ['fortifyDef', 'fortifyAtk', 'relicDef', 'relicAtk']
  };
  for (const pack of Object.keys(REALMS)) {
    const s = newStore(); s.startGame({ pack, players });
    const step = v => s.dispatch('setupAction', { step: s.db.game.setup.step, ...v });
    assert.throws(() => step({ rolls: [4, 4] }), { code: 'E_ROLL_TIE' });
    step({ rolls: [2, 5] }); // B wins the roll-off
    step({ choice: 'defender' }); // B chooses to defend -> A attacks
    assert.equal(s.db.game.config.attacker, 0);
    assert.throws(() => step({ value: '' }), { code: 'E_REQUIRED' });
    step({ value: 'A regiment' }); step({ value: 'A enh' }); step({ value: 'B regiment' }); step({ value: 'B enh' });
    assert.equal(s.db.game.config.players[0].regiment, 'A regiment');
    assert.equal(s.db.game.config.players[1].enhancement, 'B enh');
    step({ realm: REALMS[pack][0] });
    step({ map: 'Deployment 1', territories: 'B north' });
    const branch = [];
    while (!['deployAtk'].includes(s.db.game.setup.step)) {
      const cur = s.db.game.setup.step; branch.push(cur);
      if (cur === 'terrainGroupDef') step({ group: 'B' });
      else if (cur === 'relicDef') step({ relic: E.pack('ash').relicSetup.startingRelics['shattered-crossroads'][1] });
      else { assert.throws(() => step({ status: 'none' }), { code: 'E_REQUIRED_STEP' }); step({ note: 'ok' }); }
    }
    assert.deepEqual(branch, expect[pack]);
    if (pack === 'sand') assert.deepEqual(s.db.game.config.terrain.groups, { 0: 'A', 1: 'B' });
    if (pack === 'ash') { assert.equal(s.db.game.config.relics[1], 'crate-of-aqua-ghyranis'); assert.equal(s.db.game.config.relics[0], 'barrel-of-emberstone'); }
    step({ note: 'atk deployed' }); step({ note: 'def deployed' }); step({ status: 'none' });
    assert.equal(s.db.game.decks, null, 'no deck before deck step');
    step({});
    assert.ok(s.db.game.decks);
    assert.throws(() => s.dispatch('setupBack'), { code: 'E_DECKS_LOCKED' });
    step({});
    assert.equal(s.db.game.stage, 'roundStart');
  }
  // Dolorum has no Crypt of Blood step.
  const s = newStore(); s.startGame({ pack: 'sand', players });
  assert.ok(!E.setupSteps({ config: { pack: 'sand', realm: 'dolorum' } }).includes('crypt'));
});

test('turn phases: guided tracking, quick mode leaves phases unrecorded (never fabricated)', () => {
  const s = quickGame(); s.dispatch('beginRound', { first: 0 }); s.dispatch('revealTwist');
  for (const p of [0, 1]) s.dispatch('drawHand', { player: p });
  s.dispatch('startTurns', { tracked: false });
  assert.equal(s.db.game.turn.phase, null);
  s.dispatch('setPhase', { phase: 3 }); // switched to guided: "we are in shooting"
  assert.deepEqual(s.db.game.turn.log.slice(0, 4), ['unrecorded', 'unrecorded', 'unrecorded', null]);
  s.dispatch('completePhase', { status: 'none' });
  assert.equal(s.db.game.turn.phase, 4);
  assert.throws(() => s.dispatch('setPhase', { phase: 1 }), { code: 'E_STEP' });
  s.dispatch('endTurn', { own: 1, enemy: 0, ids: [], afterScore: true, tracked: true });
  assert.equal(s.db.game.turn.afterScore, true, 'after-scoring effects step');
  assert.throws(() => s.dispatch('endTurn', { own: 1, enemy: 0, ids: [] }), { code: 'E_ALREADY' });
  s.dispatch('ackAfterScore', { tracked: true });
  assert.equal(s.db.game.turn.player, 1);
  assert.equal(s.db.game.turn.phase, 0);
  assert.equal(s.db.game.rounds[0].turns[0].phaseLog[3], 'none');
  assert.equal(s.db.game.rounds[0].turns[0].phaseLog[5], 'unrecorded');
  // no second twist / underdog / refill during the second turn
  assert.throws(() => s.dispatch('revealTwist'), { code: 'E_STAGE' });
  assert.throws(() => s.dispatch('drawHand', { player: 1 }), { code: 'E_STAGE' });
});

test('timing candidates are parsed from command timing text', () => {
  assert.deepEqual(Engine.timingWindows('Enemy hero phase'), { whose: 'enemy', phases: ['hero'], reaction: false });
  assert.deepEqual(Engine.timingWindows('Reaction: enemy ATTACK declaration').phases, ['shooting', 'combat']);
  assert.equal(Engine.timingWindows('Reaction: your CHARGE declaration').whose, 'own');
  assert.deepEqual(Engine.timingWindows('End of either turn'), { whose: 'any', phases: ['end'], reaction: false });
  for (const p of data.packs) for (const t of p.tactics) assert.ok(Engine.timingWindows(t.command.timing.en).phases.length, t.command.timing.en);
});
