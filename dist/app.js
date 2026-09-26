/* Spearhead Fieldbook — UI. Guided and quick modes render the same stored game state. */
'use strict';
const DATA = window.SPEARHEAD_CARDS;
const E = Engine.create(DATA);
const params = new URLSearchParams(location.search);
// ?device=2 gives a second independent "phone" in the same browser (development).
const S = Store.create({ engine: E, storage: safeStorage(), keySuffix: (params.get('device') || '').replace(/\W/g, '') });
S.load();
let LK = null, linkStatus = 'offline', busy = false;
const isLinked = () => !!S.db.link?.room;
async function ensureLink() {
  if (LK) return LK;
  const transport = params.get('transport') === 'local' ? Link.localTransport()
    : window.FIREBASE_CONFIG ? await Link.firebaseTransport(window.FIREBASE_CONFIG) : null;
  if (!transport) throw new Engine.RuleError('E_LINK_SETUP');
  LK = Link.create({ store: S, engine: E, Engine, transport, onChange: () => render(), onStatus: st => { linkStatus = st; const el = $('#link-status'); if (el) el.textContent = stripTags(t('room.st.' + st)); } });
  return LK;
}
// Seat of this device: null = one shared device showing both players.
const meOf = g => (!g ? null : g.play === 'solo' ? g.me : g.play === 'linked' ? (S.db.link?.seat ?? 0) : null);

const FACTIONS = ['Stormcast Eternals', 'Skaven', 'Cities of Sigmar', 'Sylvaneth', 'Seraphon', 'Daughters of Khaine', 'Fyreslayers', 'Kharadron Overlords', 'Idoneth Deepkin', 'Lumineth Realm-lords', 'Blades of Khorne', 'Disciples of Tzeentch', 'Hedonites of Slaanesh', 'Maggotkin of Nurgle', 'Slaves to Darkness', 'Flesh-eater Courts', 'Nighthaunt', 'Ossiarch Bonereapers', 'Soulblight Gravelords', 'Gloomspite Gitz', 'Ogor Mawtribes', 'Orruk Warclans', 'Sons of Behemat', 'Helsmiths of Hashut'];
// Special terrain that is placed by setup or twists and has a reference ability in the data.
const SPECIAL = {
  'crypt-of-blood': { name: { en: 'Crypt of Blood', ko: '피의 납골당' }, ability: 'unholy-draught', pack: 'sand' },
  'icon-of-nulahmia': { name: { en: 'Icon of Nulahmia', ko: '눌라미아의 성상' }, ability: 'veiled-promises', pack: 'sand' }
};
const ERRATA_URL = DATA.officialErrata.url;
// Optional army option names (tools/build-cards.js). Used only as suggestions; free text is always allowed.
const ARMY_DATA = window.SPEARHEAD_ARMIES?.factions || [];
const norm = s => String(s || '').trim().toLowerCase();
const factionNames = () => [...new Set([...ARMY_DATA.map(f => f.faction), ...FACTIONS])].sort();
function armyNames(faction) {
  const f = ARMY_DATA.find(x => norm(x.faction) === norm(faction));
  return (f ? f.armies : ARMY_DATA.flatMap(x => x.armies)).map(a => a.name);
}
function findArmy(faction, army) {
  const all = ARMY_DATA.flatMap(f => f.armies.map(a => ({ ...a, faction: f.faction })));
  return all.find(a => norm(a.name) === norm(army) && norm(a.faction) === norm(faction)) || all.find(a => norm(a.name) === norm(army)) || null;
}
const armyOptions = (faction, army, field) => findArmy(faction, army)?.[field === 'regiment' ? 'regimentAbilities' : 'enhancements'] || [];
const dl = (id, list) => `<datalist id="${id}">${list.map(v => `<option value="${esc(v)}">`).join('')}</datalist>`;

let page = 'battle', lastRender = 0, renderedRev = null, toastTimer;
const ui = { reveal: [false, false], cand: [false, false], handView: null, peek: null, catalog: 'fire' };

/* ---------- helpers ---------- */
function safeStorage() {
  try { const k = '__sf_test'; localStorage.setItem(k, k); localStorage.removeItem(k); return localStorage; }
  catch (e) { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; }
}
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lang = () => S.db.prefs.lang, mode = () => S.db.prefs.mode;
// Korean particles after a name: "{name}이(가)" becomes 민수가 / 지훈이 depending on the final consonant.
const JOSA = { '이(가)': ['이', '가'], '은(는)': ['은', '는'], '을(를)': ['을', '를'], '과(와)': ['과', '와'], '(으)로': ['으로', '로'] };
function finalConsonant(word) {
  const ch = String(word).trim().slice(-1), code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) { const jong = (code - 0xac00) % 28; return jong === 0 ? 'none' : jong === 8 ? 'rieul' : 'other'; }
  if (/[0-9]/.test(ch)) return '178'.includes(ch) ? 'rieul' : '036'.includes(ch) ? 'other' : 'none';
  if (/[a-z]/i.test(ch)) return /l/i.test(ch) ? 'rieul' : /[mnr]/i.test(ch) ? 'other' : 'none';
  return null; // unknown ending: keep the combined form
}
function withJosa(word, marker) {
  if (marker === '이(가)' && String(word).trim() === '나') return '내가';
  const f = finalConsonant(word), [withC, withoutC] = JOSA[marker];
  if (f === null) return word + marker;
  if (marker === '(으)로') return word + (f === 'other' ? withC : withoutC);
  return word + (f === 'none' ? withoutC : withC);
}
function t(k, v = {}) {
  const e = window.I18N[k]; if (!e) return esc(k);
  const s = e[lang() === 'en' ? 1 : 0];
  if (typeof s !== 'string') return s;
  return s.replace(/\{(\w+)\}(이\(가\)|은\(는\)|을\(를\)|과\(와\)|\(으\)로)?/g, (_, x, josa) => esc(josa ? withJosa(v[x] ?? '', josa) : v[x] ?? ''));
}
const L = o => (o ? o[lang()] ?? o.en ?? '' : '');
const nm = o => (lang() === 'ko' && o.en !== o.ko ? `${esc(o.ko)} <small class="en" lang="en">${esc(o.en)}</small>` : esc(o.en));
const nameOf = (g, p) => g.config.players[p].name;
const args = o => esc(JSON.stringify(o));
const opt = (list, cur) => list.map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(label)}</option>`).join('');
const PH = E.PHASES;
function toast(s) { const el = $('#toast'); el.innerHTML = s; el.style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.style.display = 'none'), 4500); }
const realmOf = (packId, realmId) => E.pack(packId).realms.find(r => r.id === realmId);
const refById = id => { for (const p of DATA.packs) { const r = p.referenceAbilities.find(r => r.id === id); if (r) return r; } return null; };
const featureName = id => SPECIAL[id]?.name || refById(id)?.name || { en: id, ko: id };
const featureAbility = id => (SPECIAL[id] ? refById(SPECIAL[id].ability) : refById(id));
function placeables(packId) {
  if (packId === 'sand') return Object.keys(SPECIAL);
  return E.pack(packId).referenceAbilities.filter(r => r.kind === 'relic').map(r => r.id);
}
function twistMentions(card, packId) {
  return placeables(packId).filter(id => card.mechanics.en.toLowerCase().includes(featureName(id).en.toLowerCase()));
}
const afterScoreTwist = card => !!card && /after scoring/i.test(card.mechanics.en);

/* ---------- cards ---------- */
// Cards that need checking against the physical card: the unclear point, shown with the standard notice.
const CHECK_POINTS = Object.fromEntries((DATA.issues || []).map(i => [i.cardId, i.checkPoint]));
function cardView(c, o = {}) {
  const isT = c.kind === 'battle_tactic';
  let body;
  if (isT) body = `<section class="half tac"><h4>${t('card.tactic')} · ${esc(L(c.score.timing))} <span class="vp">${t('card.vp', { n: c.score.vp })}</span></h4><p>${esc(L(c.score.condition))}</p></section>
    <section class="half cmd"><h4>${t('card.command')} · ${nm(c.command.name)}</h4><p class="timing">${esc(L(c.command.timing))}</p><p>${esc(L(c.command.mechanics))}</p></section>`;
  else if (c.kind === 'twist') body = `<p class="timing">${t('card.reveal')}: ${esc(L(c.revealTiming))} · <b>${c.scoreTimingLabel ? esc(L(c.scoreTimingLabel)) : t('tw.score.' + (c.scoreTiming === 'own_turn_end' ? 'own' : c.scoreTiming === 'round_end' ? 'round' : 'none'))}</b></p><p>${esc(L(c.mechanics))}</p>`;
  else body = `<p class="timing">${esc(L(c.timing))}</p><p>${esc(L(c.mechanics))}</p>`;
  const corr = (c.officialCorrections || []).map(x => `<p class="errata">✓ ${t('card.errata')}: ${esc(L(x.note))} <a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">PDF ↗</a></p>`).join('');
  const cp = CHECK_POINTS[c.id];
  const manual = c.automationAllowed === false || cp ? `<p class="warnbox">⚠ ${t('tw.manual')}${cp ? `<br><b>${t('card.checkPoint')}:</b> ${esc(L(cp))}` : ''}</p>` : '';
  const kind = isT ? `${t('card.tactic')} / ${t('card.command')}` : c.kind === 'twist' ? t('card.twist') : c.kind === 'relic' ? t('card.relic') : t('card.terrain');
  return `<article class="card ${o.cls || ''}">${o.badge || ''}<div class="kind">${kind}</div><h3>${nm(c.name)}</h3>${body}${corr}${manual}
    <footer><span class="sumlabel">${t(c.kind === 'relic' || c.kind === 'terrain_ability' ? 'card.disclaimerRule' : 'card.disclaimer')}</span></footer>
    ${o.actions ? `<div class="row card-actions">${o.actions}</div>` : ''}</article>`;
}

/* ---------- actions ---------- */
const sig = () => S.db.game && `${S.db.game.stage}|${S.db.game.setup?.step}|${S.db.game.rounds.length}|${S.db.game.rounds.at(-1)?.step}|${S.db.game.turn?.player}|${S.db.game.turn?.phase}`;
function act(name, payload = {}, after) {
  const before = sig();
  const finish = () => { render(); if (mode() === 'guided' && before !== sig()) $('#status')?.scrollIntoView({ block: 'start' }); };
  if (isLinked()) {
    if (!LK || busy) return toast(t(LK ? 'room.syncing' : 'E_OFFLINE'));
    busy = true; render();
    LK.dispatch(name, payload, renderedRev ?? undefined).then(() => after && after()).catch(handleErr).finally(() => { busy = false; finish(); });
    return;
  }
  try { S.dispatch(name, payload, renderedRev ?? undefined); if (after) after(); }
  catch (e) { handleErr(e); }
  finish();
}
function handleErr(e) {
  if (e && e.code) toast(t(e.code, e.vars));
  else { console.error(e); toast(esc(e?.message || e)); }
}
function confirmDialog(text, onOk, okLabel) {
  const d = document.createElement('dialog');
  d.innerHTML = `<p>${text}</p><div class="actions"><button data-x="no">${t('cancel')}</button><button class="primary" data-x="ok">${okLabel || t('confirm')}</button></div>`;
  document.body.append(d); d.showModal();
  d.addEventListener('click', e => { const x = e.target.dataset?.x; if (x) { d.close(); if (x === 'ok') onOk(); } });
  d.addEventListener('close', () => d.remove());
}

