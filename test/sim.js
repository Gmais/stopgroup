// Simulação ponta a ponta: 4 jogadores reais (Socket.IO) em partida completa.
// Cobre: desconexão/reconexão, empate de votos, respostas repetidas, resposta inválida,
// STOP simultâneo, fim por cronômetro, modo "todos terminaram", permissões e privacidade.
import assert from 'node:assert/strict';
import { io as ioc } from 'socket.io-client';
import { createServer } from '../server/index.js';

const srv = createServer({ dbFile: ':memory:' });
const port = await srv.listen(0, '127.0.0.1');
const url = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓', msg); };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed++; console.log('  ✓', msg); };

class Client {
  constructor(name) {
    this.name = name; this.token = (name + '-token-').padEnd(32, 'x'); this.state = null; this.raw = [];
    this.connect();
  }
  connect() {
    this.s = ioc(url, { transports: ['websocket'], forceNew: true });
    this.s.on('state', (v) => { this.state = v; this.raw.push(JSON.stringify(v)); });
    return new Promise((r) => this.s.on('connect', r));
  }
  call(name, payload = {}) {
    return new Promise((res) => this.s.emit('call', name, payload, res));
  }
  async must(name, payload) {
    const r = await this.call(name, payload);
    assert.ok(r.ok, `${this.name} ${name}: ${r.error}`);
    return r.data;
  }
  async wait(pred, label, ms = 4000) {
    const t = Date.now();
    while (Date.now() - t < ms) { if (this.state && pred(this.state)) return this.state; await sleep(25); }
    throw new Error(`timeout: ${this.name} esperando ${label}`);
  }
  get me() { return this.state.you.id; }
  idOf(name) { return this.state.players.find((p) => p.name === name).id; }
  drop() { this.s.disconnect(); }
}

console.log('\n== Sala e entrada ==');
const [ana, bia, caio, duda] = ['Ana', 'Bia', 'Caio', 'Duda'].map((n) => new Client(n));
await Promise.all([ana, bia, caio, duda].map((c) => new Promise((r) => c.s.connected ? r() : c.s.on('connect', r))));

const created = await ana.must('room:create', { roomName: 'Sala Teste', adminName: 'Ana', maxPlayers: 4, token: ana.token, password: 'segredo' });
const code = created.code;
ok(/^[A-Z0-9]{5}$/.test(code), `código da sala gerado (${code})`);
const info = await bia.must('room:info', { code });
ok(info.hasPassword && info.name === 'Sala Teste', 'info da sala informa senha e nome');

let r = await bia.call('room:join', { code, name: 'Bia', token: bia.token, password: 'errada' });
ok(!r.ok && r.code === 'BAD_PASSWORD', 'senha incorreta é recusada');
await bia.must('room:join', { code, name: 'Bia', token: bia.token, password: 'segredo' });
r = await caio.call('room:join', { code, name: 'bia', token: caio.token, password: 'segredo' });
ok(!r.ok && r.code === 'DUP_NAME', 'nome duplicado (sem diferenciar maiúsculas) é recusado');
await caio.must('room:join', { code, name: 'Caio', token: caio.token, password: 'segredo' });
await duda.must('room:join', { code, name: 'Duda', token: duda.token, password: 'segredo' });
const eve = new Client('Eve'); await sleep(100);
r = await eve.call('room:join', { code, name: 'Eve', token: eve.token, password: 'segredo' });
ok(!r.ok && r.code === 'FULL', 'sala cheia recusa o quinto jogador');
eve.drop();
await ana.wait((s) => s.players.length === 4, '4 jogadores');
ok(ana.state.players.find((p) => p.isAdmin).name === 'Ana', 'administrador identificado');

console.log('\n== Permissões ==');
r = await bia.call('settings', { endModes: ['timer'] });
ok(!r.ok && r.code === 'FORBIDDEN', 'jogador comum não altera configurações');
r = await bia.call('round:start');
ok(!r.ok, 'jogador comum não inicia partida');
r = await bia.call('player:kick', { playerId: caio.me });
ok(!r.ok, 'jogador comum não remove ninguém');

