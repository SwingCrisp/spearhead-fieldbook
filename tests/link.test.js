'use strict';
// Two simulated phones sharing one room through the in-memory transport.
const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../dist/engine.js');
const Store = require('../dist/store.js');
const Link = require('../dist/link.js');
const data = require('../data/spearhead-cards.en-ko.json');
const E = Engine.create(data);

function mem() { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; }
function phone(shared) {
  const store = Store.create({ engine: E, storage: mem() }); store.load();
  const link = Link.create({ store, engine: E, Engine, transport: Link.memoryTransport(shared) });
  return { store, link };
}
const players = [{ name: 'A', faction: 'Seraphon', army: 'Starscale' }, { name: 'B', faction: 'Skaven', army: 'Warpspark' }];

async function linkedPair() {
  const shared = { rooms: {} }, a = phone(shared), b = phone(shared);
  const code = await a.link.createRoom(0);
  await b.link.joinRoom(code.toLowerCase(), 1);
  await a.link.startGame({ pack: 'fire', players });
  await b.link.dispatch('quickSetup', { pack: 'fire', realm: 'aqshy', attacker: 0, players: players.map(p => ({ ...p })), map: 'M' });
  return { a, b, code, shared };
}

test('join validates code and room existence', async () => {
  const shared = { rooms: {} }, b = phone(shared);
  await assert.rejects(b.link.joinRoom('abc'), { code: 'E_ROOM_CODE' });
  await assert.rejects(b.link.joinRoom('ABCDEF'), { code: 'E_ROOM_NOT_FOUND' });
});

test('both phones see the same game, each keeps its own seat and history perspective', async () => {
  const { a, b } = await linkedPair();
  assert.equal(a.store.db.game.stage, 'roundStart');
  assert.deepEqual(a.store.db.game, b.store.db.game);
  assert.equal(a.store.db.link.seat, 0); assert.equal(b.store.db.link.seat, 1);
  // round 1: A picks, each phone handles its own hand
  await a.link.dispatch('beginRound', { first: 0 });
  await b.link.dispatch('revealTwist');
  await a.link.dispatch('drawHand', { player: 0 });
  await b.link.dispatch('drawHand', { player: 1 });
  assert.equal(a.store.db.game.decks.players[1].hand.length, 3);
  await a.link.dispatch('startTurns', { abilities: 'none' });
  await a.link.dispatch('endTurn', { own: 2, enemy: 0, ids: [] });
  await b.link.dispatch('endTurn', { own: 1, enemy: 0, ids: [] });
  assert.deepEqual(E.totals(b.store.db.game), [3, 2]);
});

test('simultaneous presses: only one wins, the other gets a conflict and nothing is applied twice', async () => {
  const { a, b } = await linkedPair();
  const rev = a.store.db.game.rev;
  const r1 = a.link.dispatch('beginRound', { first: 0 }, rev);
  // B pressed based on the same screen before A's change arrived
  const staleB = { ...b.store.db.game };
  await r1;
  assert.equal(b.store.db.game.rounds.length, 1, 'B received A change');
  await assert.rejects(b.link.dispatch('beginRound', { first: 1 }, staleB.rev), { code: 'E_STALE' });
  assert.equal(a.store.db.game.rounds.length, 1);
});

test('shared undo restores deck order on both phones; redraw gives the same cards', async () => {
  const { a, b } = await linkedPair();
  await a.link.dispatch('beginRound', { first: 0 });
  await a.link.dispatch('revealTwist');
  await b.link.dispatch('drawHand', { player: 1 });
  const hand = b.store.db.game.decks.players[1].hand.slice();
  assert.ok(await a.link.undo());
  assert.equal(b.store.db.game.decks.players[1].hand.length, 0);
  await b.link.dispatch('drawHand', { player: 1 });
  assert.deepEqual(b.store.db.game.decks.players[1].hand, hand);
  // undo chain walks back further
  assert.ok(await b.link.undo()); assert.ok(await b.link.undo());
  assert.equal(a.store.db.game.rounds[0].twist, null);
});

test('finished linked game is saved once per phone from that phone\'s seat', async () => {
  const { a, b } = await linkedPair();
  for (let n = 1; n <= 4; n++) {
    await a.link.dispatch('beginRound', n === 1 ? { first: 0 } : { first: 0, priorityWinner: 0 });
    await a.link.dispatch('revealTwist');
    if (n > 1) { await a.link.dispatch('confirmDiscard', { player: 0, ids: [] }); await b.link.dispatch('confirmDiscard', { player: 1, ids: [] }); }
    await a.link.dispatch('drawHand', { player: 0 });
    await b.link.dispatch('drawHand', { player: 1 });
    await a.link.dispatch('startTurns', {});
    await a.link.dispatch('endTurn', { own: 1, enemy: 0, ids: [] });
    await b.link.dispatch('endTurn', { own: 0, enemy: 1, ids: [] });
    await a.link.dispatch('closeRound', { bonus: [0, 0] });
  }
  assert.equal(a.store.db.history.length, 1); assert.equal(b.store.db.history.length, 1);
  assert.equal(a.store.db.history[0].mySeat, 0); assert.equal(b.store.db.history[0].mySeat, 1);
});

test('solo play: only my deck exists, opponent reports a total, twist can be picked from the other phone', () => {
  const store = Store.create({ engine: E, storage: mem() }); store.load();
  store.startGame({ pack: 'ash', players, play: 'solo' });
  store.dispatch('quickSetup', { pack: 'ash', realm: 'ashen-bastion', attacker: 1, players, map: 'M' });
  const g = () => store.db.game;
  assert.equal(g().decks.players[1], null);
  store.dispatch('beginRound', { first: 1 });
  const pick = g().decks.twist.draw[3];
  store.dispatch('revealTwist', { id: pick });
  assert.equal(g().rounds[0].twist, pick); assert.equal(g().decks.twist.draw.length, 5);
  assert.throws(() => store.dispatch('drawHand', { player: 1 }), { code: 'E_UNTRACKED' });
  store.dispatch('drawHand', { player: 0 });
  store.dispatch('startTurns', {});
  assert.throws(() => store.dispatch('endTurn', { own: 1, enemy: 0, ids: [] }), { code: 'E_INT' }, 'opponent needs a total');
  store.dispatch('endTurn', { manualTotal: 4 });
  store.dispatch('endTurn', { own: 2, enemy: 1, ids: [g().decks.players[0].hand[0]] });
  assert.deepEqual(E.totals(g()), [4, 4]);
  // opponent regiment may be left to the other phone in guided setup
  const s2 = Store.create({ engine: E, storage: mem() }); s2.load();
  s2.startGame({ pack: 'fire', players, play: 'solo' });
  const step = v => s2.dispatch('setupAction', { step: s2.db.game.setup.step, ...v });
  step({ winner: 0 }); step({ choice: 'attacker' });
  assert.throws(() => step({ status: 'none', value: '' }), { code: 'E_REQUIRED' }, 'my own regiment is required');
  step({ value: 'mine' }); step({ value: 'mine2' });
  step({ status: 'none', value: '' }); step({ status: 'none', value: '' });
  assert.equal(s2.db.game.setup.step, 'realm');
});