/* ---------- layout ---------- */
function render() {
  document.documentElement.lang = lang();
  const g = S.db.game;
  renderedRev = g ? g.rev : null;
  $('#app').innerHTML = `
  <header class="top">
    <div class="brand">SPEARHEAD<small>FIELDBOOK · ${t('app.sub')}</small></div>
    <nav class="nav" aria-label="menu">${['battle', 'history', 'guide'].map(p => `<button data-act="ui:page" data-v="${p}" class="${page === p ? 'active' : ''}" ${page === p ? 'aria-current="page"' : ''}>${t('nav.' + p)}</button>`).join('')}</nav>
    <div class="toggles">
      <div class="seg" role="group" aria-label="${t('lang.label')}"><button data-act="ui:lang" data-v="ko" aria-pressed="${lang() === 'ko'}">한국어</button><button data-act="ui:lang" data-v="en" aria-pressed="${lang() === 'en'}">English</button></div>
      <div class="seg" role="group" aria-label="${t('mode.label')}"><button data-act="ui:mode" data-v="guided" aria-pressed="${mode() === 'guided'}">${t('mode.guided')}</button><button data-act="ui:mode" data-v="quick" aria-pressed="${mode() === 'quick'}">${t('mode.quick')}</button></div>
    </div>
  </header>
  ${notices()}
  ${page === 'battle' ? statusBar(g) : ''}
  <main>${page === 'battle' ? battlePage(g) : page === 'history' ? historyPage() : guidePage()}</main>
  <footer class="foot">${t('footer')}</footer>`;
  lastRender = performance.now();
  updatePreview();
}
function notices() {
  const s = S.status, out = [];
  if (s.saveError) out.push(t('storage.error'));
  if (s.corruptKey) out.push(t('storage.corrupt', { key: s.corruptKey }));
  if (s.legacyFound && !S.db.history.length && !S.db.game) out.push(t('storage.legacy'));
  return out.map(x => `<p class="notice">${x}</p>`).join('');
}
function statusText(g) {
  if (!g) return t('st.new');
  if (g.stage === 'setup') return t('st.setup', { step: stepMeta(g, g.setup.step).short || stepMeta(g, g.setup.step).title });
  if (g.stage === 'roundStart') return t('st.roundStart', { n: g.rounds.length + 1 });
  if (g.stage === 'roundPrep') return t('st.roundStart', { n: g.rounds.length });
  if (g.stage === 'turn') return t('st.turn', { n: g.rounds.length, name: nameOf(g, g.turn.player), phase: g.turn.afterScore ? L({ ko: '득점 후 효과', en: 'After scoring' }) : g.turn.phase === null ? '—' : stripTags(t('ph.' + PH[g.turn.phase])) });
  if (g.stage === 'roundEnd') return t('st.roundEnd', { n: g.rounds.length });
  return t('st.finished');
}
const stripTags = s => String(s).replace(/<[^>]+>/g, '');
function statusBar(g) {
  const canUndo = isLinked() ? !!LK?.canUndo && !busy : !!(g && S.db.undo.length);
  const room = isLinked() ? `<div class="roombar"><span>${t('room.bar', { code: S.db.link.room })}</span><span class="badge" id="link-status">${t('room.st.' + linkStatus)}</span>
    ${g ? `<span class="hint small">${t('room.seat', { name: nameOf(g, meOf(g)) })}</span>` : ''}${busy ? `<span class="hint small">${t('room.syncing')}</span>` : ''}
    <span class="grow"></span><button class="ghost" data-act="ui:share">${t('room.share')}</button><button class="ghost" data-act="ui:leave">${t('room.leave')}</button></div>` : '';
  return `<div class="status" id="status"><span class="st-text">${statusText(g)}</span>
    <button class="ghost undo" data-act="ui:undo" title="${t('undo.title')}" ${canUndo ? '' : 'disabled'}>${t('undo')}</button></div>${room}`;
}

/* ---------- battle page ---------- */
function battlePage(g) {
  if (!g) return landing();
  if (g.stage === 'setup') return mode() === 'guided' ? guidedSetup(g) : quickSetupView(g);
  let main = '';
  if (g.stage === 'roundStart') main = mode() === 'guided' ? guidedPriority(g) : quickPriority(g);
  else if (g.stage === 'roundPrep') main = mode() === 'guided' ? guidedPrep(g) : quickPrep(g);
  else if (g.stage === 'turn') main = mode() === 'guided' ? guidedTurn(g) : quickTurn(g);
  else if (g.stage === 'roundEnd') main = roundEndView(g);
  else main = finishedView(g);
  return scoreboard(g) + main + recordPanel(g) + featuresPanel(g) + infoPanel(g) +
    (g.status !== 'finished' && !isLinked() ? `<div class="actions"><button class="ghost danger" data-act="ui:abandon">${t('abandon')}</button></div>` : '');
}

function scoreboard(g) {
  const s = E.totals(g), r = ['roundPrep', 'turn', 'roundEnd'].includes(g.stage) ? g.rounds.at(-1) : null;
  const side = p => {
    const badges = [];
    if (r) {
      badges.push(`<span class="badge">${p === r.first ? t('first') : t('second')}</span>`);
      if (r.underdog === p) badges.push(`<span class="badge ud">${L({ ko: '언더독', en: 'Underdog' })}</span>`);
      if (g.stage === 'roundPrep') badges.push(`<span class="badge ${r.blocked[p] ? 'no' : 'ok'}">${r.blocked[p] ? t('refill.no') : t('refill.ok')}</span>`);
    }
    if (g.turn?.player === p) badges.push(`<span class="badge active">▶</span>`);
    return `<div class="score-side side-${p ? 'b' : 'a'}"><div><b>${esc(nameOf(g, p))}${meOf(g) === p ? ` <span class="badge me">${t('me')}</span>` : ''}</b><small>${esc(g.config.players[p].army)}</small><div class="badges">${badges.join('')}</div></div><strong>${s[p]}</strong></div>`;
  };
  const strip = [1, 2, 3, 4].map(n => {
    const rr = g.rounds[n - 1], cur = rr && !rr.closed || (!rr && g.stage === 'roundStart' && n === g.rounds.length + 1);
    return `<div class="round ${rr?.closed ? 'done' : cur ? 'current' : ''}">${t('round.short', { n })}${rr?.closed ? ' ✓' : ''}</div>`;
  }).join('');
  return `<div class="scoreboard">${side(0)}<div class="versus">VS</div>${side(1)}</div><div class="rounds">${strip}</div>`;
}

/* ---------- guided frame ---------- */
function frame(o) {
  return `<section class="panel gold guide-step">
    ${o.eyebrow ? `<div class="eyebrow">${o.eyebrow}</div>` : ''}
    ${o.who ? `<div class="who"><span>${t('g.who')}</span>${o.who}</div>` : ''}
    <h2>${o.title}</h2>
    ${o.what ? `<p class="what"><b>${t('g.what')}</b>${o.what}</p>` : ''}
    ${o.when ? `<p class="when"><b>${t('g.when')}</b>${o.when}</p>` : ''}
    ${o.body || ''}
    ${o.why ? `<details><summary>${t('g.why')}</summary><div class="hint">${o.why}</div></details>` : ''}
  </section>`;
}

/* ---------- setup ---------- */
function stepMeta(g, step) {
  const c = g.config, atk = c.attacker, def = atk === null ? null : 1 - atk, N = p => (p === null || p === undefined ? '' : nameOf(g, p));
  const A = { role: t('attacker'), name: N(atk) }, D = { role: t('defender'), name: N(def) };
  const whoA = `${esc(N(atk))} · ${t('attacker')}`, whoD = `${esc(N(def))} · ${t('defender')}`;
  const m = {
    players: { title: t('players.title'), who: t('g.both') },
    rolloff: { title: t('rolloff.title'), who: t('g.both'), what: t('rolloff.what'), when: t('rolloff.when') },
    roles: { title: t('roles.title'), who: esc(N(c.rolloff?.winner)), what: t('roles.what', { name: N(c.rolloff?.winner) }), when: t('roles.when'), why: t('roles.why') },
    atkRegiment: { title: t('regiment.title', A), who: whoA, what: t('regiment.what'), when: t('pick.when'), why: t('pick.why') },
    atkEnhancement: { title: t('enh.title', A), who: whoA, what: t('enh.what'), when: t('pick.when'), why: t('pick.why') },
    defRegiment: { title: t('regiment.title', D), who: whoD, what: t('regiment.what'), when: t('pick.when'), why: t('pick.why') },
    defEnhancement: { title: t('enh.title', D), who: whoD, what: t('enh.what'), when: t('pick.when'), why: t('pick.why') },
    realm: { title: t('realm.title', D), who: whoD, what: t('realm.what'), when: t('realm.when') },
    deployment: { title: t('deploy.title', D), who: whoD, what: t('deploy.what'), when: t('deploy.when') },
    terrainDef: { title: t('terrainDef.title', D), who: whoD, what: t('terrain.what'), when: t('terrain.when') },
    terrainAtk: { title: t('terrainAtk.title', A), who: whoA, what: t('terrain.what'), when: t('terrain.when') },
    crypt: { title: t('crypt.title'), who: t('g.both'), what: t('crypt.what'), when: t('crypt.when') },
    terrainGroupDef: { title: t('groupDef.title', D), who: whoD, what: t('groupDef.what'), when: t('terrain.when') },
    terrainGroupAtk: { title: t('groupAtk.title', A), who: whoA, what: t('groupAtk.what', { group: stripTags(t('group' + (c.terrain.groups?.[atk] || 'A'))) }), when: t('terrain.when') },
    fortifyDef: { title: t('fortifyDef.title', D), who: whoD, what: t('fortify.what'), when: t('fortify.when') },
    fortifyAtk: { title: t('fortifyAtk.title', A), who: whoA, what: t('fortify.what'), when: t('fortify.when') },
    relicDef: { title: t('relicDef.title', D), who: whoD, what: t('relicDef.what'), when: t('relic.when') },
    relicAtk: { title: t('relicAtk.title', A), who: whoA, what: t('relicAtk.what', { relic: c.relics ? L(featureName(c.relics[atk])) : '' }), when: t('relic.when') },
    deployAtk: { title: t('deployAtk.title', A), who: whoA, what: t('deployArmy.what'), when: t('deployArmy.when') },
    deployDef: { title: t('deployDef.title', D), who: whoD, what: t('deployArmy.what'), when: t('deployArmy.when') },
    deployAbilities: { title: t('deployAb.title'), who: t('g.both'), what: t('deployAb.what'), when: t('deployAb.when') },
    decks: { title: t('decks.title'), who: t('g.both'), what: t('decks.what', { pack: E.pack(c.pack).name.en, realm: c.realm ? realmOf(c.pack, c.realm).name.en : '' }), when: t('decks.when') },
    summary: { title: t('summary.title'), who: t('g.both'), what: t('summary.what'), when: t('summary.when') }
  };
  return m[step] || { title: step };
}

