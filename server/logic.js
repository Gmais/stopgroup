// Regras puras do jogo: normalização, validação, pontuação e ranking.
// Nenhuma dependência de rede/banco — facilmente testável.

export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

export const DEFAULT_CATEGORIES = [
  'Nome próprio', 'Animal', 'Cidade', 'CEP (cidade, estado ou país)', 'Fruta', 'Comida', 'Objeto',
  'Profissão', 'Marca', 'Filme ou série', 'Cantor ou banda', 'Personagem',
  'Cor', 'Esporte', 'Parte do corpo', 'Celebridade', 'Planta ou flor',
  'Veículo', 'Adjetivo', 'Algo que existe na escola',
];

export const MAX_ANSWER_LEN = 60;
export const MAX_CATEGORIES = 60;

let catSeq = 0;
export function newCatId() {
  return 'c' + Date.now().toString(36) + (catSeq++).toString(36) + Math.random().toString(36).slice(2, 5);
}

export function defaultSettings() {
  return {
    categories: DEFAULT_CATEGORIES.map((name, i) => ({ id: 'd' + (i + 1), name, active: i < 12 })),
    enabledLetters: ALPHABET.filter((l) => !'KWXY'.includes(l)),
    noRepeatLetters: true,
    onLettersExhausted: 'end', // 'end' | 'cycle'
    maxCategoriesPerRound: 0, // 0 = todas as ativas
    endModes: ['manual'], // qualquer combinação de 'manual' | 'all' | 'timer' (o primeiro que ocorrer encerra)
    timerSec: 90,
    validationMode: 'players', // 'admin' | 'players' | 'hybrid'
    minVotes: 2,
    approvalPct: 50,
    tieRule: 'admin', // 'admin' | 'valid' | 'invalid'
    strictAccents: false,
    allowCorrection: true,
    rankingTie: 'share', // 'share' | 'uniques'
    adminGraceSec: 60,
    historyEnabled: true,
    scoring: {
      unique: 10, repeated: 5, invalid: 0, blank: 0,
      partialEnabled: false, partial: 5,
      bonusAllEnabled: false, bonusAll: 5,
      bonusFirstEnabled: false, bonusFirst: 5,
    },
  };
}

// ---------- texto ----------
export function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function cleanText(s, max = MAX_ANSWER_LEN) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Chave de comparação para detectar respostas repetidas. */
export function normalizeText(s, strict = false) {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
  return strict ? t : stripAccents(t);
}

/** A resposta começa com a letra sorteada? (ignora espaços iniciais e caixa) */
export function startsWithLetter(text, letter, strict = false) {
  const t = String(text ?? '').trim().normalize('NFC');
  if (!t) return false;
  const first = [...t][0];
  const L = letter.toLocaleLowerCase('pt-BR');
  if (strict) return first.toLocaleLowerCase('pt-BR') === L;
  return stripAccents(first).toLocaleLowerCase('pt-BR')[0] === L;
}

// ---------- configurações ----------
const clamp = (n, lo, hi, d) => {
  n = Number(n);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};
const oneOf = (v, list, d) => (list.includes(v) ? v : d);

export function sanitizeCategories(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  const out = [];
  for (const c of list.slice(0, MAX_CATEGORIES)) {
    const name = cleanText(c?.name, 40);
    if (!name) continue;
    let id = typeof c.id === 'string' && /^[\w-]{1,24}$/.test(c.id) ? c.id : newCatId();
    if (seen.has(id)) id = newCatId();
    seen.add(id);
    out.push({ id, name, active: c.active !== false });
  }
  return out;
}