console.log('\n== Rodada 1: STOP manual simultâneo, votação, empate ==');
const cats = ana.state.settings.categories.slice(0, 3).map((c, i) => ({ ...c, active: true }));
await ana.must('settings', {
  categories: ana.state.settings.categories.map((c, i) => ({ ...c, active: i < 3 })),
  endModes: ['manual'], validationMode: 'players', minVotes: 2, tieRule: 'admin', noRepeatLetters: true,
});
await ana.must('round:start');
await Promise.all([ana, bia, caio, duda].map((c) => c.wait((s) => s.phase === 'playing', 'rodada')));
const L1 = ana.state.round.letter;
const lowerL = L1.toLowerCase();
ok(duda.state.round.letter === L1 && caio.state.round.letter === L1, `todos veem a mesma letra (${L1})`);
const [c1, c2, c3] = ana.state.round.categories.map((c) => c.id);
eq(bia.state.round.categories.map((c) => c.id), [c1, c2, c3], 'mesma ordem de categorias para todos');

const fill = (c, a) => Promise.all([[c1, a[0]], [c2, a[1]], [c3, a[2]]].map(([id, t]) => c.must('answer', { catId: id, text: t })));
await fill(ana, [`${L1}ana`, `${lowerL}bolo`, `${L1}casa`]);
await fill(bia, [`  ${lowerL}ANA `, `${L1}xis`, '']);
await fill(caio, [`${L1}ana`, '123inválida', `${L1}casa`]);
await fill(duda, [`${L1}duda`, `${L1}BOLO`, `${L1}eco`]);
await sleep(500);
const seen = JSON.stringify(bia.state);
ok(!seen.includes(`${L1}duda`) && !seen.includes('123inv'), 'respostas alheias não vazam durante a rodada');
ok(bia.state.round.progress.find((p) => p.id === ana.me).filled === 3, 'progresso dos outros aparece só como contagem');

const stops = await Promise.all([bia.call('stop', { answers: { [c3]: '' } }), caio.call('stop', {})]);
ok(stops.filter((x) => x.ok).length === 1, 'STOP simultâneo: apenas um é oficial');
await Promise.all([ana, bia, caio, duda].map((c) => c.wait((s) => s.phase === 'validating', 'validação')));
const stopper = ana.state.round.stoppedBy;
ok(['Bia', 'Caio'].includes(stopper), `quem acionou o STOP foi registrado (${stopper})`);
await sleep(1000); // fora da tolerância de rede (800 ms)
r = await duda.call('answer', { catId: c1, text: 'Tarde demais' });
ok(r.ok && r.data.locked, 'respostas bloqueadas após o STOP');

await ana.wait((s) => s.round.board, 'revelação das respostas');
const entry = (c, catId, name) => c.state.round.board.find((b) => b.id === catId).entries.find((e) => e.name === name);
ok(entry(ana, c1, 'Duda').text === `${L1}duda`, 'respostas reveladas após o fim');
ok(ana.state.round.board.every((b) => b.entries.every((e) => e.catId === b.id && e.pid)), 'cada resposta traz catId/pid (os botões de voto e decisão dependem disso)');

// o autor não vota na própria resposta
r = await ana.call('vote', { authorId: ana.me, catId: c1, vote: 'v' });
ok(!r.ok, 'autor não pode votar na própria resposta');
r = await caio.call('vote', { authorId: caio.me, catId: c2, vote: 'v' });
ok(!r.ok, 'autor (Caio) também não');

// votos: Ana cat2 "bolo" => Bia v, Caio i, Duda u => empate 1x1
await bia.must('vote', { authorId: ana.me, catId: c2, vote: 'v' });
await caio.must('vote', { authorId: ana.me, catId: c2, vote: 'i' });
await duda.must('vote', { authorId: ana.me, catId: c2, vote: 'u' });
await ana.wait((s) => entry({ state: s }, c2, 'Ana').votes.v === 1, 'votos contados');
ok(entry(ana, c2, 'Ana').pending && entry(ana, c2, 'Ana').source === 'tie', 'empate de votos fica pendente para o administrador');
// Caio cat2 inválido por regra automática (não começa com a letra) — não aceita voto
r = await bia.call('vote', { authorId: caio.me, catId: c2, vote: 'v' });
ok(!r.ok, 'resposta que não começa com a letra não vai a voto');
ok(entry(ana, c2, 'Caio').status === 'invalid', 'resposta inválida detectada automaticamente');