function guidedSetup(g) {
  const c = g.config, step = g.setup.step, steps = E.setupSteps(g), i = steps.indexOf(step), meta = stepMeta(g, step);
  const P = E.pack(c.pack), atk = c.attacker;
  const back = i > 1 ? `<button type="button" class="ghost" data-act="ui:setupBack" ${g.decks ? 'disabled' : ''}>${t('g.back')}</button>` : '';
  const done = (label = t('g.done')) => `<button class="primary" name="status" value="done">${label}</button>`;
  const noteField = (ph = '') => `<label>${t('g.note')}<input name="note" maxlength="500" placeholder="${esc(ph)}" value="${esc(c.terrain[step] || '')}"></label>`;
  let body = '', buttons = done();
  switch (step) {
    case 'rolloff':
      body = `<div class="fields">${[0, 1].map(p => `<label>${t('rolloff.die', { name: nameOf(g, p) })}<input name="r${p}" type="number" inputmode="numeric" min="1" max="6" step="1"></label>`).join('')}</div>
        <p class="hint">${t('rolloff.orWinner')} ${[0, 1].map(p => `<button type="submit" name="winner" value="${p}" class="ghost small-btn" formnovalidate>${t('rolloff.won', { name: nameOf(g, p) })}</button>`).join(' ')}</p>`;
      buttons = done(t('rolloff.record'));
      break;
    case 'roles': {
      const w = c.rolloff.winner;
      body = c.rolloff.rolls ? `<p class="hint">${esc(nameOf(g, 0))} ${c.rolloff.rolls[0]} : ${c.rolloff.rolls[1]} ${esc(nameOf(g, 1))}</p>` : '';
      buttons = `<button class="primary" name="choice" value="attacker">${t('roles.atk', { name: nameOf(g, w) })}</button><button class="primary" name="choice" value="defender">${t('roles.def', { name: nameOf(g, w) })}</button>`;
      break;
    }
    case 'atkRegiment': case 'atkEnhancement': case 'defRegiment': case 'defEnhancement': {
      const p = step.startsWith('atk') ? atk : 1 - atk, field = step.endsWith('Regiment') ? 'regiment' : 'enhancement';
      const opts = armyOptions(c.players[p].faction, c.players[p].army, field), cur = c.players[p][field];
      body = `${opts.length ? `<p class="hint">${t('pick.fromList')}</p><div class="chips">${opts.map(o => `<button type="button" class="chip" data-fill="value" data-v="${esc(o)}" aria-pressed="${o === cur}">${esc(o)}</button>`).join('')}</div>` : `<p class="hint">${t('pick.noData')}</p>`}
        ${E.isUntracked(g, p) ? `<p class="hint">${t('opp.hand', { name: nameOf(g, p) })}</p>` : ''}
        <label>${t(field === 'regiment' ? 'f.regiment' : 'f.enh')}<input name="value" ${E.isUntracked(g, p) ? '' : 'required'} maxlength="120" list="opt-${step}" placeholder="${t('pick.ph')}" value="${esc(cur)}"></label>${dl('opt-' + step, opts)}${opts.length ? `<p class="hint small">${t('pick.listNote')}</p>` : ''}`;
      if (E.isUntracked(g, p)) buttons = `<button class="ghost" name="status" value="none" formnovalidate>${t('opp.skip')}</button>` + done();
      break;
    }
    case 'realm':
      body = `<div class="choice-list">${P.realms.map(r => `<label class="choice"><input type="radio" name="realm" value="${r.id}" required ${c.realm === r.id ? 'checked' : ''}> <b>${nm(r.name)}</b>
        <span class="hint small">${t('realm.deck')}: ${P.deckManifest.twistsByRealm[r.id].map(id => esc(L(E.card(id).name))).join(' · ')}</span></label>`).join('')}</div>`;
      break;
    case 'deployment':
      body = `<div class="fields"><label>${t('deploy.map')}<input name="map" required maxlength="150" value="${esc(c.deployment.map)}"></label><label>${t('deploy.terr')}<input name="territories" maxlength="300" value="${esc(c.deployment.territories)}"></label></div>`;
      break;
    case 'terrainDef': case 'terrainAtk':
      body = `<p class="notice">${t('terrain.rules')}</p><p class="hint"><a href="${esc(P.errataNotes[0].url)}" target="_blank" rel="noopener noreferrer">${t('terrain.faq')} ↗</a></p>${noteField()}`;
      break;
    case 'crypt':
      body = cardView(refById('unholy-draught'), { cls: 'compact' }) + `<p class="hint"><a href="${esc(P.errataNotes[0].url)}" target="_blank" rel="noopener noreferrer">${t('card.errata')} ↗</a></p>${noteField()}`;
      break;
    case 'terrainGroupDef':
      body = `<div class="choice-list">${['A', 'B'].map(x => `<label class="choice"><input type="radio" name="group" value="${x}" required ${c.terrain.groups?.[1 - atk] === x ? 'checked' : ''}> ${t('group' + x)}</label>`).join('')}</div><p class="notice">${t('terrain.rules')}</p><p class="hint">${t('icon.note')}</p>${noteField()}`;
      break;
    case 'terrainGroupAtk':
      body = `<p class="notice">${t('terrain.rules')}</p><p class="hint">${t('icon.note')}</p>${noteField()}`;
      break;
    case 'fortifyDef': case 'fortifyAtk':
      body = noteField(L({ ko: '예: 동쪽 직사각형 목표물', en: 'e.g. east rectangular objective' }));
      break;
    case 'relicDef': {
      const start = P.relicSetup.startingRelics[c.realm];
      body = `<div class="choice-list">${start.map(id => `<label class="choice"><input type="radio" name="relic" value="${id}" required ${c.relics?.[1 - atk] === id ? 'checked' : ''}> <b>${nm(featureName(id))}</b></label>`).join('')}</div>
        <p class="notice">${t('relic.rules')}</p><div class="grid">${start.map(id => cardView(refById(id), { cls: 'compact' })).join('')}</div>`;
      break;
    }
    case 'relicAtk':
      body = `<p class="notice">${t('relic.rules')}</p>${cardView(refById(c.relics[atk]), { cls: 'compact' })}${noteField()}`;
      break;
    case 'deployAtk': case 'deployDef':
      body = `<label>${t('g.note')}<textarea name="note" maxlength="500" placeholder="${t('deployArmy.ph')}">${esc(c.terrain[step] || '')}</textarea></label>`;
      break;
    case 'deployAbilities':
      body = noteField();
      buttons = `<button class="ghost" name="status" value="none">${t('g.none')}</button>` + done();
      break;
    case 'decks':
      buttons = done(t('decks.btn'));
      break;
    case 'summary':
      body = setupRecord(g);
      buttons = done(t('summary.btn'));
      break;
  }
  const locked = g.decks && step !== 'summary' ? '' : g.decks ? `<p class="hint small">${t('g.backLocked')}</p>` : '';
  return frame({
    ...meta, eyebrow: t('g.step', { i: i + 1, n: steps.length }),
    body: `<form data-form="setup" data-step="${step}">${body}<div class="actions">${back}${buttons}</div></form>${locked}`
  });
}

function setupRecord(g) {
  const c = g.config, atk = c.attacker, none = `<span class="hint">${t('summary.none')}</span>`, P = E.pack(c.pack);
  const val = v => (v ? esc(v) : none);
  const rows = [
    [t('f.pack'), nm(P.name)],
    [L({ ko: '전장 면', en: 'Realm' }), c.realm ? nm(realmOf(c.pack, c.realm).name) : none],
    [t('rolloff.title'), c.rolloff ? t('rolloff.won', { name: nameOf(g, c.rolloff.winner) }) + (c.rolloff.rolls ? ` (${c.rolloff.rolls.join(' : ')})` : '') : none],
    ...(atk === null ? [] : [[t('attacker'), esc(nameOf(g, atk))], [t('defender'), esc(nameOf(g, 1 - atk))]]),
    ...[0, 1].map(p => [`${esc(nameOf(g, p))} · ${t('f.regiment')} / ${t('f.enh')}`, `${val(c.players[p].regiment)} / ${val(c.players[p].enhancement)}`]),
    [t('deploy.map'), val(c.deployment.map)], [t('deploy.terr'), val(c.deployment.territories)]
  ];
  if (c.terrain.groups) rows.push([L({ ko: '지형 그룹', en: 'Terrain groups' }), [0, 1].map(p => `${esc(nameOf(g, p))}: ${c.terrain.groups[p]}`).join(' · ')]);
  if (c.relics) rows.push([L({ ko: '시작 유물', en: 'Starting relics' }), [0, 1].map(p => `${esc(nameOf(g, p))}: ${nm(featureName(c.relics[p]))}`).join(' · ')]);
  for (const [k, v] of Object.entries(c.terrain)) if (k !== 'groups' && v) rows.push([esc(stripTags(stepMeta(g, k).title)), esc(v)]);
  if (g.decks) rows.push([L({ ko: '덱', en: 'Decks' }), t('deck.info', { pack: P.name.en, realm: realmOf(c.pack, g.decks.realm).name.en })]);
  const quick = Object.values(g.setup.log).includes('quick') ? `<p class="hint small">${t('summary.quick')}</p>` : '';
  return `<dl class="record">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${quick}`;
}