/** Aplica um patch parcial sobre as configurações, validando cada campo. */
export function applySettingsPatch(cur, patch) {
  const s = structuredClone(cur);
  const p = patch || {};
  if ('categories' in p) {
    const cats = sanitizeCategories(p.categories);
    if (cats) s.categories = cats;
  }
  if (Array.isArray(p.enabledLetters)) {
    s.enabledLetters = ALPHABET.filter((l) => p.enabledLetters.includes(l));
  }
  if ('noRepeatLetters' in p) s.noRepeatLetters = !!p.noRepeatLetters;
  if ('onLettersExhausted' in p) s.onLettersExhausted = oneOf(p.onLettersExhausted, ['end', 'cycle'], s.onLettersExhausted);
  if ('maxCategoriesPerRound' in p) s.maxCategoriesPerRound = clamp(p.maxCategoriesPerRound, 0, MAX_CATEGORIES, 0);
  if (Array.isArray(p.endModes)) {
    const m = ['manual', 'all', 'timer'].filter((x) => p.endModes.includes(x));
    if (m.length) s.endModes = m;
  }
  if ('timerSec' in p) s.timerSec = clamp(p.timerSec, 10, 900, 90);
  if ('validationMode' in p) s.validationMode = oneOf(p.validationMode, ['admin', 'players', 'hybrid'], s.validationMode);
  if ('minVotes' in p) s.minVotes = clamp(p.minVotes, 1, 20, 2);
  if ('approvalPct' in p) s.approvalPct = clamp(p.approvalPct, 1, 100, 50);
  if ('tieRule' in p) s.tieRule = oneOf(p.tieRule, ['admin', 'valid', 'invalid'], s.tieRule);
  if ('strictAccents' in p) s.strictAccents = !!p.strictAccents;
  if ('allowCorrection' in p) s.allowCorrection = !!p.allowCorrection;
  if ('rankingTie' in p) s.rankingTie = oneOf(p.rankingTie, ['share', 'uniques'], s.rankingTie);
  if ('adminGraceSec' in p) s.adminGraceSec = clamp(p.adminGraceSec, 5, 900, 60);
  if ('historyEnabled' in p) s.historyEnabled = !!p.historyEnabled;
  if (p.scoring && typeof p.scoring === 'object') {
    const sc = s.scoring;
    const q = p.scoring;
    for (const k of ['unique', 'repeated', 'invalid', 'blank', 'partial', 'bonusAll', 'bonusFirst']) {
      if (k in q) sc[k] = clamp(q[k], -100, 1000, sc[k]);
    }
    for (const k of ['partialEnabled', 'bonusAllEnabled', 'bonusFirstEnabled']) {
      if (k in q) sc[k] = !!q[k];
    }
  }
  return s;
}

// ---------- avaliação de uma rodada ----------
export const answerKey = (pid, catId) => `${pid}|${catId}`;
export const voteKey = (voterId, pid, catId) => `${voterId}|${pid}|${catId}`;

/**
 * Avalia todas as respostas da rodada.
 * `players` é o mapa id→jogador; jogadores removidos são ignorados.
 * Retorna { items: {key→item}, perPlayer: {pid→{total,counts,bonuses}} }.
 */