// Duda cai e volta durante a votação
duda.drop(); await sleep(150);
await ana.wait((s) => s.players.find((p) => p.name === 'Duda').connected === false, 'Duda offline');
ok(true, 'desconexão de jogador refletida para os demais');
await duda.connect();
await duda.must('room:join', { code, token: duda.token });
await duda.wait((s) => s.round && s.round.board, 'estado de volta');
ok(entry(duda, c1, 'Duda').text === `${L1}duda`, 'reconexão preserva as respostas');
eq(duda.state.round.myAnswers[c3], `${L1}eco`, 'reconexão devolve respostas do próprio jogador');
await duda.must('vote', { authorId: ana.me, catId: c2, vote: 'u' });

for (const c of [bia, caio, duda]) await c.must('votes:confirm');
r = await bia.call('vote', { authorId: ana.me, catId: c2, vote: 'i' });
ok(!r.ok, 'voto não pode ser alterado após confirmação');
await ana.wait((s) => s.round.votesDone === 3, '3 confirmações');
r = await bia.call('decide', { authorId: ana.me, catId: c2, status: 'valid' });
ok(!r.ok && r.code === 'FORBIDDEN', 'jogador comum não decide respostas');
await ana.must('decide', { authorId: ana.me, catId: c2, status: 'invalid' });
await ana.must('votes:confirm');
await ana.wait((s) => s.phase === 'results', 'resultados');

const sc = ana.state.round.scores;
const pts = (name, catId) => entry(ana, catId, name).points;
eq([pts('Ana', c1), pts('Bia', c1), pts('Caio', c1), pts('Duda', c1)], [5, 5, 5, 10], 'cat1: três repetidas valem 5, a única vale 10 (ignora caixa/espaços)');
eq([pts('Ana', c2), pts('Bia', c2), pts('Caio', c2), pts('Duda', c2)], [0, 10, 0, 10], 'cat2: inválida 0 (decisão do admin); "bolo" invalidado não conta na duplicidade, então a da Duda vira única (10)');
eq([pts('Ana', c3), pts('Bia', c3), pts('Caio', c3), pts('Duda', c3)], [5, 0, 5, 10], 'cat3: branco 0, repetidas 5, única 10');
eq([sc[ana.me].total, sc[bia.me].total, sc[caio.me].total, sc[duda.me].total], [10, 15, 10, 30], 'totais da rodada corretos');
ok(entry(ana, c1, 'Duda').reason.includes('única'), 'justificativa de pontos exibida');

// ranking
const rk = ana.state.ranking;
eq(rk.map((x) => [x.name, x.total, x.pos]), [['Duda', 30, 1], ['Bia', 15, 2], ['Ana', 10, 3], ['Caio', 10, 3]], 'ranking com posição compartilhada em caso de empate');

// correção do admin recalcula sem duplicar pontos
await ana.must('validation:reopen');
await ana.must('decide', { authorId: ana.me, catId: c2, status: 'valid' });
await ana.must('validation:finalize');
await ana.wait((s) => s.phase === 'results', 'resultados 2');
eq(ana.state.ranking.find((x) => x.name === 'Ana').total, 15, 'correção recalcula (Ana 10→15, bolo agora repetido com Duda) sem somar duas vezes');
eq(ana.state.ranking.find((x) => x.name === 'Duda').total, 25, 'Duda recalculada (30→25), nada somado em duplicidade');