/* landing: mode choice + first form */
function landing() {
  const card = (m, rec) => `<button class="mode-card ${mode() === m ? 'selected' : ''}" data-act="ui:mode" data-v="${m}" aria-pressed="${mode() === m}"><b>${t('mode.' + m)}${rec ? ` <span class="badge">${t('recommended')}</span>` : ''}</b><span>${t('land.' + m)}</span></button>`;
  const dev = S.db.prefs.device;
  const dcard = (m, rec) => `<button class="mode-card ${dev === m ? 'selected' : ''}" data-act="ui:device" data-v="${m}" aria-pressed="${dev === m}"><b>${t('dev.' + m)}${rec ? ` <span class="badge">${t('recommended')}</span>` : ''}</b><span>${t('dev.' + m + '.desc')}</span></button>`;
  const head = `<div class="titlebar"><h1>${t('land.title')}</h1><p>${t('land.desc')}</p><p class="notice small">${t('footer')}</p></div>
    ${isLinked() ? '' : `<h3>${t('dev.label')}</h3><div class="mode-pick three">${dcard('linked', true)}${dcard('solo')}${dcard('shared')}</div>`}
    <h3>${t('mode.label')}</h3><div class="mode-pick">${card('guided', true)}${card('quick')}</div>`;
  if (dev === 'linked' && !isLinked()) return head + roomPanel();
  return head + (isLinked() ? `<p class="notice">${t('room.waitStart')}</p>` : '') + (mode() === 'guided' ? playersForm() : quickSetupView(null));
}
function roomPanel() {
  const code = params.get('room') || '';
  return `<section class="panel gold"><h2>${t('dev.linked')}</h2><p>${t('room.intro')}</p>
    <div class="actions" style="justify-content:flex-start"><button class="primary" data-act="ui:createRoom">${t('room.create')}</button></div>
    <form data-form="join" class="row join"><input name="code" maxlength="6" autocapitalize="characters" autocomplete="off" placeholder="${t('room.joinPh')}" value="${esc(code)}" aria-label="${t('room.code')}"><button>${t('room.join')}</button></form>
    <p class="hint small">${t('room.privacy')}</p></section>`;
}
function draftSetup() { return S.db.draft.setup || {}; }
function playerFields(d, i, extra) {
  const label = isLinked() ? t(i ? 'room.seatB' : 'room.seatA') + (S.db.link.seat === i ? ` <span class="badge me">${t('me')}</span>` : '') : t(i ? 'playerB' : 'playerA');
  return `<section class="panel side-${i ? 'b' : 'a'}"><h3>${label}</h3>
    <label>${t('f.name')}<input name="name${i}" required maxlength="40" value="${esc(d['name' + i] ?? stripTags(t(i ? 'defaultB' : 'defaultA')))}"></label>
    <label>${t('f.faction')}<input name="faction${i}" list="factions" data-rerender="1" required maxlength="80" placeholder="${t('f.faction.ph')}" value="${esc(d['faction' + i] || '')}"></label>
    <label>${t('f.army')}<input name="army${i}" list="armies${i}" data-rerender="1" required maxlength="100" placeholder="${t('f.army.ph')}" value="${esc(d['army' + i] || '')}"></label>${dl('armies' + i, armyNames(d['faction' + i]))}
    ${extra ? `<div class="fields"><label>${t('f.regiment')}<input name="regiment${i}" list="reg${i}" maxlength="120" value="${esc(d['regiment' + i] || '')}"></label><label>${t('f.enh')}<input name="enhancement${i}" list="enh${i}" maxlength="120" value="${esc(d['enhancement' + i] || '')}"></label></div>${dl('reg' + i, armyOptions(d['faction' + i], d['army' + i], 'regiment'))}${dl('enh' + i, armyOptions(d['faction' + i], d['army' + i], 'enhancement'))}` : ''}
  </section>`;
}
const factionList = () => `<datalist id="factions">${factionNames().map(f => `<option value="${esc(f)}">`).join('')}</datalist>`;
function packPicker(cur, disabled) {
  return `<div class="choice-list packs">${DATA.packs.map(p => `<label class="choice"><input type="radio" name="pack" value="${p.id}" data-rerender="1" ${cur === p.id ? 'checked' : ''} ${disabled ? 'disabled' : ''} required> <b>${nm(p.name)}</b><span class="hint small">${p.realms.map(r => esc(L(r.name))).join(' / ')}</span></label>`).join('')}</div>`;
}
function playersForm() {
  const d = draftSetup(), pack = d.pack || 'fire';
  return frame({
    eyebrow: t('g.step', { i: 1, n: '…' }), title: t('players.title'), who: t('g.both'), what: t('players.what'),
    body: `<form data-form="players" data-draft="setup">${packPicker(pack)}${pack === 'ash' ? `<p class="notice">${t('ash.scope')}</p>` : ''}
      <div class="grid">${playerFields(d, 0)}${playerFields(d, 1)}</div>${factionList()}<p class="hint">${t(ARMY_DATA.length ? 'pick.listNote' : 'players.armyNote')}</p>
      <div class="actions"><button class="primary">${t('start.guided')}</button></div></form>`
  });
}
function quickSetupView(g) {
  let d = draftSetup();
  if (g && !d._game) { // seed the quick form from a guided setup in progress
    const c = g.config;
    d = { _game: g.id, pack: c.pack, realm: c.realm || '', attacker: c.attacker ?? 0, rolloff: c.rolloff ? c.rolloff.winner : '', map: c.deployment.map, territories: c.deployment.territories,
      group: c.terrain.groups?.[1 - (c.attacker ?? 0)] || 'A', relic: c.relics?.[1 - (c.attacker ?? 0)] || '' };
    c.players.forEach((p, i) => Object.assign(d, { ['name' + i]: p.name, ['faction' + i]: p.faction, ['army' + i]: p.army, ['regiment' + i]: p.regiment, ['enhancement' + i]: p.enhancement }));
  }
  const pack = g?.decks ? g.config.pack : d.pack || 'fire', P = E.pack(pack);
  const realm = P.realms.some(r => r.id === d.realm) ? d.realm : P.realms[0].id;
  const who = [[0, d.name0 || stripTags(t('defaultA'))], [1, d.name1 || stripTags(t('defaultB'))]];
  const extra = pack === 'sand' ? `<label>${t('qs.group')}<select name="group">${opt([['A', stripTags(t('groupA'))], ['B', stripTags(t('groupB'))]], d.group)}</select></label>`
    : pack === 'ash' ? `<label>${t('qs.relic')}<select name="relic">${opt(P.relicSetup.startingRelics[realm].map(id => [id, L(featureName(id))]), d.relic)}</select></label>` : '';
  return `<section class="panel gold"><div class="eyebrow">QUICK SETUP</div><h2>${t('qs.title')}</h2><p class="hint">${t('qs.desc')}</p>
    <form data-form="quickSetup" data-draft="setup">${packPicker(pack, !!g?.decks)}${pack === 'ash' ? `<p class="notice">${t('ash.scope')}</p>` : ''}
    <div class="fields"><label>${t('qs.realm')}<select name="realm" data-rerender="1" ${g?.decks ? 'disabled' : ''}>${opt(P.realms.map(r => [r.id, lang() === 'ko' ? `${r.name.ko} · ${r.name.en}` : r.name.en]), realm)}</select></label>
      <label>${t('qs.attacker')}<select name="attacker" data-rerender="1">${opt(who, d.attacker ?? 0)}</select></label>
      <label>${t('qs.rolloff')}<select name="rolloff">${opt([['', stripTags(t('qs.unrecorded'))], ...who], d.rolloff ?? '')}</select></label>${extra}
      <label>${t('deploy.map')}<input name="map" maxlength="150" value="${esc(d.map || '')}"></label>
      <label class="full">${t('deploy.terr')}<input name="territories" maxlength="300" value="${esc(d.territories || '')}"></label></div>
    <div class="grid">${playerFields(d, 0, true)}${playerFields(d, 1, true)}</div>${factionList()}
    <label class="check"><input type="checkbox" name="confirm" ${d.confirm ? 'checked' : ''}> ${t('qs.confirm')}</label>
    <div class="actions"><button class="primary">${t('start.quick')}</button></div></form></section>`;
}

/* ---------- round start ---------- */
function roundMessages(g, r, live) {
  const out = [], N = p => nameOf(g, p);
  out.push(r.underdog === null ? t('ud.msg.none', { a: r.before[0], b: r.before[1] }) : t('ud.msg.is', { name: N(r.underdog), gap: r.gap }));
  if (r.tie) out.push(t('seize.tie', { name: N(r.decider) }));
  if (r.seized) out.push(r.exception ? t('seize.exception', { name: N(r.first), gap: r.gap }) : t('seize.blocked', { name: N(r.first) }));
  else if (r.number > 1 && g.rounds[r.number - 2].first !== r.first) out.push(t('seize.given', { giver: N(r.decider), name: N(r.first) }));
  if (live && r.underdog !== null) {
    const s = E.totals(g);
    if (s[r.underdog] >= s[1 - r.underdog]) out.push(t('ud.fixed', { name: N(r.underdog) }));
  }
  return out.map(m => `<p class="notice">${m}</p>`).join('');
}
function priorityPreview(g, decider, first) {
  const prev = g.rounds.at(-1), before = E.totals(g), ud = E.underdogOf(before), gap = Math.abs(before[0] - before[1]);
  if (prev.first === first) return '';
  if (decider === first) return ud === first && gap >= 5 ? t('seize.exception', { name: nameOf(g, first), gap }) : t('seize.blocked', { name: nameOf(g, first) });
  return t('seize.given', { giver: nameOf(g, decider), name: nameOf(g, first) });
}
function guidedPriority(g) {
  const n = g.rounds.length + 1, N = p => nameOf(g, p);
  if (n === 1) {
    const a = g.config.attacker;
    return frame({ eyebrow: t('round', { n }), who: `${esc(N(a))} · ${t('attacker')}`, title: t('prio.r1.title', { name: N(a) }), what: t('prio.r1.what'),
      body: `<div class="actions">${[a, 1 - a].map(p => `<button class="primary" data-act="beginRound" data-args="${args({ first: p })}">${t('prio.goes', { name: N(p) })}</button>`).join('')}</div>` });
  }
  const prev = g.rounds.at(-1), pr = S.db.draft.prio?.round === n && S.db.draft.prio.game === g.id ? S.db.draft.prio : null;
  if (!pr) return frame({ eyebrow: t('round', { n }), who: t('g.both'), title: t('prio.title', { n }), what: t('prio.what', { name: N(prev.first) }), when: t('prio.when'),
    body: `<div class="actions">${[0, 1].map(p => `<button class="primary" data-act="ui:prio" data-v="${p}">${t('prio.won', { name: N(p) })}</button>`).join('')}<button data-act="ui:prio" data-v="tie">${t('prio.tie')}</button></div>` });
  const tie = pr.winner === 'tie', decider = tie ? prev.first : pr.winner;
  const choice = p => {
    const pv = priorityPreview(g, decider, p);
    return `<div class="option"><button class="primary" data-act="beginRound" data-args="${args(tie ? { first: p, tie: true } : { first: p, priorityWinner: decider })}">${t('prio.goes', { name: N(p) })}</button>${pv ? `<p class="hint small">${pv}</p>` : ''}</div>`;
  };
  return frame({ eyebrow: t('round', { n }), who: esc(N(decider)), title: t('prio.decide', { name: N(decider) }), what: (tie ? t('seize.tie', { name: N(decider) }) + ' ' : '') + t('prio.decideWhat'),
    body: `<div class="options">${choice(decider)}${choice(1 - decider)}</div><div class="actions"><button class="ghost" data-act="ui:prio" data-v="">${t('prio.reenter')}</button></div>` });
}
function quickPriority(g) {
  const n = g.rounds.length + 1, N = p => nameOf(g, p), players = [[0, N(0)], [1, N(1)]];
  return `<form class="panel gold" data-form="priority"><div class="eyebrow">${t('round', { n })}</div><h2>${n === 1 ? t('prio.r1.title', { name: N(g.config.attacker) }) : t('prio.title', { n })}</h2>
    <p class="hint">${n === 1 ? t('prio.r1.what') : t('prio.what', { name: N(g.rounds.at(-1).first) })}</p>
    <div class="fields">${n > 1 ? `<label>${t('q.prio.winner')}<select name="winner">${opt([...players.map(([p, x]) => [p, stripTags(t('prio.won', { name: x }))]), ['tie', stripTags(t('prio.tie'))]], '')}</select></label>` : ''}
    <label>${t('q.prio.first')}<select name="first">${opt(players, n === 1 ? g.config.attacker : '')}</select></label></div>
    <div class="actions"><button class="primary">${t('q.prio.btn')}</button></div></form>`;
}