export function evaluateRound(settings, round, players) {
  const strict = settings.strictAccents;
  const sc = settings.scoring;
  const pids = round.participants.filter((id) => players[id] && !players[id].removed);
  const items = {};

  for (const cat of round.categories) {
    for (const pid of pids) {
      const key = answerKey(pid, cat.id);
      const raw = round.answers[pid]?.[cat.id] ?? '';
      const dec = round.decisions[key];
      const text = (dec && dec.corrected != null ? dec.corrected : raw).trim();
      const it = {
        pid, catId: cat.id, raw, text,
        corrected: dec && dec.corrected != null ? dec.corrected : null,
        status: 'blank', source: 'auto', pending: false, auto: null,
        votes: { v: 0, i: 0, u: 0 }, points: 0, reason: '',
      };
      items[key] = it;
      if (!text) continue;

      it.auto = startsWithLetter(text, round.letter, strict);
      for (const voter of pids) {
        if (voter === pid) continue; // o voto do autor é desconsiderado
        const vt = round.votes[voteKey(voter, pid, cat.id)];
        if (vt === 'v') it.votes.v++;
        else if (vt === 'i') it.votes.i++;
        else if (vt === 'u') it.votes.u++;
      }

      const adminSet = dec && ['valid', 'invalid', 'partial'].includes(dec.status);
      if (adminSet && !(dec.status === 'partial' && !sc.partialEnabled)) {
        it.status = dec.status;
        it.source = 'admin';
      } else if (!it.auto) {
        it.status = 'invalid';
        it.source = 'auto';
      } else if (settings.validationMode === 'admin') {
        it.status = 'valid';
        it.source = 'auto';
        if (dec?.status === 'controversial') it.pending = true;
      } else {
        const { v, i } = it.votes;
        const decisive = v + i;
        const eligible = pids.length - 1;
        const need = eligible <= 0 ? 0 : Math.min(settings.minVotes, eligible);
        it.status = 'valid';
        it.source = 'auto';
        if (decisive > 0 && decisive >= need && !(need === 0)) {
          const ratio = v / decisive;
          const t = settings.approvalPct / 100;
          it.source = 'votes';
          if (t > 0.5) it.status = ratio >= t ? 'valid' : 'invalid';
          else if (ratio > 0.5) it.status = 'valid';
          else if (ratio < 0.5) it.status = 'invalid';
          else if (t < 0.5) it.status = 'valid';
          else {
            // empate exato
            if (settings.tieRule === 'admin') { it.pending = true; it.status = 'valid'; it.source = 'tie'; }
            else { it.status = settings.tieRule; it.source = 'tie'; }
          }
          if (settings.validationMode === 'hybrid' && v > 0 && i > 0 && ratio > 0.25 && ratio < 0.75) {
            it.pending = true; // controverso: cabe ao administrador decidir
          }
        }
        if (dec?.status === 'controversial') it.pending = true;
      }
      // decisão do administrador resolve qualquer pendência
      if (adminSet) it.pending = false;
    }
  }

  // duplicidade: mesma categoria, só respostas válidas
  const groups = new Map();
  for (const it of Object.values(items)) {
    if (it.status !== 'valid') continue;
    const g = `${it.catId}|${normalizeText(it.text, strict)}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  for (const list of groups.values()) {
    const dup = list.length > 1;
    for (const it of list) {
      it.dup = dup;
      it.points = dup ? sc.repeated : sc.unique;
      it.reason = dup ? `Repetida por ${list.length} jogadores: ${sc.repeated >= 0 ? '+' : ''}${sc.repeated}` : `Resposta única: +${sc.unique}`;
    }
  }
  for (const it of Object.values(items)) {
    if (it.status === 'blank') { it.points = sc.blank; it.reason = 'Em branco'; }
    else if (it.status === 'partial') { it.points = sc.partial; it.reason = `Parcialmente correta: +${sc.partial}`; }
    else if (it.status === 'invalid') {
      it.points = sc.invalid;
      if (it.source === 'admin') it.reason = 'Rejeitada pelo administrador';
      else if (it.source === 'votes' || it.source === 'tie') it.reason = `Rejeitada pelos jogadores (${it.votes.v} válida / ${it.votes.i} inválida)`;
      else it.reason = `Não começa com a letra ${round.letter}`;
    } else if (it.status === 'valid' && it.source === 'admin') it.reason = '(Aprovada pelo administrador) ' + it.reason;
  }

  // totais
  const perPlayer = {};
  for (const pid of pids) {
    perPlayer[pid] = { total: 0, counts: { unique: 0, repeated: 0, invalid: 0, blank: 0, partial: 0 }, bonuses: [] };
  }
  for (const it of Object.values(items)) {
    const pp = perPlayer[it.pid];
    pp.total += it.points;
    if (it.status === 'valid') pp.counts[it.dup ? 'repeated' : 'unique']++;
    else pp.counts[it.status]++;
  }
  const ncat = round.categories.length;
  if (ncat > 0) {
    if (sc.bonusAllEnabled) {
      for (const pid of pids) {
        const ok = round.categories.every((c) => ['valid', 'partial'].includes(items[answerKey(pid, c.id)].status));
        if (ok) { perPlayer[pid].bonuses.push({ type: 'all', label: 'Bônus: todas as categorias válidas', points: sc.bonusAll }); perPlayer[pid].total += sc.bonusAll; }
      }
    }
    if (sc.bonusFirstEnabled) {
      let first = null;
      for (const pid of pids) {
        const at = round.confirmedAt?.[pid];
        if (!at) continue;
        const full = round.categories.every((c) => items[answerKey(pid, c.id)].status !== 'blank');
        if (full && (!first || at < first.at)) first = { pid, at };
      }
      if (first) { perPlayer[first.pid].bonuses.push({ type: 'first', label: 'Bônus: primeiro a concluir', points: sc.bonusFirst }); perPlayer[first.pid].total += sc.bonusFirst; }
    }
  }
  return { items, perPlayer };
}

// ---------- ranking ----------
/** Ranking a partir das rodadas finalizadas (derivado: nunca soma duas vezes). */
export function buildRanking(settings, players, rounds) {
  const active = Object.values(players).filter((p) => !p.removed);
  const finals = rounds.filter((r) => r.final && !r.voided && r.result);
  const rows = active.map((p) => {
    const row = { id: p.id, name: p.name, total: 0, perRound: [], unique: 0, repeated: 0, invalid: 0, blank: 0, partial: 0 };
    for (const r of finals) {
      const pp = r.result.perPlayer[p.id];
      row.perRound.push({ n: r.n, letter: r.letter, points: pp ? pp.total : 0 });
      if (!pp) continue;
      row.total += pp.total;
      for (const k of ['unique', 'repeated', 'invalid', 'blank', 'partial']) row[k] += pp.counts[k];
    }
    return row;
  });
  const byUniques = settings.rankingTie === 'uniques';
  rows.sort((a, b) => b.total - a.total || (byUniques ? b.unique - a.unique : 0) || a.name.localeCompare(b.name, 'pt-BR'));
  let pos = 0;
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    const same = prev && prev.total === r.total && (!byUniques || prev.unique === r.unique);
    if (!same) pos = i + 1;
    r.pos = pos;
  });
  return rows;
}
