// Backend autoritativo: salas, rodadas, sorteio, cronômetro, respostas, votos e pontos.
// Tudo é decidido aqui; o cliente apenas exibe o estado e envia intenções.
import crypto from 'node:crypto';
import {
  ALPHABET, defaultSettings, applySettingsPatch, evaluateRound, buildRanking,
  cleanText, answerKey, voteKey, sanitizeCategories, MAX_ANSWER_LEN,
} from './logic.js';

export class GameError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
const fail = (m, code) => { throw new GameError(m, code); };

export const GRACE_MS = 800; // tolerância de rede para respostas enviadas no instante do fim
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPw(pw, stored) {
  const [salt, hash] = stored.split(':');
  const got = crypto.scryptSync(String(pw ?? ''), salt, 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

const curRound = (room) => room.rounds[room.rounds.length - 1] || null;
const activePlayers = (room) => Object.values(room.players).filter((p) => !p.removed);

export class GameManager {
  /**
   * @param {object} db      resultado de openDb()
   * @param {object} opts    { notify(room, soft), roomTtlMs, now }
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.rooms = new Map();
    this.notify = opts.notify || (() => {});
    this.roomTtlMs = opts.roomTtlMs ?? 6 * 3600e3;
    this.finishedTtlMs = opts.finishedTtlMs ?? 3600e3;
    this.emptyTtlMs = opts.emptyTtlMs ?? 30 * 60e3;
    this.onKick = opts.onKick || (() => {});
    this.sweeper = setInterval(() => this.sweep(), opts.sweepMs ?? 60e3);
    this.sweeper.unref?.();
  }

  // ---------- ciclo de vida ----------
  attachRuntime(room) {
    Object.defineProperty(room, 'rt', {
      value: { sockets: new Map(), timer: null, adminTimer: null, saveTimer: null, revealTimer: null },
      enumerable: false, writable: true, configurable: true,
    });
    return room;
  }

  restoreAll() {
    for (const json of this.db.loadRooms()) {
      try {
        const room = this.attachRuntime(JSON.parse(json));
        if (!room.settings.endModes) room.settings.endModes = [room.settings.endMode || 'manual']; // salas antigas
        this.rooms.set(room.code, room);
        const r = curRound(room);
        if (room.phase === 'playing' && r && !room.paused && r.endsAt) {
          if (r.endsAt <= Date.now()) this.endRound(room, 'timer');
          else this.armTimer(room);
        }
        if (room.phase === 'validating' && r?.lockAt > Date.now()) this.scheduleReveal(room);
        this.checkAdminAbsent(room);
      } catch (e) { console.error('Falha ao restaurar sala:', e.message); }
    }
  }

  shutdown() {
    clearInterval(this.sweeper);
    for (const room of this.rooms.values()) {
      clearTimeout(room.rt.timer); clearTimeout(room.rt.adminTimer); clearTimeout(room.rt.revealTimer);
      this.saveNow(room);
    }
  }

  saveNow(room) {
    clearTimeout(room.rt.saveTimer); room.rt.saveTimer = null;
    try { this.db.saveRoom(room.code, room.name, JSON.stringify(room)); } catch (e) { console.error('Falha ao salvar sala:', e.message); }
  }
  scheduleSave(room) {
    if (room.rt.saveTimer) return;
    room.rt.saveTimer = setTimeout(() => this.saveNow(room), 400);
    room.rt.saveTimer.unref?.();
  }
  touch(room, soft = false) {
    room.lastActivity = Date.now();
    this.scheduleSave(room);
    this.notify(room, soft);
  }

  sweep() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      const empty = !activePlayers(room).some((p) => this.isConnected(room, p.id));
      if (!empty) continue;
      const idle = now - room.lastActivity;
      const ttl = room.phase === 'finished' ? this.finishedTtlMs : room.rounds.length === 0 ? this.emptyTtlMs : this.roomTtlMs;
      if (idle > ttl) this.destroyRoom(room);
    }
  }
  destroyRoom(room) {
    clearTimeout(room.rt.timer); clearTimeout(room.rt.adminTimer); clearTimeout(room.rt.revealTimer); clearTimeout(room.rt.saveTimer);
    this.rooms.delete(room.code);
    try { this.db.deleteRoom(room.code); } catch (e) { console.error(e.message); }
  }

  // ---------- conexões ----------
  isConnected(room, pid) { return (room.rt.sockets.get(pid)?.size || 0) > 0; }

  attach(room, pid, sid) {
    if (!room.rt.sockets.has(pid)) room.rt.sockets.set(pid, new Set());
    room.rt.sockets.get(pid).add(sid);
    if (pid === room.adminId) { clearTimeout(room.rt.adminTimer); room.adminAbsent = false; }
    this.touch(room);
  }
  detach(room, pid, sid) {
    const set = room.rt.sockets.get(pid);
    if (!set) return;
    set.delete(sid);
    if (set.size) return;
    room.rt.sockets.delete(pid);
    const p = room.players[pid];
    if (p) p.lastSeen = Date.now();
    this.checkAdminAbsent(room);
    this.checkProgress(room);
    this.touch(room);
  }
  checkAdminAbsent(room) {
    clearTimeout(room.rt.adminTimer);
    if (this.isConnected(room, room.adminId)) { room.adminAbsent = false; return; }
    const left = room.settings.adminGraceSec * 1000;
    room.rt.adminTimer = setTimeout(() => {
      if (!this.isConnected(room, room.adminId)) { room.adminAbsent = true; this.touch(room); }
    }, left);
    room.rt.adminTimer.unref?.();
  }

  // ---------- salas e jogadores ----------
  newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  checkToken(token) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) fail('Identificação inválida. Recarregue a página.');
    return sha(token);
  }

  createRoom({ roomName, adminName, maxPlayers, password, token }) {
    const tokenHash = this.checkToken(token);
    const name = cleanText(adminName, 20);
    if (!name) fail('Informe seu nome ou apelido.');
    const pw = String(password || '').slice(0, 64);
    const player = { id: crypto.randomUUID(), name, tokenHash, joinedAt: Date.now(), removed: false, lastSeen: Date.now() };
    const room = this.attachRuntime({
      code: this.newCode(),
      name: cleanText(roomName, 40) || `Sala de ${name}`,
      createdAt: Date.now(), lastActivity: Date.now(),
      adminId: player.id, adminAbsent: false,
      passHash: pw ? hashPw(pw) : null,
      maxPlayers: Math.min(30, Math.max(2, Math.round(Number(maxPlayers)) || 12)),
      players: { [player.id]: player },
      settings: defaultSettings(),
      phase: 'lobby', paused: false,
      usedLetters: [], letterHistory: [], cycles: 0,
      rounds: [], audit: [],
    });
    this.rooms.set(room.code, room);
    this.audit(room, player, 'Sala criada');
    this.touch(room);
    return { room, player };
  }

  getRoom(code) {
    const room = this.rooms.get(String(code || '').toUpperCase().trim());
    if (!room) fail('Sala não encontrada. Confira o código ou peça um novo link.', 'NO_ROOM');
    return room;
  }

  info(code) {
    const room = this.getRoom(code);
    return { code: room.code, name: room.name, hasPassword: !!room.passHash, players: activePlayers(room).length, max: room.maxPlayers, phase: room.phase };
  }

  join({ code, name, token, password }) {
    const room = this.getRoom(code);
    const tokenHash = this.checkToken(token);
    const existing = Object.values(room.players).find((p) => p.tokenHash === tokenHash);
    if (existing) {
      if (existing.removed) fail('Você foi removido desta sala pelo administrador.', 'REMOVED');
      return { room, player: existing };
    }
    const clean = cleanText(name, 20);
    if (!clean) fail('Informe seu nome ou apelido para entrar.', 'NEED_NAME');
    if (room.passHash && !checkPw(password, room.passHash)) fail('Senha incorreta.', 'BAD_PASSWORD');
    const act = activePlayers(room);
    if (act.length >= room.maxPlayers) fail('A sala está cheia.', 'FULL');
    if (act.some((p) => p.name.toLocaleLowerCase('pt-BR') === clean.toLocaleLowerCase('pt-BR'))) fail('Já existe um jogador com esse nome na sala. Escolha outro.', 'DUP_NAME');
    const player = { id: crypto.randomUUID(), name: clean, tokenHash, joinedAt: Date.now(), removed: false, lastSeen: Date.now() };
    room.players[player.id] = player;
    const r = curRound(room);
    if (room.phase === 'playing' && r && !r.participants.includes(player.id)) r.participants.push(player.id);
    this.touch(room);
    return { room, player };
  }

  requireAdmin(room, p) { if (p.id !== room.adminId) fail('Apenas o administrador pode fazer isso.', 'FORBIDDEN'); }
  audit(room, p, text) {
    room.audit.push({ at: Date.now(), by: p?.name || 'sistema', text });
    if (room.audit.length > 200) room.audit.splice(0, room.audit.length - 200);
  }

  kick(room, p, { playerId }) {
    this.requireAdmin(room, p);
    const t = room.players[playerId];
    if (!t || t.removed) fail('Jogador não encontrado.');
    if (t.id === room.adminId) fail('O administrador não pode remover a si mesmo. Transfira a administração antes.');
    t.removed = true;
    this.audit(room, p, `Removeu ${t.name}`);
    this.onKick(room, t.id);
    this.checkProgress(room);
    this.touch(room);
  }

  transferAdmin(room, p, { playerId }) {
    this.requireAdmin(room, p);
    const t = room.players[playerId];
    if (!t || t.removed) fail('Jogador não encontrado.');
    room.adminId = t.id; room.adminAbsent = false;
    this.audit(room, p, `Transferiu a administração para ${t.name}`);
    this.checkAdminAbsent(room);
    this.touch(room);
  }

  claimAdmin(room, p) {
    if (p.id === room.adminId) return;
    if (!room.adminAbsent || this.isConnected(room, room.adminId)) fail('O administrador ainda está na sala.');
    const old = room.players[room.adminId];
    room.adminId = p.id; room.adminAbsent = false;
    this.audit(room, p, `Assumiu a administração (antigo: ${old?.name})`);
    this.checkAdminAbsent(room);
    this.touch(room);
  }

  // ---------- configurações ----------
  setSettings(room, p, patch) {
    this.requireAdmin(room, p);
    if (!['lobby', 'results', 'finished'].includes(room.phase)) fail('As regras só podem ser alteradas entre as rodadas.');
    room.settings = applySettingsPatch(room.settings, patch);
    if ('adminGraceSec' in (patch || {})) this.checkAdminAbsent(room);
    this.touch(room);
  }

  setCategories(room, p, { categories }) {
    this.setSettings(room, p, { categories });
  }

  // ---------- letras ----------
  lettersAvailable(room) {
    const en = room.settings.enabledLetters;
    return room.settings.noRepeatLetters ? en.filter((l) => !room.usedLetters.includes(l)) : en.slice();
  }

  drawLetter(room) {
    const s = room.settings;
    if (!s.enabledLetters.length) fail('Selecione ao menos uma letra disponível.');
    let pool = this.lettersAvailable(room);
    if (!pool.length) {
      if (s.onLettersExhausted !== 'cycle') return null;
      room.usedLetters = []; room.cycles++;
      pool = this.lettersAvailable(room);
    }
    return pool[crypto.randomInt(pool.length)]; // sorteio oficial: somente servidor
  }

  pickCategories(room) {
    const s = room.settings;
    let act = s.categories.filter((c) => c.active);
    const max = s.maxCategoriesPerRound;
    if (max > 0 && act.length > max) {
      const chosen = new Set();
      while (chosen.size < max) chosen.add(crypto.randomInt(act.length));
      act = act.filter((_, i) => chosen.has(i)); // sorteia mantendo a ordem definida
    }
    return act.map((c) => ({ id: c.id, name: c.name }));
  }

  // ---------- rodadas ----------
  startRound(room, p, opts = {}) {
    this.requireAdmin(room, p);
    if (!['lobby', 'results'].includes(room.phase)) fail('Não é possível iniciar uma rodada agora.');
    const categories = this.pickCategories(room);
    if (!categories.length) fail('Ative ao menos uma categoria.');
    const letter = opts.letter || this.drawLetter(room);
    if (!letter) { this.finishGame(room, p, 'Todas as letras disponíveis foram usadas.'); return; }
    const s = room.settings;
    const now = Date.now();
    const finished = room.rounds.filter((r) => !r.voided).length;
    const round = {
      id: crypto.randomUUID(), n: opts.n ?? finished + 1, letter, categories,
      startedAt: now,
      endsAt: s.endModes.includes('timer') ? now + s.timerSec * 1000 : null,
      remainingMs: null, endedAt: null, endReason: null, stoppedBy: null, lockAt: 0,
      participants: activePlayers(room).map((x) => x.id),
      answers: {}, confirmedAt: {}, votes: {}, voteConfirmed: {}, decisions: {},
      final: false, voided: false, result: null,
    };
    room.rounds.push(round);
    if (!room.usedLetters.includes(letter)) room.usedLetters.push(letter);
    room.letterHistory.push({ n: round.n, letter });
    room.phase = 'playing'; room.paused = false;
    this.armTimer(room);
    this.audit(room, p, `Iniciou a rodada ${round.n} (letra ${letter})`);
    this.touch(room);
  }

  armTimer(room) {
    clearTimeout(room.rt.timer);
    const r = curRound(room);
    if (room.phase !== 'playing' || room.paused || !r?.endsAt) return;
    room.rt.timer = setTimeout(() => {
      if (room.phase === 'playing') this.endRound(room, 'timer');
    }, Math.max(0, r.endsAt - Date.now()));
    room.rt.timer.unref?.();
  }

  scheduleReveal(room) {
    clearTimeout(room.rt.revealTimer);
    const r = curRound(room);
    room.rt.revealTimer = setTimeout(() => this.notify(room, false), Math.max(0, (r?.lockAt || 0) - Date.now()) + 30);
    room.rt.revealTimer.unref?.();
  }

  endRound(room, reason, byId = null) {
    if (room.phase !== 'playing') fail('A rodada já terminou.', 'ENDED');
    const r = curRound(room);
    clearTimeout(room.rt.timer);
    r.endedAt = Date.now(); r.endReason = reason; r.stoppedBy = byId;
    r.lockAt = r.endedAt + GRACE_MS;
    room.phase = 'validating'; room.paused = false; r.remainingMs = null;
    this.scheduleReveal(room);
    this.touch(room);
  }

  /** Mesclar respostas apenas se o jogador ainda pode escrever. */
  writable(room, p) {
    const r = curRound(room);
    if (!r || !r.participants.includes(p.id)) return null;
    if (r.confirmedAt[p.id] && room.phase === 'playing') return null;
    const live = room.phase === 'playing' && !room.paused;
    const grace = room.phase === 'validating' && Date.now() <= r.lockAt && !r.confirmedAt[p.id];
    return live || grace ? r : null;
  }

  answer(room, p, { catId, text }) {
    const r = this.writable(room, p);
    if (!r) return { locked: true };
    if (!r.categories.some((c) => c.id === catId)) fail('Categoria inválida.');
    (r.answers[p.id] ||= {})[catId] = cleanText(text, MAX_ANSWER_LEN).replace(/^\s+/, '');
    this.touch(room, true);
    return { saved: true };
  }

  syncAnswers(room, p, { answers }) {
    const r = this.writable(room, p);
    if (!r) return { locked: true };
    const mine = (r.answers[p.id] ||= {});
    for (const c of r.categories) {
      if (answers && typeof answers[c.id] === 'string') mine[c.id] = cleanText(answers[c.id], MAX_ANSWER_LEN);
    }
    this.touch(room, true);
    return { saved: true };
  }

  confirm(room, p, payload = {}) {
    if (room.phase !== 'playing') fail('A rodada já terminou.', 'ENDED');
    const r = this.writable(room, p);
    if (!r) fail('Você já confirmou suas respostas.');
    if (payload.answers) this.syncAnswers(room, p, payload);
    r.confirmedAt[p.id] = Date.now();
    this.checkProgress(room);
    this.touch(room);
  }

  stop(room, p, payload = {}) {
    if (!room.settings.endModes.includes('manual')) fail('O STOP manual está desativado nesta partida.');
    if (room.phase !== 'playing') fail('A rodada já terminou.', 'ENDED');
    if (room.paused) fail('A partida está pausada.');
    const r = curRound(room);
    if (!r.participants.includes(p.id)) fail('Você não está nesta rodada.');
    if (payload.answers) this.syncAnswers(room, p, payload);
    r.confirmedAt[p.id] = r.confirmedAt[p.id] || Date.now();
    this.endRound(room, 'stop', p.id);
    this.audit(room, p, `Acionou o STOP (rodada ${r.n})`);
  }

  adminEndRound(room, p) {
    this.requireAdmin(room, p);
    if (room.phase !== 'playing') fail('Não há rodada em andamento.');
    this.endRound(room, 'admin', p.id);
    this.audit(room, p, 'Encerrou a rodada manualmente');
  }

  pause(room, p) {
    this.requireAdmin(room, p);
    if (room.phase !== 'playing' || room.paused) fail('Não é possível pausar agora.');
    const r = curRound(room);
    if (r.endsAt) r.remainingMs = Math.max(0, r.endsAt - Date.now());
    clearTimeout(room.rt.timer);
    room.paused = true;
    this.audit(room, p, 'Pausou a partida');
    this.touch(room);
  }

  resume(room, p) {
    this.requireAdmin(room, p);
    if (room.phase !== 'playing' || !room.paused) fail('A partida não está pausada.');
    const r = curRound(room);
    if (r.remainingMs != null) r.endsAt = Date.now() + r.remainingMs;
    r.remainingMs = null;
    room.paused = false;
    this.armTimer(room);
    this.audit(room, p, 'Retomou a partida');
    this.touch(room);
  }

  /** Mode B (todos terminaram) e votação completa. */
  checkProgress(room) {
    const r = curRound(room);
    if (!r) return;
    const connected = r.participants.filter((id) => room.players[id] && !room.players[id].removed && this.isConnected(room, id));
    if (room.phase === 'playing' && !room.paused && room.settings.endModes.includes('all')) {
      if (connected.length && connected.every((id) => r.confirmedAt[id])) this.endRound(room, 'all');
    } else if (room.phase === 'validating' && room.settings.validationMode === 'players' && Date.now() > r.lockAt) {
      if (connected.length && connected.every((id) => r.voteConfirmed[id])) this.finalize(room, null, true);
    }
  }

  // ---------- validação ----------
  votable(room, r, voterId, authorId, catId) {
    if (room.phase !== 'validating') fail('A votação não está aberta.');
    if (Date.now() <= r.lockAt) fail('Aguarde um instante.');
    if (room.settings.validationMode === 'admin') fail('Nesta partida a validação é feita pelo administrador.');
    if (voterId === authorId) fail('Você não pode votar na própria resposta.');
    if (!r.participants.includes(voterId) || !r.participants.includes(authorId)) fail('Jogador fora da rodada.');
    if (!r.categories.some((c) => c.id === catId)) fail('Categoria inválida.');
    if (r.voteConfirmed[voterId]) fail('Seus votos já foram confirmados.');
  }

  vote(room, p, { authorId, catId, vote }) {
    const r = curRound(room);
    if (!r) fail('Sem rodada.');
    this.votable(room, r, p.id, authorId, catId);
    if (!['v', 'i', 'u'].includes(vote)) fail('Voto inválido.');
    const ev = evaluateRound(room.settings, r, room.players).items[answerKey(authorId, catId)];
    if (!ev || ev.status === 'blank' || ev.auto === false) fail('Esta resposta não precisa de voto.');
    r.votes[voteKey(p.id, authorId, catId)] = vote;
    this.touch(room);
  }

  confirmVotes(room, p) {
    const r = curRound(room);
    if (!r || room.phase !== 'validating') fail('A votação não está aberta.');
    if (room.settings.validationMode === 'admin') fail('Nesta partida a validação é feita pelo administrador.');
    if (!r.participants.includes(p.id)) fail('Você não está nesta rodada.');
    if (Date.now() <= r.lockAt) fail('Aguarde um instante.');
    r.voteConfirmed[p.id] = Date.now();
    this.checkProgress(room);
    this.touch(room);
  }

  reopenVotes(room, p, { playerId } = {}) {
    this.requireAdmin(room, p);
    const r = curRound(room);
    if (!r || !['validating', 'results'].includes(room.phase)) fail('Não há votação para reabrir.');
    if (room.phase === 'results') this.reopenRound(room, p, true);
    if (playerId) delete r.voteConfirmed[playerId]; else r.voteConfirmed = {};
    this.audit(room, p, playerId ? `Reabriu a votação de ${room.players[playerId]?.name}` : 'Reabriu a votação');
    this.touch(room);
  }

  decide(room, p, { authorId, catId, status }) {
    this.requireAdmin(room, p);
    const r = curRound(room);
    if (!r || room.phase !== 'validating') fail('Reabra a validação para alterar respostas.');
    if (!r.participants.includes(authorId) || !r.categories.some((c) => c.id === catId)) fail('Resposta não encontrada.');
    if (!['valid', 'invalid', 'controversial', 'partial', 'clear'].includes(status)) fail('Decisão inválida.');
    if (status === 'partial' && !room.settings.scoring.partialEnabled) fail('A pontuação parcial está desativada.');
    const key = answerKey(authorId, catId);
    const dec = (r.decisions[key] ||= {});
    if (status === 'clear') delete dec.status; else dec.status = status;
    if (dec.status == null && dec.corrected == null) delete r.decisions[key];
    this.audit(room, p, `Decisão em "${r.answers[authorId]?.[catId] ?? ''}" (${room.players[authorId]?.name}): ${status}`);
    this.touch(room);
  }

  correct(room, p, { authorId, catId, text }) {
    this.requireAdmin(room, p);
    if (!room.settings.allowCorrection) fail('A correção de respostas está desativada.');
    const r = curRound(room);
    if (!r || room.phase !== 'validating') fail('Reabra a validação para alterar respostas.');
    if (!r.participants.includes(authorId) || !r.categories.some((c) => c.id === catId)) fail('Resposta não encontrada.');
    const key = answerKey(authorId, catId);
    const clean = cleanText(text, MAX_ANSWER_LEN);
    const dec = (r.decisions[key] ||= {});
    const before = r.answers[authorId]?.[catId] ?? '';
    if (clean === before) delete dec.corrected; else dec.corrected = clean;
    if (dec.status == null && dec.corrected == null) delete r.decisions[key];
    this.audit(room, p, `Corrigiu "${before}" → "${clean}" (${room.players[authorId]?.name})`);
    this.touch(room);
  }

  finalize(room, p, auto = false) {
    if (!auto) this.requireAdmin(room, p);
    const r = curRound(room);
    if (!r || room.phase !== 'validating') fail('Não há validação em andamento.');
    if (Date.now() <= r.lockAt) fail('Aguarde um instante.');
    r.result = evaluateRound(room.settings, r, room.players);
    r.final = true;
    room.phase = 'results';
    this.audit(room, p, auto ? 'Validação concluída (todos votaram)' : 'Finalizou a validação');
    this.persistRound(room, r);
    this.touch(room);
  }

  reopenRound(room, p, silent = false) {
    this.requireAdmin(room, p);
    const r = curRound(room);
    if (!r || room.phase !== 'results' || r.voided) fail('Não há rodada para reabrir.');
    r.final = false; r.result = null; room.phase = 'validating';
    this.persistRound(room, r);
    if (!silent) { this.audit(room, p, `Reabriu a validação da rodada ${r.n}`); this.touch(room); }
  }

  persistRound(room, r) {
    try { this.db.recordRound(room, r); } catch (e) { console.error('Falha ao gravar rodada:', e.message); }
  }

  voidRound(room, p, { restart } = {}) {
    this.requireAdmin(room, p);
    const r = curRound(room);
    if (!r || !['playing', 'validating', 'results'].includes(room.phase) || r.voided) fail('Não há rodada para anular.');
    clearTimeout(room.rt.timer);
    r.voided = true; r.final = false; r.result = null;
    const i = room.usedLetters.lastIndexOf(r.letter);
    if (i >= 0) room.usedLetters.splice(i, 1); // a letra volta ao sorteio
    room.letterHistory = room.letterHistory.filter((h, idx) => !(idx === room.letterHistory.length - 1 && h.n === r.n && h.letter === r.letter));
    room.phase = 'results'; room.paused = false;
    this.persistRound(room, r);
    this.audit(room, p, `Anulou a rodada ${r.n}`);
    if (restart) this.startRound(room, p, { letter: r.letter, n: r.n });
    else this.touch(room);
  }

  // ---------- fim de jogo ----------
  endGame(room, p) {
    this.requireAdmin(room, p);
    if (room.phase === 'finished') return;
    const r = curRound(room);
    if (r && ['playing', 'validating'].includes(room.phase) && !r.voided) {
      clearTimeout(room.rt.timer);
      r.voided = true; this.persistRound(room, r); // rodada inacabada não conta
    }
    this.finishGame(room, p, 'Partida encerrada pelo administrador.');
  }

  finishGame(room, p, why) {
    room.phase = 'finished'; room.paused = false;
    this.audit(room, p, why);
    if (room.settings.historyEnabled) {
      const ranking = buildRanking(room.settings, room.players, room.rounds);
      const rounds = room.rounds.filter((r) => r.final && !r.voided).length;
      try {
        this.db.addHistory(room, { rounds, ranking: ranking.map((x) => ({ pos: x.pos, name: x.name, total: x.total })) },
          activePlayers(room).map((x) => x.tokenHash));
      } catch (e) { console.error('Falha ao gravar histórico:', e.message); }
    }
    this.touch(room);
  }

  resetGame(room, p) {
    this.requireAdmin(room, p);
    if (room.phase !== 'finished') fail('A partida ainda não terminou.');
    for (const r of room.rounds) { try { this.db.recordRound(room, { ...r, voided: true }); } catch { /* noop */ } }
    room.rounds = []; room.usedLetters = []; room.letterHistory = []; room.cycles = 0; room.phase = 'lobby';
    this.audit(room, p, 'Reiniciou a sala para uma nova partida');
    this.touch(room);
  }

  // ---------- visões (o que cada jogador pode ver) ----------
  view(room, pid) {
    const now = Date.now();
    const s = room.settings;
    const isAdmin = pid === room.adminId;
    const act = activePlayers(room);
    const r = curRound(room);
    const ranking = buildRanking(s, room.players, room.rounds);
    const v = {
      serverNow: now, code: room.code, name: room.name, hasPassword: !!room.passHash, maxPlayers: room.maxPlayers,
      you: { id: pid, isAdmin, name: room.players[pid]?.name },
      adminId: room.adminId, adminAbsent: room.adminAbsent,
      phase: room.phase, paused: room.paused, settings: s,
      players: act.map((x) => ({ id: x.id, name: x.name, connected: this.isConnected(room, x.id), isAdmin: x.id === room.adminId })),
      letters: {
        enabled: s.enabledLetters, used: room.usedLetters, history: room.letterHistory,
        available: this.lettersAvailable(room).length, cycles: room.cycles,
      },
      ranking,
      rounds: room.rounds.filter((x) => !x.voided).map((x) => ({ n: x.n, letter: x.letter, final: x.final })),
    };
    if (isAdmin) v.audit = room.audit.slice(-40);
    if (r && room.phase !== 'lobby') v.round = this.roundView(room, r, pid, now, ranking);
    return v;
  }

  roundView(room, r, pid, now, ranking) {
    const s = room.settings;
    const nameOf = (id) => room.players[id]?.name || '?';
    const out = {
      id: r.id, n: r.n, letter: r.letter, categories: r.categories, voided: r.voided, final: r.final,
      endsAt: r.endsAt, remainingMs: r.remainingMs, endReason: r.endReason,
      stoppedBy: r.stoppedBy ? nameOf(r.stoppedBy) : null, lockAt: r.lockAt,
      participating: r.participants.includes(pid),
    };
    if (room.phase === 'playing') {
      out.myAnswers = r.answers[pid] || {};
      out.myConfirmed = !!r.confirmedAt[pid];
      out.progress = r.participants.filter((id) => room.players[id] && !room.players[id].removed).map((id) => ({
        id, filled: Object.values(r.answers[id] || {}).filter((t) => t).length, confirmed: !!r.confirmedAt[id],
      }));
      return out;
    }
    out.myAnswers = r.answers[pid] || {};
    if (room.phase === 'validating' && now <= r.lockAt) { out.revealing = true; return out; }
    if (r.voided) return out;
    const ev = evaluateRound(s, r, room.players);
    out.board = this.board(room, r, ev, pid);
    out.scores = Object.fromEntries(Object.entries(ev.perPlayer).map(([id, pp]) => [id, { total: pp.total, counts: pp.counts, bonuses: pp.bonuses }]));
    out.voteConfirmed = r.voteConfirmed;
    out.myVoteConfirmed = !!r.voteConfirmed[pid];
    const connected = r.participants.filter((id) => room.players[id] && !room.players[id].removed && this.isConnected(room, id));
    out.votesDone = connected.filter((id) => r.voteConfirmed[id]).length;
    out.votesTotal = connected.length;
    out.pendingCount = Object.values(ev.items).filter((i) => i.pending).length;
    return out;
  }

  board(room, r, ev, pid) {
    return r.categories.map((cat) => ({
      id: cat.id, name: cat.name,
      entries: r.participants.filter((id) => room.players[id] && !room.players[id].removed).map((id) => {
        const it = ev.items[answerKey(id, cat.id)];
        return {
          pid: id, catId: cat.id, name: room.players[id].name, text: it.text, raw: it.raw, corrected: it.corrected,
          status: it.status, source: it.source, pending: it.pending, auto: it.auto, dup: !!it.dup,
          votes: it.votes, myVote: r.votes[voteKey(pid, id, cat.id)] || null,
          points: it.points, reason: it.reason,
          decision: r.decisions[answerKey(id, cat.id)]?.status || null,
        };
      }),
    }));
  }

  roundDetail(room, n) {
    const r = room.rounds.find((x) => x.n === n && !x.voided);
    if (!r || !r.final) fail('Rodada não encontrada.');
    const ev = evaluateRound(room.settings, r, room.players);
    return { n: r.n, letter: r.letter, board: this.board(room, r, ev, ''), scores: Object.fromEntries(Object.entries(ev.perPlayer).map(([id, pp]) => [id, pp.total])) };
  }

  categoriesFrom(list) { return sanitizeCategories(list); }
}

export { ALPHABET };