function twistPanel(g, r, withForm) {
  const c = E.card(r.twist);
  const whoMsg = r.underdog === null ? t('tw.who.none') : t('tw.who.ud', { name: nameOf(g, r.underdog) });
  const feats = twistMentions(c, g.config.pack).filter(id => !g.features.some(f => f.id === id && !f.removed));
  const form = withForm ? `<label>${t('tw.note')}<input name="note" maxlength="1000" placeholder="${t('tw.note.ph')}" value="${esc(S.db.draft.twistNote?.round === r.number ? S.db.draft.twistNote.v : r.twistNote)}" data-twistnote="1"></label>
    ${feats.map(id => `<label class="check"><input type="checkbox" name="features" value="${id}"> ${t('tw.place', { name: L(featureName(id)) })}</label>`).join('')}` : '';
  return `${cardView(c, { cls: 'twist' })}<p class="notice">${whoMsg}</p>${form}`;
}
function twistRevealControls(g) {
  if (g.play !== 'solo') return `<p class="hint">${t('tw.left', { n: g.decks.twist.draw.length })}</p><div class="actions"><button class="primary" data-act="revealTwist">${t('tw.btn')}</button></div>`;
  if (ui.pickTwist) return `<h3>${t('tw.pickTitle')}</h3><div class="choice-grid">${g.decks.twist.draw.map(id => `<button data-act="revealTwist" data-args="${args({ id })}">${nm(E.card(id).name)}</button>`).join('')}</div>
    <div class="actions"><button class="ghost" data-act="ui:pickTwist" data-v="">${t('g.back')}</button></div>`;
  return `<p class="hint">${t('tw.soloNote')} ${t('tw.left', { n: g.decks.twist.draw.length })}</p><div class="actions"><button data-act="ui:pickTwist" data-v="1">${t('tw.there')}</button><button class="primary" data-act="revealTwist">${t('tw.here')}</button></div>`;
}
function guidedPrep(g) {
  const r = g.rounds.at(-1), n = r.number;
  if (r.step === 'underdog') return frame({ eyebrow: t('round', { n }), who: t('g.both'), title: t('ud.title', { n }), what: t('ud.what', { a: r.before[0], b: r.before[1] }),
    body: roundMessages(g, r) + `<div class="actions"><button class="primary" data-act="ackUnderdog">${t('ack')}</button></div>` });
  if (r.step === 'twist') return frame({ eyebrow: t('round', { n }), who: t('g.both'), title: t('tw.title', { n }), what: t('tw.what'), when: t('tw.when'),
    body: twistRevealControls(g) });
  if (r.step === 'twistResolve') return frame({ eyebrow: t('round', { n }), who: t('g.both'), title: t('tw.resolve', { name: L(E.card(r.twist).name) }), what: t('tw.resolveWhat'), when: t('tw.resolveWhen'),
    body: `<form data-form="twist">${twistPanel(g, r, true)}<div class="actions"><button class="primary">${t('tw.btnDone')}</button></div></form>` });
  // hands, one player at a time, then start-of-round abilities
  const me = meOf(g);
  if (me !== null) {
    if (!E.handDone(r, me) || ui.handView === me) return frame({ eyebrow: t('round', { n }), who: esc(nameOf(g, me)), title: t('hand.title', { name: nameOf(g, me) }), what: r.number === 1 ? t('hand.r1') : t('hand.discardWhat'),
      body: handPanel(g, me, { prep: true, guided: true }) });
    if (!E.handDone(r, 1 - me)) return frame({ eyebrow: t('round', { n }), who: esc(nameOf(g, 1 - me)), title: t('hand.title', { name: nameOf(g, 1 - me) }), what: t('wait.hand', { name: nameOf(g, 1 - me) }), body: '' });
  }
  const order = [r.first, 1 - r.first];
  const p = me !== null ? undefined : ui.handView ?? order.find(q => !E.handDone(r, q));
  if (p !== undefined) return frame({ eyebrow: t('round', { n }), who: esc(nameOf(g, p)), title: t('hand.title', { name: nameOf(g, p) }), what: r.number === 1 ? t('hand.r1') : t('hand.discardWhat'),
    body: handPanel(g, p, { prep: true, guided: true }) });
  return frame({ eyebrow: t('round', { n }), who: t('g.both'), title: t('abil.title'), what: t('abil.what'), when: t('abil.when', { name: nameOf(g, r.first) }),
    body: `<form data-form="abilities"><label>${t('g.note')}<input name="note" maxlength="500"></label><div class="actions"><button class="ghost" name="status" value="none">${t('g.none')}</button><button class="primary" name="status" value="done">${t('g.done')}</button></div></form>` });
}
function quickPrep(g) {
  const r = g.rounds.at(-1), ready = r.twist && [0, 1].every(p => E.handDone(r, p));
  const twist = r.twist ? `<form data-form="twistQuick" id="twist-quick">${twistPanel(g, r, r.step === 'twistResolve')}</form>`
    : `<p class="hint">${t('tw.what')}</p>${twistRevealControls(g)}`;
  return `<section class="panel gold"><div class="eyebrow">${t('round', { n: r.number })}</div><h2>${t('st.roundStart', { n: r.number })}</h2>${roundMessages(g, r)}
      <h3>${t('tw.active')}</h3>${twist}</section>
    ${handsGrid(g, { prep: true })}
    <div class="actions">${ready ? '' : `<span class="hint">${t('q.prep.need')}</span>`}<button class="primary" data-act="ui:quickStartTurns" ${ready ? '' : 'disabled'}>${t('q.startTurn', { name: nameOf(g, r.first) })}</button></div>`;
}

/* ---------- hands ---------- */
// One device per player shows only its own hand; the other side is a status line.
function handsGrid(g, o = {}) {
  const me = meOf(g), r = g.rounds.at(-1);
  if (me === null) return `<div class="grid">${[0, 1].map(p => `<section class="panel side-${p ? 'b' : 'a'}">${handPanel(g, p, o)}</section>`).join('')}</div>`;
  const opp = 1 - me, oppLine = o.prep && g.play === 'linked' ? `<span class="badge">${E.handDone(r, opp) ? t('hand.done') : t('hand.pending')}</span>` : '';
  return `<section class="panel side-${me ? 'b' : 'a'}">${handPanel(g, me, o)}</section><p class="hint">${t('opp.hand', { name: nameOf(g, opp) })} ${oppLine}</p>`;
}
function outList(g, p) {
  const out = g.decks.players[p].out;
  return `<details class="public"><summary>${t('hand.public')} (${out.length})</summary>${out.map(o => `<div class="tally"><span>${nm(E.card(o.id).name)}</span><span>${t('round.short', { n: o.round })} · ${t('hand.out.' + o.status)}</span></div>`).join('') || `<p class="hint">—</p>`}</details>`;
}
function handPanel(g, p, o = {}) {
  const r = g.rounds.at(-1), deck = g.decks.players[p], other = 1 - p, h = r?.hands[p];
  const head = `<div class="row between hand-head"><h3>${o.guided ? '' : esc(nameOf(g, p))} <span class="badge">${t('hand.count', { n: deck.hand.length })}</span> <span class="badge">${t('hand.deckLeft', { n: deck.draw.length })}</span>
    ${o.prep ? `<span class="badge ${r.blocked[p] ? 'no' : 'ok'}">${r.blocked[p] ? t('refill.no') : t('refill.ok')}</span> <span class="badge">${E.handDone(r, p) ? t('hand.done') : t('hand.pending')}</span>` : ''}</h3></div>`;
  const own = meOf(g) === p;
  if (!ui.reveal[p] && !own) {
    return head + `<div class="cover"><p>${t('hand.cover', { name: nameOf(g, p), other: nameOf(g, other) })}</p><button class="primary" data-act="ui:reveal" data-v="${p}" data-guided="${o.guided ? 1 : ''}">${t('hand.show', { name: nameOf(g, p) })}</button><p class="hint small">${t('hand.coverNote')}</p></div>` + outList(g, p);
  }
  let body = '';
  const blockedMsg = o.prep && r.blocked[p] ? `<p class="notice">${r.seized ? t('seize.blocked', { name: nameOf(g, p) }) : ''}</p>` : '';
  const drawBtn = () => `<button class="primary" data-act="drawHand" data-args="${args({ player: p })}">${r.blocked[p] ? t('hand.blockedGo') : deck.hand.length ? t('hand.draw') : t('hand.drawR1')}</button>`;
  if (o.prep && !r.twist) {
    body = `<p class="notice">${t('E_TWIST_FIRST')}</p>${deck.hand.map(id => cardView(E.card(id))).join('')}`;
  } else if (o.prep && h.discarded === null && deck.hand.length) {
    body = `${blockedMsg}<p class="hint">${t('hand.discardWhat')}</p><form data-form="discard" data-p="${p}">${deck.hand.map(id => cardView(E.card(id), { actions: `<label class="check discard"><input type="checkbox" name="ids" value="${id}"> ${t('hand.discardMark')}</label>` })).join('')}
      <div class="actions"><button class="primary" data-discard-btn>${t('hand.keepAll')}</button></div></form>`;
  } else if (o.prep && h.drawn === null) {
    body = `${blockedMsg}${deck.hand.length ? '' : `<p class="hint">${t('hand.r1')}</p>`}${deck.hand.map(id => cardView(E.card(id))).join('')}<div class="actions">${drawBtn()}</div>`;
  } else {
    const fresh = o.prep ? h.drawn : [];
    const turnCmd = !o.prep && g.stage === 'turn';
    body = (o.prep ? `<p class="hint">${fresh.length ? t('hand.drawn', { n: fresh.length }) : t('hand.drawnNone')}</p>${blockedMsg}` : '') +
      (deck.hand.map(id => cardView(E.card(id), {
        badge: fresh.includes(id) ? `<span class="badge new">${t('hand.new')}</span>` : '',
        actions: turnCmd ? cmdButton(g, p, id) : ''
      })).join('') || `<div class="empty">${t('hand.empty')}</div>`);
  }
  const close = own ? (o.guided && E.handDone(r, p) ? `<div class="actions"><button class="primary" data-act="ui:hide" data-v="${p}">${t('ack')}</button></div>` : '')
    : `<div class="actions"><button class="ghost" data-act="ui:hide" data-v="${p}">${t('hand.hide')}</button></div>`;
  return head + body + close + outList(g, p);
}
function cmdButton(g, p, id) {
  const c = E.card(id);
  return `<button data-act="useCommand" data-args="${args({ player: p, id })}" data-confirm="${esc(t('cmd.confirm', { card: L(c.command.name) }))}">${t('cmd.use')}</button>`;
}