console.log('\n== Rodada 2: cronômetro ==');
await ana.must('settings', { endModes: ['timer'], timerSec: 10, validationMode: 'admin' });
await ana.must('round:start');
await duda.wait((s) => s.phase === 'playing' && s.round.n === 2, 'rodada 2');
const L2 = duda.state.round.letter;
ok(L2 !== L1, `letra não repete (${L1} → ${L2})`);
ok(ana.state.letters.used.length === 2 && ana.state.letters.history.length === 2, 'histórico de letras registrado');
const [d1, d2, d3] = duda.state.round.categories.map((c) => c.id);
await duda.must('answer', { catId: d1, text: `${L2}aaa` });
duda.drop(); await sleep(200); await duda.connect();
await duda.must('room:join', { code, token: duda.token });
await duda.wait((s) => s.phase === 'playing', 'reconectou na rodada');
eq(duda.state.round.myAnswers[d1], `${L2}aaa`, 'reconexão no meio da rodada não perde o que foi digitado');
await ana.must('answer', { catId: d1, text: `${L2}aaa` });
const remaining = duda.state.round.endsAt - Date.now();
ok(remaining > 7000 && remaining <= 10500, 'cronômetro do servidor sincronizado');
r = await bia.call('stop', {});
ok(!r.ok, 'STOP manual desativado no modo cronômetro');
await ana.must('game:pause'); await sleep(150);
r = await ana.call('answer', { catId: d2, text: `${L2}x` });
ok(r.data.locked, 'respostas bloqueadas durante a pausa');
const paused = ana.state.round.remainingMs;
await sleep(1500);
ok(ana.state.round.remainingMs === paused, 'cronômetro congelado na pausa');
await ana.must('game:resume');
await duda.wait((s) => s.phase === 'validating', 'fim do cronômetro', 14000);
ok(ana.state.round.endReason === 'timer', 'rodada encerrada automaticamente pelo cronômetro');
await ana.wait((s) => s.round.board, 'revelar');
ok(entry(ana, d1, 'Duda').points === 5 && entry(ana, d1, 'Ana').points === 5, 'respostas repetidas (Ana e Duda) valem 5 no modo admin');
await ana.must('validation:finalize');

console.log('\n== Rodada 3: todos terminaram + remoção de jogador ==');
await ana.must('settings', { endModes: ['all'] });
await ana.must('player:kick', { playerId: caio.me });
await ana.wait((s) => s.players.length === 3, 'Caio removido');
ok(!ana.state.players.some((p) => p.name === 'Caio'), 'administrador removeu Caio');
r = await caio.call('room:join', { code, token: caio.token });
ok(!r.ok, 'jogador removido não volta com o mesmo token');
await ana.must('round:start');
await bia.wait((s) => s.phase === 'playing' && s.round.n === 3, 'rodada 3');
await ana.must('confirm', {}); await bia.must('confirm', {});
await sleep(200);
ok(ana.state.phase === 'playing', 'rodada continua enquanto falta alguém confirmar');
await duda.must('confirm', {});
await ana.wait((s) => s.phase === 'validating', 'fim por confirmação geral');
ok(ana.state.round.endReason === 'all', 'modo "todos terminaram" encerrou a rodada');
await ana.wait((s) => s.round.board, 'revelar 3');
await ana.must('round:void');
await ana.wait((s) => s.round.voided, 'anulada');
ok(ana.state.round.voided, 'administrador anulou a rodada');
ok(!ana.state.letters.used.includes(ana.state.round.letter), 'letra da rodada anulada volta ao sorteio');

console.log('\n== Modos de encerramento combinados ==');
await ana.must('settings', { endModes: ['timer', 'manual', 'all'], timerSec: 30 });
eq(ana.state.settings.endModes, ['manual', 'all', 'timer'], 'três modos podem ficar ativos ao mesmo tempo');
await ana.call('settings', { endModes: [] });
eq(ana.state.settings.endModes.length, 3, 'lista vazia é ignorada (mantém ao menos um modo)');
await ana.must('round:start');
await bia.wait((s) => s.phase === 'playing', 'rodada combinada');
ok(bia.state.round.endsAt - Date.now() > 25000, 'cronômetro ativo junto com STOP manual');
await bia.must('stop', {});
await ana.wait((s) => s.phase === 'validating', 'stop com combinação');
ok(ana.state.round.endReason === 'stop', 'STOP manual encerra mesmo com cronômetro ligado');
await ana.wait((s) => s.round.board, 'revelar combinada');
await ana.must('round:void');

console.log('\n== Transferência de administração e fim ==');
await ana.must('admin:transfer', { playerId: bia.me });
r = await ana.call('game:end');
ok(!r.ok, 'ex-administrador perdeu os poderes');
await bia.must('game:end');
await duda.wait((s) => s.phase === 'finished', 'fim');
ok(duda.state.ranking.length === 3, 'ranking final apresentado (3 jogadores ativos)');
const hist = await duda.must('history:list', { token: duda.token });
ok(hist.length === 1 && hist[0].rounds === 2, 'partida registrada no histórico');
const rows = srv.db.raw.prepare('SELECT COUNT(*) n FROM answers').get().n;
ok(rows > 0, `banco relacional espelhou respostas (${rows} linhas)`);

console.log(`\n${passed} verificações passaram.`);
for (const c of [ana, bia, caio, duda]) c.drop();
await srv.close();
process.exit(0);