/* ---------- turns ---------- */
function candidates(g, holder, phase) {
  const active = g.turn.player;
  return g.decks.players[holder].hand.filter(id => {
    const w = Engine.timingWindows(E.card(id).command.timing.en);
    if (!w.phases.includes(phase)) return false;
    return w.whose === 'any' || (w.whose === 'own' ? holder === active : holder !== active);
  });
}
function candidateBox(g, phase) {
  const me = meOf(g);
  if (me !== null) {
    if (!g.decks.players[me]) return '';
    const list = candidates(g, me, phase);
    return `<div class="cand"><h3>${t('cand.title')}</h3><p class="hint small">${t('cand.note')}</p>${list.map(id => cardView(E.card(id), { cls: 'compact', actions: cmdButton(g, me, id) })).join('') || `<p class="hint">${t('cand.none')}</p>`}</div>`;
  }
  return `<div class="cand"><h3>${t('cand.title')}</h3><p class="hint small">${t('cand.note')}</p><div class="grid">${[0, 1].map(p => {
    if (!ui.cand[p]) return `<div><button data-act="ui:cand" data-v="${p}">${t('cand.show', { name: nameOf(g, p) })}</button></div>`;
    const list = candidates(g, p, phase);
    return `<div><div class="row between"><b>${esc(nameOf(g, p))}</b><button class="ghost" data-act="ui:cand" data-v="${p}">${t('cand.hide')}</button></div>${list.map(id => cardView(E.card(id), { cls: 'compact', actions: cmdButton(g, p, id) })).join('') || `<p class="hint">${t('cand.none')}</p>`}</div>`;
  }).join('')}</div></div>`;
}
function refsFor(g, phase) {
  const active = g.features.filter(f => !f.removed).map(f => featureAbility(f.id)).filter(Boolean);
  const match = a => { const s = a.timing.en.toLowerCase(); return s.includes(phase) || (phase === 'end' && s.includes('end of')) || s === 'passive'; };
  const list = active.filter(match);
  return list.length ? `<details><summary>${t('ref.relevant')} (${list.length})</summary>${list.map(a => cardView(a, { cls: 'compact' })).join('')}</details>` : '';
}
function twistMini(g) {
  const r = g.rounds.at(-1); if (!r?.twist) return '';
  const c = E.card(r.twist);
  return `<details class="twist-mini"><summary>${t('tw.active')}: ${nm(c.name)}</summary>${cardView(c, { cls: 'compact' })}${r.twistNote ? `<p class="hint">${t('tw.note')}: ${esc(r.twistNote)}</p>` : ''}</details>`;
}
function phaseChips(g, cur) {
  const tn = g.turn;
  return `<ol class="phases">${PH.map((ph, i) => `<li class="${i === cur ? 'cur' : ''} ${tn.log[i] || ''}"><span>${t('ph.' + ph)}</span>${tn.log[i] ? `<small>${t('ph.log.' + tn.log[i])}</small>` : ''}</li>`).join('')}</ol>`;
}
function guidedTurn(g) {
  const tn = g.turn, p = tn.player, r = g.rounds.at(-1), N = x => nameOf(g, x);
  const eyebrow = `${t('round', { n: r.number })} · ${p === r.first ? t('first') : t('second')}`;
  const me = meOf(g);
  if (g.play === 'linked' && me !== p && !tn.afterScore) {
    const ph = tn.phase === null ? null : PH[tn.phase];
    return frame({ eyebrow, who: esc(N(p)), title: `${ph ? t('ph.' + ph) + ' — ' : ''}${esc(N(p))}`, what: t('wait.turn', { name: N(p) }),
      body: (tn.phase !== null ? phaseChips(g, tn.phase) : '') + twistMini(g) + (ph ? `<div class="notice"><b>${t('react.title')}</b><br>${t('react.what')}</div>` + candidateBox(g, ph) : '') + `<h3>${t('hand.title', { name: N(me) })}</h3>` + handPanel(g, me) });
  }
  if (tn.afterScore) return frame({ eyebrow, who: t('g.both'), title: t('after.title'), what: t('after.what'),
    body: cardView(E.card(r.twist), { cls: 'compact' }) + `<div class="actions"><button class="primary" data-act="ackAfterScore" data-args="${args({ tracked: true })}">${t('after.btn')}</button></div>` });
  if (tn.phase === null) return frame({ eyebrow, who: esc(N(p)), title: t('ph.where'), what: t('ph.whereWhat'),
    body: `<div class="choice-grid">${PH.map((ph, i) => `<button data-act="setPhase" data-args="${args({ phase: i })}">${t('ph.' + ph)}</button>`).join('')}</div>` });
  const peek = ui.peek !== null && ui.peek < tn.phase ? ui.peek : null, idx = peek ?? tn.phase, ph = PH[idx];
  const reaction = ['movement', 'shooting', 'charge', 'combat'].includes(ph) ? `<div class="notice"><b>${t('react.title')}</b><br>${t('react.what')}</div>` : '';
  let body = phaseChips(g, idx);
  if (peek !== null) body += `<p class="warnbox">${t('ph.peekBanner')}</p>`;
  body += reaction + twistMini(g) + refsFor(g, ph);
  if (peek !== null) body += `<div class="actions"><button class="primary" data-act="ui:peek" data-v="">${t('ph.back')}</button></div>`;
  else if (ph === 'end') body += candidateBox(g, ph) + scoreForm(g) + (idx > 0 ? `<div class="actions"><button class="ghost" data-act="ui:peek" data-v="${idx - 1}">${t('ph.peek')}</button></div>` : '');
  else body += candidateBox(g, ph) + `<div class="actions">${idx > 0 ? `<button class="ghost" data-act="ui:peek" data-v="${idx - 1}">${t('ph.peek')}</button>` : ''}
      <button class="ghost" data-act="completePhase" data-args="${args({ status: 'none', phase: idx })}">${t('ph.none')}</button>
      <button class="primary" data-act="completePhase" data-args="${args({ status: 'done', phase: idx })}">${t('g.done')}</button></div>`;
  return frame({ eyebrow, who: ph === 'combat' ? t('g.both') : `${esc(N(p))}${ph === 'combat' ? '' : ''}`, title: `${t('ph.' + ph)} — ${esc(N(p))}`,
    what: t('ph.' + ph + '.what', { name: N(p) }), when: ph === 'end' ? '' : t('ph.when'), body });
}
function quickTurn(g) {
  const tn = g.turn, p = tn.player, r = g.rounds.at(-1);
  const main = tn.afterScore
    ? `<p class="notice">${t('after.what')}</p>${cardView(E.card(r.twist), { cls: 'compact' })}<div class="actions"><button class="primary" data-act="ackAfterScore" data-args="${args({ tracked: isLinked() })}">${t('after.btn')}</button></div>`
    : scoreForm(g);
  return `<section class="panel gold"><div class="eyebrow">${t('round', { n: r.number })} · ${p === r.first ? t('first') : t('second')}</div><h2>${t('st.turn', { n: r.number, name: nameOf(g, p), phase: '' }).replace(/\s*\/\s*$/, '')}</h2>
    ${roundMessages(g, r, true)}${tn.phase !== null ? phaseChips(g, tn.phase) : ''}${twistMini(g)}${main}</section>
    ${handsGrid(g)}`;
}
function scoreForm(g) {
  const p = g.turn.player, r = g.rounds.at(-1), key = `${g.id}:${r.number}:${p}`, d = S.db.draft.score?.key === key ? S.db.draft.score : {};
  const me = meOf(g);
  if (me !== null && me !== p) {
    if (g.play === 'linked') return `<p class="notice">${t('wait.score', { name: nameOf(g, p) })}</p>`;
    return `<form data-form="manualScore"><h3>${t('manual.title', { name: nameOf(g, p) })}</h3><p class="hint">${t('manual.what', { name: nameOf(g, p) })}</p>
      <div class="fields"><label>${t('manual.total')}<span class="stepper"><button type="button" data-step="-1" aria-label="-1">−</button><input type="number" inputmode="numeric" name="manualTotal" min="0" max="30" step="1" value="0" required><button type="button" data-step="1" aria-label="+1">+</button></span></label>
      <label>${t('re.reason')}<input name="reason" maxlength="500"></label></div><div class="actions"><button class="primary">${t('manual.btn')}</button></div></form>`;
  }
  const tw = E.card(r.twist), hand = g.decks.players[p].hand;
  const tactics = ui.reveal[p] || me === p
    ? hand.map(id => { const c = E.card(id); return `<label class="check tactic"><input type="checkbox" name="ids" value="${id}" ${(d.ids || []).includes(id) ? 'checked' : ''}> <span><b>${nm(c.name)}</b> <span class="vp">${t('card.vp', { n: c.score.vp })}</span><br><small>${esc(L(c.score.condition))}</small></span></label>`; }).join('') || `<p class="hint">${t('hand.empty')}</p>`
    : `<p class="hint">${t('sc.tacticsHidden', { name: nameOf(g, p) })}</p><button type="button" data-act="ui:reveal" data-v="${p}">${t('sc.tacticsShow', { name: nameOf(g, p) })}</button>`;
  const twistField = tw.scoreTiming === 'own_turn_end' ? `<label>${t('sc.twist', { card: L(tw.name) })}<input type="number" inputmode="numeric" name="twistVp" min="0" max="20" step="1" value="${esc(d.twistVp ?? 0)}"><small class="hint">${esc(L(tw.mechanics))}</small></label>` : '';
  const num = (n, label, v, min = 0) => `<label>${label}<span class="stepper"><button type="button" data-step="-1" aria-label="-1">−</button><input type="number" inputmode="numeric" name="${n}" min="${min}" max="20" step="1" value="${esc(v)}" required><button type="button" data-step="1" aria-label="+1">+</button></span></label>`;
  return `<form data-form="score" id="score-form" data-key="${esc(key)}"><h3>${t('sc.title', { name: nameOf(g, p) })}</h3><p class="hint small">${t('sc.basic')}</p>
    <div class="fields">${num('own', t('sc.own', { name: nameOf(g, p) }), d.own ?? 0)}${num('enemy', t('sc.enemy'), d.enemy ?? 0)}</div><p class="hint small">${t('sc.objHint')}</p>
    <h4>${t('sc.tactics')}</h4>${tactics}
    <div class="fields">${twistField}${num('extra', t('sc.extra'), d.extra ?? 0, -20)}<label>${t('sc.reason')}<input name="reason" maxlength="500" placeholder="${t('sc.reason.ph')}" value="${esc(d.reason || '')}"></label></div>
    <div id="score-preview" aria-live="polite"></div><div class="actions"><button class="primary">${t('sc.btn')}</button></div></form>`;
}
function readScore(f) {
  const d = new FormData(f);
  return { own: d.get('own'), enemy: d.get('enemy'), ids: d.getAll('ids'), twistVp: d.get('twistVp') ?? 0, extra: d.get('extra'), reason: d.get('reason') || '' };
}
function updatePreview() {
  const f = $('#score-form'), el = $('#score-preview'); if (!f || !el) return;
  try {
    const s = E.previewTurn(readScore(f));
    el.innerHTML = `<div class="tally"><span>${t('sc.obj')}</span><b>${s.objective}</b></div><div class="tally"><span>${t('sc.tac')} / ${t('sc.tw')} / ${t('sc.ex')}</span><b>${s.tactics} / ${s.twistVp} / ${s.extra}</b></div><div class="tally total"><span>${t('sc.total')}</span><b>${s.total} VP</b></div>`;
  } catch (e) { el.innerHTML = `<p class="warn">${e.code ? t(e.code, e.vars) : ''}</p>`; }
}

/* ---------- round end / result ---------- */
function roundEndView(g) {
  const r = g.rounds.at(-1), tw = E.card(r.twist), final = r.number === 4;
  const d = S.db.draft.bonus?.key === `${g.id}:${r.number}` ? S.db.draft.bonus : {};
  return `<section class="panel gold guide-step"><div class="eyebrow">${t('round', { n: r.number })}</div><h2>${t('re.title', { n: r.number })}</h2>
    ${mode() === 'guided' ? `<p class="what"><b>${t('g.what')}</b>${t('re.what')}</p>` : ''}
    ${tw.scoreTiming === 'round_end' ? `<p class="notice">${t('re.twistRound')}</p>${cardView(tw, { cls: 'compact twist' })}` : twistMini(g)}
    <p class="hint">${t('re.expire', { name: L(tw.name) })}</p>
    <form data-form="roundEnd" data-key="${g.id}:${r.number}"><div class="fields">${[0, 1].map(p => `<label>${t('re.bonus', { name: nameOf(g, p) })}<input type="number" inputmode="numeric" name="bonus${p}" min="-20" max="20" step="1" required value="${esc(d['bonus' + p] ?? 0)}"></label>`).join('')}
    <label class="full">${t('re.reason')}<input name="note" maxlength="500" value="${esc(d.note || '')}"></label></div>
    <div class="actions"><button class="primary">${final ? t('re.btnFinal') : t('re.btn')}</button></div></form></section>`;
}
function finishedView(g) {
  const res = E.result(g);
  return `<section class="panel gold"><div class="eyebrow">${t('fin.title')}</div><h1>${res.winner === null ? t('fin.draw') : t('fin.win', { name: nameOf(g, res.winner) })} · ${res.scores[0]} : ${res.scores[1]}</h1>
    <p>${t('fin.saved')}</p><div class="actions"><button data-act="ui:page" data-v="history">${t('fin.history')}</button><button class="primary" data-act="ui:new">${t('fin.new')}</button></div></section>`;
}
function scoreTable(g) {
  const cell = (r, p) => { const tn = r?.turns[p]; if (!tn) return '—'; const b = r.closed ? r.bonus[p] : 0; return `${tn.total + b} <small class="hint">(${t('sc.obj')} ${tn.objective} · ${t('sc.tac')} ${tn.tactics} · ${t('sc.tw')} ${tn.twistVp} · ${t('sc.ex')} ${tn.extra + b})</small>`; };
  return `<div class="table-wrap"><table><thead><tr><th>${t('table.round')}</th><th>${t('table.first')}</th><th>${t('table.ud')}</th><th>${esc(nameOf(g, 0))}</th><th>${esc(nameOf(g, 1))}</th><th>${t('table.twist')}</th></tr></thead><tbody>
    ${[1, 2, 3, 4].map(n => { const r = g.rounds[n - 1]; return `<tr><td>${t('round.short', { n })}</td><td>${r ? esc(nameOf(g, r.first)) : '—'}</td><td>${r ? (r.underdog === null ? '—' : esc(nameOf(g, r.underdog))) : '—'}</td><td>${cell(r, 0)}</td><td>${cell(r, 1)}</td><td>${r?.twist ? nm(E.card(r.twist).name) : '—'}</td></tr>`; }).join('')}
    </tbody></table></div>`;
}
function recordPanel(g) { return `<details class="panel" ${g.status === 'finished' ? 'open' : ''}><summary>${t('rec.title')}</summary>${scoreTable(g)}</details>`; }
function infoPanel(g) {
  return `<details class="panel"><summary>${t('info.title')}</summary>${setupRecord(g)}<label>${t('info.notes')}<textarea id="notes" maxlength="5000">${esc(g.notes)}</textarea></label></details>`;
}
function featuresPanel(g) {
  if (g.config.pack === 'fire') return '';
  const placed = g.features.filter(f => !f.removed), ids = placeables(g.config.pack).filter(id => !placed.some(f => f.id === id));
  return `<details class="panel"><summary>${t('ref.title')} (${placed.length})</summary>
    ${placed.map(f => cardView(featureAbility(f.id), { cls: 'compact', badge: `<span class="badge">${nm(featureName(f.id))} · ${f.round ? t('ref.round', { n: f.round }) : t('ref.setup')}</span>`, actions: `<button class="ghost" data-act="toggleFeature" data-args="${args({ id: f.id })}">${t('ref.remove')}</button>` })).join('') || `<p class="hint">${t('ref.none')}</p>`}
    ${ids.length ? `<div class="row">${ids.map(id => `<button class="ghost" data-act="toggleFeature" data-args="${args({ id })}">+ ${nm(featureName(id))}</button>`).join('')}</div><p class="hint small">${t('ref.add')}</p>` : ''}
    ${g.config.pack === 'ash' ? `<p class="hint small">${t('relic.rules')}</p>` : `<p class="hint small">${t('icon.note')}</p>`}</details>`;
}

/* ---------- history ---------- */
function outcome(h) { const r = E.result(h), me = h.mySeat ?? 0; return r.winner === null ? 'draw' : r.winner === me ? 'win' : 'loss'; }
function historyPage() {
  const hs = S.db.history, w = hs.filter(h => outcome(h) === 'win').length, d = hs.filter(h => outcome(h) === 'draw').length;
  return `<div class="titlebar"><h1>${t('hist.title')}</h1><p>${t('hist.desc')}</p></div>
    <div class="grid"><div class="panel"><div class="stat">${w} <small>${t('hist.wins', { n: hs.length })}</small></div></div><div class="panel"><div class="stat">${hs.length ? Math.round(w / hs.length * 100) : 0}% <small>${t('hist.rate', { d })}</small></div></div></div>
    <div class="row between"><p class="hint">${t('hist.backupNote')}</p><div class="row"><button data-act="ui:export">${t('hist.export')}</button><button data-act="ui:import">${t('hist.import')}</button><input type="file" id="import-file" accept="application/json,.json" hidden></div></div>
    ${hs.map(h => { const s = E.totals(h); return `<details class="panel archive ${outcome(h)}"><summary>${t('hist.' + outcome(h))} · ${s[0]} : ${s[1]} · ${esc(h.config.players[0].army)} vs ${esc(h.config.players[1].army)}</summary>
      <p class="hint">${new Date(h.finished).toLocaleString(lang() === 'ko' ? 'ko-KR' : 'en-GB')} · ${nm(E.pack(h.config.pack).name)} · ${nm(realmOf(h.config.pack, h.config.realm).name)}</p>${scoreTable(h)}${setupRecord(h)}
      ${h.notes ? `<p class="hint">${esc(h.notes)}</p>` : ''}</details>`; }).join('') || `<div class="empty">${t('hist.empty')}</div>`}`;
}

/* ---------- guide ---------- */
function guidePage() {
  const P = E.pack(ui.catalog);
  return `<div class="titlebar"><h1>${t('guide.title')}</h1><p>${t('guide.desc')}</p></div>
  <div class="grid"><section class="panel gold"><h2>${t('guide.auto')}</h2><ul class="steps">${t('guide.auto.list').map(x => `<li>${esc(x)}</li>`).join('')}</ul></section>
  <section class="panel"><h2>${t('guide.manual')}</h2><p>${t('guide.manual.text')}</p>${Object.keys(CHECK_POINTS).length ? `<h3>${t('guide.issues')}</h3>` : ''}${Object.entries(CHECK_POINTS).map(([id, cp]) => `<p class="warnbox small"><b>${nm((E.cards[id] || refById(id)).name)}</b><br>${t('tw.manual')}<br>${t('card.checkPoint')}: ${esc(L(cp))}</p>`).join('')}</section></div>
  <section class="panel"><h2>${t('guide.cards')}</h2><div class="seg wide" role="group">${DATA.packs.map(p => `<button data-act="ui:catalog" data-v="${p.id}" aria-pressed="${ui.catalog === p.id}">${esc(L(p.name))}</button>`).join('')}</div>
    <h3>${t('guide.tactics')}</h3><div class="card-grid">${P.tactics.map(c => cardView(c)).join('')}</div>
    ${P.sourcePlayNote ? `<p class="hint">${esc(L(P.sourcePlayNote))}</p>` : ''}
    ${P.realms.map(r => `<h3>${t('guide.twists', { realm: L(r.name) })}</h3><div class="card-grid">${P.deckManifest.twistsByRealm[r.id].map(id => cardView(E.card(id))).join('')}</div>`).join('')}
    ${P.referenceAbilities.length ? `<h3>${t('guide.refs')}</h3><div class="card-grid">${P.referenceAbilities.map(c => cardView(c)).join('')}</div>` : ''}
    <h3>${t('guide.errata')}</h3>${P.errataNotes.map(e => `<p class="errata">${esc(L(e.mechanics))} <a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">PDF ↗</a></p>`).join('')}</section>
  <section class="panel"><h2>${t('guide.sources')}</h2><p class="hint">${t('guide.sourceNote')}</p><ul class="steps">
    <li><a href="${esc(ERRATA_URL)}" target="_blank" rel="noopener noreferrer">Official Rules Updates, September 2026 ↗</a></li>
    <li><a href="https://assets.warhammer-community.com/ageofsigmar_corerules%26keydownloads_spearheadreferece_eng_24.09-jrpbcnzwuu.pdf" target="_blank" rel="noopener noreferrer">Official Spearhead Reference ↗</a></li>
    <li><a href="https://www.warhammer-community.com/en-gb/downloads/warhammer-age-of-sigmar/" target="_blank" rel="noopener noreferrer">Warhammer Community downloads ↗</a></li></ul></section>`;
}

/* ---------- event wiring ---------- */
const uiActions = {
  page: b => { page = b.dataset.v; ui.reveal = [false, false]; ui.cand = [false, false]; render(); window.scrollTo(0, 0); },
  lang: b => { S.setPref('lang', b.dataset.v); render(); },
  mode: b => { S.setPref('mode', b.dataset.v); ui.peek = null; render(); },
  device: b => { S.setPref('device', b.dataset.v); render(); },
  pickTwist: b => { ui.pickTwist = !!b.dataset.v; render(); },
  createRoom: () => ensureLink().then(l => l.createRoom(0)).then(() => { S.setPref('device', 'linked'); render(); }).catch(e => { handleErr(e); render(); }),
  share: () => {
    const url = location.origin + location.pathname + '?room=' + S.db.link.room;
    if (navigator.share) navigator.share({ title: 'Spearhead Fieldbook', text: stripTags(t('room.shareText', { code: S.db.link.room })), url }).catch(() => {});
    else navigator.clipboard?.writeText(url).then(() => toast(t('room.copied')));
  },
  leave: () => confirmDialog(t('room.leaveConfirm'), () => { if (LK) LK.leave(); else S.setLink(null); resetUi(); render(); }),
  undo: () => {
    if (isLinked()) return confirmDialog(t('room.undoConfirm'), () => { busy = true; render(); LK.undo().then(ok => ok && toast(t('undo.done'))).catch(handleErr).finally(() => { busy = false; resetUi(); render(); }); });
    if (S.undo()) { ui.reveal = [false, false]; ui.cand = [false, false]; ui.handView = null; ui.peek = null; toast(t('undo.done')); } render(); },
  reveal: b => { const p = +b.dataset.v; ui.reveal = [false, false]; ui.reveal[p] = true; if (b.dataset.guided) ui.handView = p; render(); },
  hide: b => { ui.reveal[+b.dataset.v] = false; ui.handView = null; render(); $('#status')?.scrollIntoView({ block: 'start' }); },
  cand: b => { const p = +b.dataset.v, open = !ui.cand[p]; ui.cand = [false, false]; ui.cand[p] = open; render(); },
  peek: b => { ui.peek = b.dataset.v === '' ? null : +b.dataset.v; render(); },
  prio: b => { const v = b.dataset.v; S.setDraft('prio', v === '' ? undefined : { game: S.db.game.id, round: S.db.game.rounds.length + 1, winner: v === 'tie' ? 'tie' : +v }); render(); },
  setupBack: () => act('setupBack'),
  catalog: b => { ui.catalog = b.dataset.v; render(); },
  abandon: () => confirmDialog(`<b>${t('abandon.title')}</b><br>${t('abandon.desc')}`, () => { S.abandon(); resetUi(); render(); }),
  new: () => { if (LK) LK.leave(); S.abandon(); resetUi(); render(); },
  export: () => {
    const blob = new Blob([S.exportData()], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'spearhead-fieldbook-' + new Date().toISOString().slice(0, 10) + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  import: () => $('#import-file').click(),
  quickStartTurns: () => {
    const f = $('#twist-quick'), d = f ? new FormData(f) : null;
    act('startTurns', { twistNote: d?.get('note') ?? undefined, features: d ? d.getAll('features') : [], abilities: 'unrecorded', tracked: isLinked() }, () => { ui.reveal = [false, false]; S.setDraft('twistNote'); });
  }
};
function resetUi() { ui.reveal = [false, false]; ui.cand = [false, false]; ui.handView = null; ui.peek = null; ui.pickTwist = false; page = 'battle'; }

const forms = {
  players(f) {
    const d = Object.fromEntries(new FormData(f));
    const payload = { pack: d.pack, players: [0, 1].map(i => ({ name: d['name' + i], faction: d['faction' + i], army: d['army' + i] })) };
    if (isLinked()) return LK.startGame(payload).then(() => S.setDraft('setup')).catch(handleErr).finally(render);
    try { S.startGame({ ...payload, play: S.db.prefs.device === 'solo' ? 'solo' : 'shared' }); S.setDraft('setup'); }
    catch (e) { handleErr(e); }
    render();
  },
  quickSetup(f) {
    const d = Object.fromEntries(new FormData(f));
    if (!d.confirm) return toast(t('qs.confirmNeeded'));
    const g0 = S.db.game, pack = g0?.decks ? g0.config.pack : d.pack, realm = g0?.decks ? g0.config.realm : d.realm;
    const players = [0, 1].map(i => ({ name: d['name' + i], faction: d['faction' + i], army: d['army' + i], regiment: d['regiment' + i], enhancement: d['enhancement' + i] }));
    const qs = { pack, realm, players, attacker: +d.attacker, rolloffWinner: d.rolloff === '' ? null : +d.rolloff, map: d.map, territories: d.territories, group: d.group, relic: d.relic };
    if (isLinked()) return (g0 ? Promise.resolve() : LK.startGame({ pack, players })).then(() => LK.dispatch('quickSetup', qs)).then(() => S.setDraft('setup')).catch(handleErr).finally(render);
    try {
      if (!g0) S.startGame({ pack, players, play: S.db.prefs.device === 'solo' ? 'solo' : 'shared' });
      S.dispatch('quickSetup', { pack, realm, players, attacker: +d.attacker, rolloffWinner: d.rolloff === '' ? null : +d.rolloff, map: d.map, territories: d.territories, group: d.group, relic: d.relic });
      S.setDraft('setup');
    } catch (e) { handleErr(e); }
    render();
  },
  setup(f, sub) {
    const step = f.dataset.step, d = Object.fromEntries(new FormData(f));
    const v = { step, status: sub?.name === 'status' ? sub.value : 'done' };
    if (step === 'rolloff') { if (sub?.name === 'winner') v.winner = +sub.value; else v.rolls = [d.r0, d.r1]; }
    else if (step === 'roles') v.choice = sub?.value;
    else Object.assign(v, d);
    act('setupAction', v);
  },
  priority(f) {
    const d = Object.fromEntries(new FormData(f));
    if (S.db.game.rounds.length === 0) return act('beginRound', { first: +d.first });
    if (d.winner === '' || d.first === '') return toast(t('E_REQUIRED'));
    act('beginRound', d.winner === 'tie' ? { first: +d.first, tie: true } : { first: +d.first, priorityWinner: +d.winner });
  },
  twist(f) { const d = new FormData(f); act('resolveTwist', { note: d.get('note'), features: d.getAll('features') }, () => S.setDraft('twistNote')); },
  twistQuick() { /* submitted via start button */ },
  discard(f) { const p = +f.dataset.p; act('confirmDiscard', { player: p, ids: new FormData(f).getAll('ids') }); },
  abilities(f, sub) { const d = new FormData(f); act('startTurns', { abilities: sub?.value || 'done', note: d.get('note'), tracked: true }, () => { ui.reveal = [false, false]; }); },
  score(f) {
    const g = S.db.game, s = readScore(f), tw = E.card(g.rounds.at(-1).twist);
    act('endTurn', { ...s, afterScore: afterScoreTwist(tw), tracked: mode() === 'guided' || isLinked() }, () => { S.setDraft('score'); ui.reveal = [false, false]; ui.cand = [false, false]; ui.peek = null; });
  },
  join(f) {
    const code = new FormData(f).get('code');
    ensureLink().then(l => l.joinRoom(code, 1)).then(() => { S.setPref('device', 'linked'); render(); }).catch(e => { handleErr(e); render(); });
  },
  manualScore(f) {
    const d = new FormData(f), tw = E.card(S.db.game.rounds.at(-1).twist);
    act('endTurn', { manualTotal: d.get('manualTotal'), reason: d.get('reason'), afterScore: afterScoreTwist(tw), tracked: mode() === 'guided' || isLinked() });
  },
  roundEnd(f) { const d = Object.fromEntries(new FormData(f)); act('closeRound', { bonus: [d.bonus0, d.bonus1], note: d.note }, () => S.setDraft('bonus')); }
};

document.addEventListener('click', e => {
  const stepBtn = e.target.closest('[data-step]');
  if (stepBtn && stepBtn.closest('.stepper')) {
    const input = stepBtn.parentElement.querySelector('input'), v = (Number(input.value) || 0) + Number(stepBtn.dataset.step);
    input.value = Math.max(Number(input.min), Math.min(Number(input.max), v));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const chip = e.target.closest('[data-fill]');
  if (chip) {
    const input = chip.closest('form').querySelector(`[name="${chip.dataset.fill}"]`);
    input.value = chip.dataset.v;
    chip.parentElement.querySelectorAll('[data-fill]').forEach(x => x.setAttribute('aria-pressed', String(x === chip)));
    return;
  }
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const a = b.dataset.act;
  if (a.startsWith('ui:')) return uiActions[a.slice(3)](b);
  if (performance.now() - lastRender < 350) return; // swallow the second click of a double click
  const payload = b.dataset.args ? JSON.parse(b.dataset.args) : {};
  if (b.dataset.confirm) return confirmDialog(esc(b.dataset.confirm), () => act(a, payload));
  if (a === 'drawHand' || a === 'revealTwist') { ui.cand = [false, false]; ui.pickTwist = false; }
  // on the player's own phone, keep the freshly drawn cards on screen until they press OK
  act(a, payload, a === 'drawHand' && meOf(S.db.game) === payload.player ? () => { ui.handView = payload.player; } : undefined);
});
document.addEventListener('submit', e => {
  const f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault();
  if (performance.now() - lastRender < 350) return;
  forms[f.dataset.form](f, e.submitter);
});
document.addEventListener('input', e => {
  const f = e.target.closest('form');
  if (e.target.id === 'notes') return S.setNotes(e.target.value);
  if (!f) return;
  if (f.dataset.draft === 'setup') S.setDraft('setup', { ...(S.db.draft.setup || {}), ...Object.fromEntries(new FormData(f)), confirm: f.querySelector('[name=confirm]')?.checked || undefined, _game: S.db.game?.id });
  if (f.dataset.form === 'score') { S.setDraft('score', { key: f.dataset.key, ...readScore(f) }); updatePreview(); }
  if (f.dataset.form === 'roundEnd') S.setDraft('bonus', { key: f.dataset.key, ...Object.fromEntries(new FormData(f)) });
  if (e.target.dataset.twistnote) S.setDraft('twistNote', { round: S.db.game.rounds.length, v: e.target.value });
  if (f.dataset.form === 'discard') {
    const n = new FormData(f).getAll('ids').length, btn = f.querySelector('[data-discard-btn]');
    btn.textContent = stripTags(n ? t('hand.discardBtn', { n }) : t('hand.keepAll'));
  }
});
document.addEventListener('change', e => {
  if (e.target.dataset.rerender) {
    e.target.closest('form')?.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => { // let focus move to the next field first, then keep it there after re-render
      const name = document.activeElement?.name;
      render();
      if (name) document.querySelector(`[name="${name}"]`)?.focus();
    });
  }
  if (e.target.id === 'import-file' && e.target.files[0]) {
    const file = e.target.files[0];
    confirmDialog(t('hist.importConfirm'), () => file.text().then(txt => { try { S.importData(txt); resetUi(); toast(t('hist.imported')); } catch (err) { handleErr(err.code ? err : { code: 'E_IMPORT' }); } render(); }));
  }
});
window.addEventListener('storage', e => { if (e.key === S.KEY) { S.reload(); resetUi(); render(); toast(t('storage.otherTab')); } });

if (params.get('room') && !isLinked()) S.setPref('device', 'linked');
if (isLinked()) ensureLink().then(l => l.resume()).catch(handleErr).finally(render);
render();
