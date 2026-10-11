// Cliente do Stop Online. O servidor é a fonte da verdade; aqui só exibimos o estado
// recebido e enviamos intenções (resposta digitada, voto, STOP, comandos do admin).
/* global io */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem('stop.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('stop.' + k, JSON.stringify(v)); } catch { /* modo privado */ } },
  del(k) { try { localStorage.removeItem('stop.' + k); } catch { /* noop */ } },
};
const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
let token = LS.get('token');
if (!token) { token = rand(); LS.set('token', token); }

const app = $('#app'), topEl = $('#top'), modal = $('#modal');
const S = {
  view: null, screen: 'home', code: null, joinInfo: null, offset: 0, online: false, sets: [], history: [],
  ui: { rank: 'general', showRank: false, settings: false, detail: null },
  mountKey: null, dirty: false, save: 'ok', spun: null, flushed: false, lastSec: null,
};
const socket = io({ reconnection: true, reconnectionDelayMax: 3000 });
const serverNow = () => Date.now() + S.offset;

// ---------- utilidades de UI ----------
function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 4500 : 2500);
}
const announce = (msg) => { const l = $('#live'); l.textContent = ''; setTimeout(() => { l.textContent = msg; }, 50); };

function call(name, payload = {}, { silent = false } = {}) {
  return new Promise((resolve, reject) => {
    const fail = (message, code) => { const e = new Error(message); e.code = code; if (!silent) toast(message, true); reject(e); };
    if (!socket.connected) return fail('Sem conexão. Tentando reconectar…');
    socket.timeout(8000).emit('call', name, payload, (err, r) => {
      if (err) return fail('O servidor não respondeu. Tente de novo.');
      if (!r.ok) return fail(r.error, r.code);
      resolve(r.data);
    });
  });
}
const swallow = () => {};

// ---------- sons (sintetizados, sem arquivos) ----------
const Snd = {
  ctx: null, vol: LS.get('vol', 0.5), mute: LS.get('mute', false),
  unlock() { if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* sem áudio */ } } this.ctx?.state === 'suspended' && this.ctx.resume(); },
  tone(f, d, type = 'sine', delay = 0, g = 0.25) {
    if (this.mute || !this.ctx || this.vol <= 0) return;
    const t = this.ctx.currentTime + delay, o = this.ctx.createOscillator(), a = this.ctx.createGain();
    o.type = type; o.frequency.value = f;
    a.gain.setValueAtTime(g * this.vol, t); a.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(a).connect(this.ctx.destination); o.start(t); o.stop(t + d + 0.02);
  },
  draw() { [392, 523, 659, 784].forEach((f, i) => this.tone(f, 0.15, 'triangle', i * 0.08)); },
  tick() { this.tone(880, 0.06, 'square', 0, 0.12); },
  stop() { this.tone(180, 0.35, 'sawtooth', 0, 0.3); this.tone(140, 0.35, 'sawtooth', 0.12, 0.3); },
  done() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.2, 'sine', i * 0.1)); },
};
document.addEventListener('pointerdown', () => Snd.unlock(), { once: true });
document.addEventListener('keydown', () => Snd.unlock(), { once: true });

// ---------- tela inicial / criar / entrar ----------
function homeScreen() {
  return `<section class="hero">
    <div class="tag">Adedonha online</div>
    <h1>STOP<span>!</span></h1>
    <p class="muted">Crie uma sala, mande o link no WhatsApp e jogue com a galera em tempo real. Sem instalar nada.</p>
  </section>
  <div class="grid2">
    <div class="card stack">
      <h2>Nova partida</h2>
      <p class="muted">Você será o administrador: configura as regras e inicia as rodadas.</p>
      <button class="primary" data-act="goCreate">Criar sala</button>
    </div>
    <form class="card stack" data-submit="goJoinCode">
      <h2>Entrar com código</h2>
      <label class="f"><span>Código da sala</span><input name="code" maxlength="5" autocapitalize="characters" autocomplete="off" placeholder="ABCDE" required style="text-transform:uppercase"></label>
      <button class="primary">Entrar</button>
    </form>
  </div>
  <p class="center"><button class="ghost small" data-act="goHistory">Histórico de partidas</button></p>`;
}

function createScreen() {
  return `<form class="card stack" data-submit="doCreate">
    <h2>Criar sala</h2>
    <label class="f"><span>Nome da sala</span><input name="roomName" maxlength="40" placeholder="Ex.: Stop da família" autocomplete="off"></label>
    <label class="f"><span>Seu nome (administrador)</span><input name="adminName" maxlength="20" required autocomplete="nickname" value="${esc(LS.get('name', ''))}"></label>
    <div class="grid2">
      <label class="f"><span>Máximo de jogadores</span><input name="maxPlayers" type="number" min="2" max="30" value="12" inputmode="numeric"></label>
      <label class="f"><span>Senha (opcional)</span><input name="password" type="password" maxlength="64" autocomplete="new-password" placeholder="Deixe vazio para só link"></label>
    </div>
    <p class="muted">A sala é privada: só entra quem tem o link ou o código.</p>
    <div class="row"><button type="button" class="ghost" data-act="goHome">Voltar</button><button class="primary grow">Criar sala</button></div>
  </form>`;
}

function joinScreen() {
  const i = S.joinInfo;
  if (!i) return `<div class="card center"><p>Procurando a sala…</p><button class="ghost" data-act="goHome">Voltar</button></div>`;
  if (i.error) return `<div class="card center stack"><h2>Ops!</h2><p>${esc(i.error)}</p><button class="primary" data-act="goHome">Voltar ao início</button></div>`;
  return `<form class="card stack" data-submit="doJoin">
    <h2>Entrar em “${esc(i.name)}”</h2>
    <p class="muted">Código ${esc(i.code)} · ${i.players}/${i.max} jogadores</p>
    <label class="f"><span>Seu nome ou apelido</span><input name="name" maxlength="20" required autocomplete="nickname" value="${esc(LS.get('name', ''))}" autofocus></label>
    ${i.hasPassword ? `<label class="f"><span>Senha da sala</span><input name="password" type="password" maxlength="64" required autocomplete="off"></label>` : ''}
    <div class="row"><button type="button" class="ghost" data-act="goHome">Voltar</button><button class="primary grow">Entrar na sala</button></div>
  </form>`;
}

function historyScreen() {
  const rows = S.history.map((h) => `<div class="card"><div class="row sp"><b>${esc(h.name)}</b><small>${new Date(h.finishedAt).toLocaleString('pt-BR')}</small></div>
    <small>${h.rounds} rodada(s)</small>
    <ol>${(h.ranking || []).slice(0, 3).map((r) => `<li>${esc(r.name)} — ${r.total} pts</li>`).join('')}</ol></div>`).join('');
  return `<h2>Histórico de partidas</h2>${rows || '<div class="card muted">Nenhuma partida encerrada neste navegador ainda.</div>'}
    <button class="primary" data-act="goHome">Voltar</button>`;
}

// ---------- componentes de sala ----------
const medals = ['🥇', '🥈', '🥉'];
function top3Html(v) {
  const r = v.ranking;
  const slot = (i) => r[i] ? `<div class="slot"><div class="medal">${medals[i]}</div><div class="n">${esc(r[i].name)}</div><div class="p">${r[i].total}</div></div>` : `<div class="slot"><div class="medal">${medals[i]}</div><div class="n muted">—</div></div>`;
  return `<button class="top3" data-act="openRank" aria-label="Abrir classificação completa">${slot(0)}${slot(1)}${slot(2)}<span class="hint">Top 3 · toque para ver a classificação completa</span></button>`;
}

function renderTop() {
  const v = S.view;
  if (!v) { topEl.hidden = true; return; }
  topEl.hidden = false;
  const n = v.round && v.phase !== 'lobby' ? ` · Rodada ${v.round.n}` : '';
  topEl.innerHTML = `<div class="in"><span class="brand">STOP!</span>
    <div class="rname"><span class="dot ${S.online ? '' : 'bad'}" title="${S.online ? 'Conectado' : 'Sem conexão'}"></span>${esc(v.name)}<small>${esc(v.code)}${n}</small></div>
    <button class="icon small" data-act="soundMenu" aria-label="Som">${Snd.mute ? '🔇' : '🔊'}</button>
    <button class="icon small ghost" data-act="leaveRoom" aria-label="Sair da sala">Sair</button></div>`;
}

function inviteLink(v) { return `${location.origin}/s/${v.code}`; }

function playersList(v, { manage = false } = {}) {
  return `<ul class="plist">${v.players.map((p) => `<li class="${p.id === v.you.id ? 'me' : ''}">
    <span class="dot ${p.connected ? '' : 'off'}" title="${p.connected ? 'Online' : 'Desconectado'}"></span>
    <span class="nm">${esc(p.name)}${p.id === v.you.id ? ' <small>(você)</small>' : ''}</span>
    ${p.isAdmin ? '<span class="chip adm">👑 Admin</span>' : ''}${p.connected ? '' : '<span class="chip mut">offline</span>'}
    ${manage && v.you.isAdmin && !p.isAdmin ? `<button class="small" data-act="makeAdmin" data-id="${p.id}" title="Transferir administração">👑</button><button class="small danger" data-act="kick" data-id="${p.id}" aria-label="Remover ${esc(p.name)}">✕</button>` : ''}
  </li>`).join('')}</ul>`;
}

function adminAbsentBanner(v) {
  if (!v.adminAbsent || v.you.isAdmin) return '';
  return `<div class="card"><b>O administrador está ausente.</b> <button class="primary small" data-act="claimAdmin">Assumir administração</button></div>`;
}

function rulesSummary(v) {
  const s = v.settings;
  const end = { manual: 'STOP manual', all: 'Todos terminaram', timer: `Cronômetro (${s.timerSec}s)` }[s.endMode];
  const val = { admin: 'Pelo administrador', players: 'Pelos jogadores', hybrid: 'Híbrida' }[s.validationMode];
  const nc = s.categories.filter((c) => c.active).length;
  return `<dl class="kv"><dt>Categorias</dt><dd>${s.maxCategoriesPerRound > 0 ? Math.min(nc, s.maxCategoriesPerRound) + ' por rodada (de ' + nc + ')' : nc + ' ativas'}</dd>
    <dt>Letras</dt><dd>${s.enabledLetters.join(' ')}</dd><dt>Encerramento</dt><dd>${end}</dd><dt>Validação</dt><dd>${val}</dd>
    <dt>Pontos</dt><dd>${s.scoring.unique} única · ${s.scoring.repeated} repetida · ${s.scoring.invalid} inválida</dd></dl>`;
}

// ---------- sala de espera ----------
function lobbyScreen(v) {
  const link = inviteLink(v);
  return `${adminAbsentBanner(v)}${top3Html(v)}
  <div class="grid2">
    <div class="card stack"><h2>Convide a galera</h2>
      <p class="muted">Código: <b style="font-size:1.4rem;letter-spacing:.1em">${esc(v.code)}</b></p>
      <input class="link" readonly value="${esc(link)}" aria-label="Link de convite" onfocus="this.select()">
      <div class="row"><button class="primary grow" data-act="copyLink">📋 Copiar link</button><button class="good grow" data-act="whatsapp">WhatsApp</button></div>
      ${v.hasPassword ? '<small>🔒 Esta sala tem senha.</small>' : ''}
    </div>
    <div class="card"><h2>Jogadores (${v.players.length}/${v.maxPlayers})</h2>${playersList(v, { manage: true })}</div>
  </div>
  <div class="card"><div class="row sp"><h2>Regras da partida</h2>${v.you.isAdmin ? '<button data-act="openSettings">⚙ Configurar</button>' : ''}</div>${rulesSummary(v)}</div>
  ${v.you.isAdmin
    ? `<button class="primary" style="width:100%;font-size:1.3rem" data-act="startRound">▶ Iniciar partida</button>`
    : `<div class="card center muted">Aguardando o administrador iniciar a partida…</div>`}`;
}

// ---------- configurações (admin) ----------
function selectHtml(key, opts, val) {
  return `<select data-set="${key}">${opts.map(([x, l]) => `<option value="${x}" ${String(x) === String(val) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
}
function numHtml(key, val, min, max) { return `<input type="number" data-set="${key}" value="${val}" min="${min}" max="${max}" inputmode="numeric">`; }
function chkHtml(key, val, label) { return `<label class="chk"><input type="checkbox" data-set="${key}" ${val ? 'checked' : ''}>${label}</label>`; }

function settingsScreen(v) {
  const s = v.settings, sc = s.scoring;
  const used = new Set(v.letters.used);
  return `<div class="row sp"><h2>⚙ Configurações da partida</h2><button class="primary" data-act="closeSettings">Concluir</button></div>
  <div class="card"><h3>Categorias</h3>
    <div class="cats">${s.categories.map((c, i) => `<div class="crow">
      <input type="checkbox" ${c.active ? 'checked' : ''} data-act="catToggle" data-i="${i}" aria-label="Ativar ${esc(c.name)}">
      <input value="${esc(c.name)}" maxlength="40" data-catname="${i}" aria-label="Nome da categoria ${i + 1}">
      <button class="small icon" data-act="catUp" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Subir">↑</button>
      <button class="small icon" data-act="catDown" data-i="${i}" ${i === s.categories.length - 1 ? 'disabled' : ''} aria-label="Descer">↓</button>
      <button class="small icon danger" data-act="catDel" data-i="${i}" aria-label="Excluir">🗑</button></div>`).join('')}</div>
    <form class="row" data-submit="catAdd"><input name="name" maxlength="40" placeholder="Nova categoria" class="grow" required><button class="primary">Adicionar</button></form>
    <div class="field-grid"><label class="f"><span>Limite de categorias por rodada (0 = todas ativas)</span>${numHtml('maxCategoriesPerRound', s.maxCategoriesPerRound, 0, 60)}</label></div>
    <details><summary>Conjuntos favoritos</summary>
      <div class="row"><select id="setSel" class="grow">${S.sets.map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join('') || '<option value="">(nenhum salvo)</option>'}</select>
        <button class="small" data-act="setLoad">Carregar</button><button class="small danger" data-act="setDel">Excluir</button></div>
      <form class="row" data-submit="setSave" style="margin-top:8px"><input name="name" maxlength="40" placeholder="Nome do conjunto atual" class="grow" required><button class="small">Salvar conjunto</button></form>
    </details>
  </div>
  <div class="card"><h3>Letras</h3>
    <p class="muted">Toque para habilitar/desabilitar. Já sorteadas: ${v.letters.used.join(' ') || 'nenhuma'} · disponíveis: ${v.letters.available}</p>
    <div class="letters">${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `<button class="${s.enabledLetters.includes(l) ? 'on' : ''} ${used.has(l) ? 'used' : ''}" data-act="letterToggle" data-l="${l}" aria-pressed="${s.enabledLetters.includes(l)}">${l}</button>`).join('')}</div>
    <div class="row" style="margin-top:8px"><button class="small" data-act="lettersAll">Todas</button><button class="small" data-act="lettersEasy">Sem K W X Y</button></div>
    ${chkHtml('noRepeatLetters', s.noRepeatLetters, 'Não repetir letras na partida')}
    <label class="f"><span>Quando as letras acabarem</span>${selectHtml('onLettersExhausted', [['end', 'Encerrar a partida'], ['cycle', 'Iniciar um novo ciclo']], s.onLettersExhausted)}</label>
  </div>
  <div class="card"><h3>Encerramento da rodada</h3>
    <div class="field-grid">
    <label class="f"><span>Modo</span>${selectHtml('endMode', [['manual', 'A — STOP manual (qualquer jogador)'], ['all', 'B — Todos terminaram'], ['timer', 'C — Cronômetro']], s.endMode)}</label>
    <label class="f"><span>Tempo da rodada (segundos)</span>${numHtml('timerSec', s.timerSec, 10, 900)}</label></div>
    <div class="row">${[60, 90, 120].map((t) => `<button class="small" data-act="timerPreset" data-t="${t}">${t}s</button>`).join('')}</div>
  </div>
  <div class="card"><h3>Validação das respostas</h3>
    <div class="field-grid">
    <label class="f"><span>Modo</span>${selectHtml('validationMode', [['players', 'B — Votação dos jogadores'], ['admin', 'A — Administrador'], ['hybrid', 'Híbrida (jogadores + admin nos controversos)']], s.validationMode)}</label>
    <label class="f"><span>Mínimo de votos (válido+inválido)</span>${numHtml('minVotes', s.minVotes, 1, 20)}</label>
    <label class="f"><span>Aprovação (% de votos “válida”)</span>${numHtml('approvalPct', s.approvalPct, 1, 100)}</label>
    <label class="f"><span>Em caso de empate</span>${selectHtml('tieRule', [['admin', 'Administrador decide'], ['valid', 'Vale como válida'], ['invalid', 'Vale como inválida']], s.tieRule)}</label></div>
    ${chkHtml('strictAccents', s.strictAccents, 'Considerar acentos ao validar a letra (Água ≠ A)')}
    ${chkHtml('allowCorrection', s.allowCorrection, 'Administrador pode corrigir erros de digitação')}
  </div>
  <div class="card"><h3>Pontuação</h3>
    <div class="field-grid">
      <label class="f"><span>Resposta única</span>${numHtml('scoring.unique', sc.unique, -100, 1000)}</label>
      <label class="f"><span>Resposta repetida</span>${numHtml('scoring.repeated', sc.repeated, -100, 1000)}</label>
      <label class="f"><span>Inválida</span>${numHtml('scoring.invalid', sc.invalid, -100, 1000)}</label>
      <label class="f"><span>Em branco</span>${numHtml('scoring.blank', sc.blank, -100, 1000)}</label></div>
    ${chkHtml('scoring.partialEnabled', sc.partialEnabled, 'Permitir “parcialmente correta”')}${sc.partialEnabled ? `<label class="f"><span>Pontos (parcial)</span>${numHtml('scoring.partial', sc.partial, -100, 1000)}</label>` : ''}
    ${chkHtml('scoring.bonusAllEnabled', sc.bonusAllEnabled, 'Bônus por todas as categorias válidas')}${sc.bonusAllEnabled ? `<label class="f"><span>Pontos do bônus</span>${numHtml('scoring.bonusAll', sc.bonusAll, -100, 1000)}</label>` : ''}
    ${chkHtml('scoring.bonusFirstEnabled', sc.bonusFirstEnabled, 'Bônus por ser o primeiro a concluir (tudo preenchido)')}${sc.bonusFirstEnabled ? `<label class="f"><span>Pontos do bônus</span>${numHtml('scoring.bonusFirst', sc.bonusFirst, -100, 1000)}</label>` : ''}
    <label class="f"><span>Desempate no ranking</span>${selectHtml('rankingTie', [['share', 'Compartilhar a posição'], ['uniques', 'Mais respostas únicas']], s.rankingTie)}</label>
  </div>
  <div class="card"><h3>Sala</h3>
    <label class="f"><span>Tempo para considerar o admin ausente (segundos)</span>${numHtml('adminGraceSec', s.adminGraceSec, 5, 900)}</label>
    ${chkHtml('historyEnabled', s.historyEnabled, 'Salvar partida no histórico ao encerrar')}
  </div>`;
}

// ---------- tela de jogo (atualizada de forma incremental) ----------
function gameScreen(v) {
  const r = v.round, s = v.settings;
  const confirmLabel = s.endMode === 'all' ? 'Terminei ✔' : 'Confirmar respostas';
  return `<div data-incremental>
  ${top3Html(v)}
  <div class="hud"><div class="letter" id="letter" role="img" aria-label="Letra sorteada ${esc(r.letter)}">${esc(r.letter)}</div>
    <div><div class="timer" id="timer" aria-live="off"></div><div class="bar" id="tbarw"><i id="tbar" style="width:100%"></i></div>
      <div class="muted" id="gmeta"></div></div></div>
  <div id="gstate" role="status"></div>
  <form class="answers" id="answers" autocomplete="off" onsubmit="return false">${r.categories.map((c, i) => `
    <div class="arow" data-row="${c.id}"><label for="a_${c.id}"><span>${i + 1}. ${esc(c.name)}</span><span class="mk" aria-hidden="true"></span></label>
    <input id="a_${c.id}" data-cat="${c.id}" maxlength="60" enterkeyhint="${i === r.categories.length - 1 ? 'done' : 'next'}" autocapitalize="sentences" spellcheck="false" placeholder="${esc(r.letter)}…"></div>`).join('')}</form>
  <div class="actionbar"><span class="save" id="save" aria-live="polite"></span>
    <button class="good" id="confirmBtn" data-act="confirm">${confirmLabel}</button>
    ${s.endMode === 'manual' ? '<button class="stopbtn" id="stopBtn" data-act="stop">STOP!</button>' : ''}</div>
  <div class="card"><h3>Jogadores</h3><div class="pchips" id="pchips"></div>
    <p class="muted" style="margin-top:8px">Letras usadas: <span class="letters-used" id="lused"></span></p></div>
  <div id="gadmin"></div></div>`;
}

function updateGame(v) {
  const r = v.round, s = v.settings;
  if (!r) return;
  const locked = v.phase !== 'playing' || v.paused || r.myConfirmed || !r.participating;
  for (const inp of $$('#answers input')) {
    inp.disabled = locked;
    const srv = r.myAnswers[inp.dataset.cat] || '';
    if (!inp.value && srv && document.activeElement !== inp) inp.value = srv;
    const row = inp.closest('.arow');
    row.classList.toggle('done', !!inp.value.trim());
    $('.mk', row).textContent = inp.value.trim() ? '✔' : '';
  }
  $('#confirmBtn').disabled = locked;
  if ($('#confirmBtn') && r.myConfirmed) $('#confirmBtn').textContent = 'Respostas confirmadas ✔';
  const st = $('#stopBtn'); if (st) st.disabled = v.phase !== 'playing' || v.paused || !r.participating;
  const online = v.players.filter((p) => p.connected).length;
  $('#gmeta').textContent = `Rodada ${r.n} · ${online} online · ${v.letters.available} letra(s) restante(s)`;
  $('#gstate').innerHTML = v.paused ? '<div class="card center"><b>⏸ Partida pausada pelo administrador</b></div>'
    : !r.participating ? '<div class="card center muted">Você entrou durante a rodada — participa na próxima.</div>'
    : r.myConfirmed ? '<div class="card center muted">Respostas confirmadas. Aguardando os outros jogadores…</div>' : '';
  const total = r.categories.length;
  $('#pchips').innerHTML = (r.progress || []).map((p) => {
    const pl = v.players.find((x) => x.id === p.id);
    return `<span class="chip ${p.confirmed ? 'ok' : ''} ${pl?.connected ? '' : 'mut'}">${esc(pl?.name || '?')} ${p.filled}/${total}${p.confirmed ? ' ✔' : ''}${pl?.connected ? '' : ' (offline)'}</span>`;
  }).join('');
  $('#lused').innerHTML = v.letters.used.map((l) => `<b>${l}</b>`).join('');
  $('#gadmin').innerHTML = v.you.isAdmin ? `<details class="card"><summary>Controles do administrador</summary><div class="row">
    ${v.paused ? '<button class="good" data-act="resume">▶ Retomar</button>' : '<button data-act="pause">⏸ Pausar</button>'}
    <button data-act="endRound">⏹ Encerrar rodada</button><button data-act="restartRound">↻ Reiniciar rodada</button>
    <button class="danger" data-act="voidRound">Anular rodada</button><button class="danger" data-act="endGame">Encerrar partida</button></div></details>` : '';
  tickTimer();
  setSave(S.save);
}

function setSave(state) {
  S.save = state;
  const el = $('#save');
  if (el) el.textContent = !S.online ? '⚠ Sem conexão — suas respostas serão reenviadas' : { saving: 'Salvando…', ok: '✔ Salvo', pend: '…' }[state] || '';
}

function tickTimer() {
  const v = S.view, r = v?.round, el = $('#timer');
  if (!el || v.phase !== 'playing' || !r) return;
  if (!r.endsAt && r.remainingMs == null) { el.textContent = '∞'; $('#tbarw').style.visibility = 'hidden'; return; }
  const total = v.settings.timerSec * 1000;
  const rem = v.paused ? (r.remainingMs ?? 0) : Math.max(0, r.endsAt - serverNow());
  const sec = Math.ceil(rem / 1000);
  el.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  el.classList.toggle('low', sec <= 10 && !v.paused);
  $('#tbar').style.width = Math.min(100, (rem / total) * 100) + '%';
  if (sec !== S.lastSec) { S.lastSec = sec; if (sec <= 5 && sec > 0 && !v.paused) Snd.tick(); if (sec === 10) announce('Faltam 10 segundos'); }
  if (rem <= 0 && !S.flushed) { S.flushed = true; flushAnswers(); }
}
setInterval(tickTimer, 200);

function spinLetter(letter) {
  const el = $('#letter');
  if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) { announce(`Letra sorteada: ${letter}`); return; }
  el.classList.add('spin');
  const id = setInterval(() => { el.textContent = 'ABCDEFGHIJLMNOPRSTUV'[Math.floor(Math.random() * 20)]; }, 70);
  setTimeout(() => { clearInterval(id); el.classList.remove('spin'); el.textContent = letter; announce(`Letra sorteada: ${letter}`); }, 1100);
}

// ---- respostas: salvamento automático com debounce ----
const timers = new Map();
function collectAnswers() { return Object.fromEntries($$('#answers input').map((i) => [i.dataset.cat, i.value])); }
function flushAnswers() {
  timers.forEach((t) => clearTimeout(t)); timers.clear();
  if (!$('#answers')) return Promise.resolve();
  return call('answers', { answers: collectAnswers() }, { silent: true }).then(() => setSave('ok')).catch(() => setSave('pend'));
}
function queueAnswer(input) {
  const id = input.dataset.cat;
  clearTimeout(timers.get(id));
  setSave('saving');
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    call('answer', { catId: id, text: input.value }, { silent: true }).then(() => { if (!timers.size) setSave('ok'); }).catch(() => setSave('pend'));
  }, 250));
}
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.matches?.('#answers input')) {
    const row = t.closest('.arow'); row.classList.toggle('done', !!t.value.trim()); $('.mk', row).textContent = t.value.trim() ? '✔' : '';
    queueAnswer(t);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches?.('#answers input')) {
    e.preventDefault();
    const all = $$('#answers input'), i = all.indexOf(e.target);
    (all[i + 1] || $('#confirmBtn'))?.focus();
  }
});

// ---------- validação ----------
const statusChip = (e) => e.pending ? '<span class="chip warn">⚠ Em análise</span>'
  : { valid: '<span class="chip ok">Válida</span>', invalid: '<span class="chip no">Inválida</span>', blank: '<span class="chip mut">Em branco</span>', partial: '<span class="chip warn">Parcial</span>' }[e.status];

function entryHtml(e, v, interactive) {
  const r = v.round, mode = v.settings.validationMode, mine = e.pid === v.you.id;
  const admin = v.you.isAdmin;
  let ctl = '';
  if (interactive && e.text) {
    const canVote = mode !== 'admin' && !mine && e.auto && r.participating && !r.myVoteConfirmed;
    if (canVote) {
      const b = (val, label, cls) => `<button class="small vbtn ${cls} ${e.myVote === val ? 'sel' : ''}" data-act="vote" data-a="${e.pid}" data-c="${e.catId}" data-v="${val}" aria-pressed="${e.myVote === val}">${label}</button>`;
      ctl += `<div class="row">${b('v', '👍 Válida', 'good')}${b('i', '👎 Inválida', 'danger')}${b('u', '🤷 Não sei', '')}</div>`;
    }
    if (admin && (mode !== 'players' || e.pending)) {
      ctl += `<div class="row"><button class="small good" data-act="decide" data-a="${e.pid}" data-c="${e.catId}" data-s="valid">✔ Aprovar</button>
        <button class="small danger" data-act="decide" data-a="${e.pid}" data-c="${e.catId}" data-s="invalid">✖ Rejeitar</button>
        <button class="small" data-act="decide" data-a="${e.pid}" data-c="${e.catId}" data-s="controversial">⚠ Controversa</button>
        ${v.settings.scoring.partialEnabled ? `<button class="small" data-act="decide" data-a="${e.pid}" data-c="${e.catId}" data-s="partial">½ Parcial</button>` : ''}
        ${v.settings.allowCorrection ? `<button class="small" data-act="correct" data-a="${e.pid}" data-c="${e.catId}" data-t="${esc(e.text)}">✎ Corrigir</button>` : ''}
        ${e.decision ? `<button class="small ghost" data-act="decide" data-a="${e.pid}" data-c="${e.catId}" data-s="clear">Desfazer</button>` : ''}</div>`;
    }
  }
  const votes = mode !== 'admin' && e.text && e.auto ? `<span class="chip mut" title="Votos">👍 ${e.votes.v} · 👎 ${e.votes.i} · 🤷 ${e.votes.u}</span>` : '';
  const showPts = !interactive;
  return `<div class="ent ${e.status === 'invalid' ? 'bad' : ''} ${e.pending ? 'pend' : ''}">
    <div class="row sp"><span class="who">${esc(e.name)}${mine ? ' (você)' : ''}</span><span class="row">${votes}${statusChip(e)}${showPts ? `<span class="pts">+${e.points}</span>` : ''}</span></div>
    <div class="txt">${e.text ? esc(e.text) : '<span class="muted">—</span>'}${e.corrected != null && e.raw !== e.corrected ? ` <small class="muted">(digitado: ${esc(e.raw)})</small>` : ''}</div>
    ${showPts ? `<div class="why">${esc(e.reason)}</div>` : ''}${ctl}</div>`;
}

function boardHtml(v, interactive) {
  return v.round.board.map((c) => `<section class="card cat"><h3>${esc(c.name)}</h3>${c.entries.map((e) => entryHtml(e, v, interactive)).join('')}</section>`).join('');
}

function roundHeader(v) {
  const r = v.round;
  const why = { stop: `STOP acionado por ${esc(r.stoppedBy)}`, timer: 'O tempo acabou', all: 'Todos terminaram', admin: 'Encerrada pelo administrador' }[r.endReason] || '';
  return `<div class="hud"><div class="letter">${esc(r.letter)}</div><div><h2>Rodada ${r.n}</h2><p class="muted">${why}</p></div></div>`;
}

function validationScreen(v) {
  const r = v.round, s = v.settings;
  if (r.revealing || !r.board) return `${roundHeader(v)}<div class="card center"><h2>Reunindo as respostas…</h2></div>`;
  const mode = s.validationMode, admin = v.you.isAdmin;
  const modeTxt = { admin: 'O administrador valida as respostas.', players: 'Votem nas respostas dos colegas. Você não vota na sua.', hybrid: 'Jogadores votam; o administrador decide os controversos.' }[mode];
  return `${adminAbsentBanner(v)}${roundHeader(v)}
    <div class="card"><b>Validação</b> — ${modeTxt}${r.pendingCount ? `<br><span class="chip warn">⚠ ${r.pendingCount} resposta(s) aguardando o administrador</span>` : ''}</div>
    ${boardHtml(v, true)}
    <div class="actionbar" style="flex-direction:column;align-items:stretch">
      ${mode !== 'admin' && r.participating ? `<button class="${r.myVoteConfirmed ? '' : 'primary'}" data-act="confirmVotes" ${r.myVoteConfirmed ? 'disabled' : ''}>${r.myVoteConfirmed ? 'Votos confirmados ✔' : 'Confirmar meus votos'}</button>
        <small class="center">${r.votesDone}/${r.votesTotal} jogadores confirmaram</small>` : ''}
      ${admin ? `<div class="row"><button class="primary grow" data-act="finalize">Finalizar validação${r.pendingCount ? ` (${r.pendingCount} pendente${r.pendingCount > 1 ? 's' : ''})` : ''}</button>
        ${mode !== 'admin' ? '<button data-act="reopenVotes">Reabrir votação</button>' : ''}<button class="danger" data-act="voidRound">Anular rodada</button></div>`
        : (mode === 'admin' || hybridWait(v) ? '<small class="center">Aguardando o administrador…</small>' : '')}
    </div>`;
}
const hybridWait = (v) => v.settings.validationMode === 'hybrid';

// ---------- resultado da rodada ----------
function resultsScreen(v) {
  const r = v.round, admin = v.you.isAdmin;
  if (r.voided) {
    return `${top3Html(v)}<div class="card center stack"><h2>Rodada ${r.n} anulada</h2><p class="muted">Esta rodada não conta pontos.</p>${adminNext(v)}</div>`;
  }
  const ranked = v.players.filter((p) => r.scores[p.id]).sort((a, b) => r.scores[b.id].total - r.scores[a.id].total);
  const cards = ranked.map((p) => {
    const sc = r.scores[p.id];
    const rows = r.board.map((c) => { const e = c.entries.find((x) => x.pid === p.id); return `<div class="ent ${e.status === 'invalid' ? 'bad' : ''}"><div class="row sp"><span class="who">${esc(c.name)}</span><span class="row">${statusChip(e)}<span class="pts">+${e.points}</span></span></div>
      <div class="txt">${e.text ? esc(e.text) : '<span class="muted">—</span>'}</div><div class="why">${esc(e.reason)}</div></div>`; }).join('');
    const bonus = sc.bonuses.map((b) => `<div class="why">⭐ ${esc(b.label)}: +${b.points}</div>`).join('');
    return `<details class="card pcard" ${p.id === v.you.id ? 'open' : ''}><summary class="hd"><span><b>${esc(p.name)}</b>${p.id === v.you.id ? ' <small>(você)</small>' : ''}</span><span class="tot">+${sc.total}</span></summary>${rows}${bonus}</details>`;
  }).join('');
  return `${adminAbsentBanner(v)}${top3Html(v)}<div class="hud"><div class="letter">${esc(r.letter)}</div><div><h2>Resultado da rodada ${r.n}</h2><p class="muted">Toque em um jogador para ver a justificativa de cada ponto.</p></div></div>
    ${cards}
    <div class="card"><details><summary>Respostas de todos por categoria</summary>${boardHtml(v, false)}</details></div>
    ${adminNext(v)}`;
}

function adminNext(v) {
  if (!v.you.isAdmin) return '<div class="card center muted">Aguardando o administrador iniciar a próxima rodada…</div>';
  const none = v.letters.available === 0 && v.settings.noRepeatLetters && v.settings.onLettersExhausted === 'end';
  return `<div class="card stack">
    ${none ? '<p><b>Todas as letras disponíveis já foram usadas.</b> Encerre a partida ou habilite mais letras.</p>' : ''}
    <button class="primary" style="font-size:1.2rem" data-act="startRound">${none ? 'Ver fim da partida' : '▶ Próxima rodada'}</button>
    <div class="row"><button data-act="openSettings">⚙ Regras</button>
      ${!v.round.voided ? '<button data-act="reopenRound">✎ Corrigir validação</button><button class="danger" data-act="voidRound">Anular rodada</button>' : ''}
      <button class="danger" data-act="endGame">🏁 Encerrar partida</button></div>
    <small>Letras disponíveis: ${v.letters.available}</small></div>`;
}

// ---------- fim da partida ----------
function finalScreen(v) {
  const r = v.ranking;
  const pod = [1, 0, 2].map((i) => r[i] ? `<div class="pl p${i + 1}"><div class="big">${medals[i]}</div><div class="name">${esc(r[i].name)}</div><div class="pt">${r[i].total}</div></div>` : '<div></div>').join('');
  return `<div class="hero"><div class="tag">Fim de jogo</div><h1>${r[0] ? '🏆 ' + esc(r[0].name) : 'Partida encerrada'}</h1></div>
    <div class="podium">${pod}</div>
    <div class="card scroll">${rankTable(v, 'general')}</div>
    <div class="card"><h3>Letras sorteadas</h3><div class="letters-used">${v.letters.history.map((h) => `<b>${h.letter}</b>`).join('') || '—'}</div></div>
    <div class="row">${v.you.isAdmin ? '<button class="primary grow" data-act="resetGame">Nova partida nesta sala</button>' : ''}<button class="grow" data-act="leaveRoom">Sair da sala</button></div>`;
}

// ---------- ranking completo ----------
function rankTable(v, mode) {
  const rows = v.ranking;
  if (!rows.length) return '<p class="muted">Ainda não há jogadores.</p>';
  if (mode === 'round') {
    const r = v.round?.scores;
    if (!r) return '<p class="muted">Sem pontuação nesta rodada ainda.</p>';
    const list = rows.filter((x) => r[x.id]).sort((a, b) => r[b.id].total - r[a.id].total);
    return `<table class="tbl"><thead><tr><th>#</th><th>Jogador</th><th class="n">Pts na rodada</th></tr></thead><tbody>${list.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.name)}</td><td class="n"><b>${r[x.id].total}</b></td></tr>`).join('')}</tbody></table>${v.phase === 'validating' ? '<small class="muted">Pontuação provisória (validação em andamento).</small>' : ''}`;
  }
  const rounds = rows[0].perRound;
  return `<table class="tbl"><thead><tr><th>#</th><th>Jogador</th><th class="n">Total</th>${rounds.map((x) => `<th class="n"><button class="small ghost" data-act="roundDetail" data-n="${x.n}" title="Ver rodada ${x.n}">R${x.n} ${x.letter}</button></th>`).join('')}
    <th class="n">Únicas</th><th class="n">Repet.</th><th class="n">Inválidas</th><th class="n">Brancos</th></tr></thead><tbody>
    ${rows.map((x) => `<tr><td>${x.pos <= 3 ? medals[x.pos - 1] : x.pos}</td><td>${esc(x.name)}${x.id === v.you.id ? ' <small>(você)</small>' : ''}</td><td class="n"><b>${x.total}</b></td>
      ${x.perRound.map((p) => `<td class="n">${p.points}</td>`).join('')}<td class="n">${x.unique}</td><td class="n">${x.repeated}</td><td class="n">${x.invalid}</td><td class="n">${x.blank}</td></tr>`).join('')}</tbody></table>`;
}

function renderModal() {
  const v = S.view;
  if (!S.ui.showRank || !v) { modal.hidden = true; modal.innerHTML = ''; return; }
  const d = S.ui.detail;
  modal.hidden = false;
  modal.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Classificação">
    <div class="row sp"><h2>Classificação</h2><button data-act="closeRank" aria-label="Fechar">✕</button></div>
    <div class="row" style="margin-bottom:10px"><button class="small ${S.ui.rank === 'general' ? 'primary' : ''}" data-act="rankMode" data-m="general">Geral</button>
      <button class="small ${S.ui.rank === 'round' ? 'primary' : ''}" data-act="rankMode" data-m="round">Rodada atual</button></div>
    <div class="scroll">${rankTable(v, S.ui.rank)}</div>
    ${d ? `<div class="card" style="margin-top:12px"><h3>Rodada ${d.n} (letra ${esc(d.letter)})</h3>${d.board.map((c) => `<p><b>${esc(c.name)}</b></p>${c.entries.map((e) => `<div class="row sp"><span>${esc(e.name)}: ${esc(e.text || '—')}</span><span class="pts">+${e.points}</span></div><div class="why muted">${esc(e.reason)}</div>`).join('')}`).join('')}</div>` : ''}
    ${v.you.isAdmin && v.audit?.length ? `<details style="margin-top:12px"><summary>Registro de auditoria</summary><ul>${v.audit.slice().reverse().map((a) => `<li><small>${new Date(a.at).toLocaleTimeString('pt-BR')} — ${esc(a.by)}: ${esc(a.text)}</small></li>`).join('')}</ul></details>` : ''}
  </div>`;
}

// ---------- renderização ----------
function mount(key, html, update) {
  const same = S.mountKey === key;
  if (same && update) { update(); return; }
  S.mountKey = key;
  app.innerHTML = html();
  if (!same) window.scrollTo(0, 0);
  if (update) update();
}

function render() {
  const a = document.activeElement;
  const typing = a && app.contains(a) && a.matches?.('input:not([type=checkbox]):not([type=range]), textarea') && !a.closest('[data-incremental]');
  if (typing) { S.dirty = true; renderTop(); renderModal(); return; }
  S.dirty = false;
  renderTop();
  const v = S.view;
  if (!v) {
    const scr = S.screen;
    mount('out:' + scr + (S.joinInfo ? S.joinInfo.code || 'e' : ''), () => ({ home: homeScreen, create: createScreen, join: joinScreen, history: historyScreen }[scr] || homeScreen)());
    renderModal(); return;
  }
  const wasGame = S.mountKey?.startsWith('game:');
  if (wasGame && v.phase !== 'playing') flushAnswers();
  if (S.ui.settings && v.you.isAdmin && ['lobby', 'results', 'finished'].includes(v.phase)) {
    app.dataset.screen = 'settings'; mount('settings', () => settingsScreen(v));
  } else {
    S.ui.settings = false;
    app.dataset.screen = v.phase;
    switch (v.phase) {
      case 'lobby': mount('lobby', () => lobbyScreen(v)); break;
      case 'playing': {
        const key = 'game:' + v.round.id;
        const fresh = S.mountKey !== key;
        mount(key, () => gameScreen(v), () => updateGame(v));
        if (fresh) { S.flushed = false; S.lastSec = null; spinLetter(v.round.letter); const f = $('#answers input:not(:disabled)'); if (f) setTimeout(() => f.focus({ preventScroll: true }), 1200); }
        break;
      }
      case 'validating': mount('val:' + v.round.id, () => validationScreen(v)); break;
      case 'results': mount('res:' + v.round.id, () => resultsScreen(v)); break;
      case 'finished': mount('fin', () => finalScreen(v)); break;
      default: mount('x', () => '');
    }
  }
  renderModal();
}
document.addEventListener('focusout', () => { if (S.dirty) setTimeout(() => { if (S.dirty) render(); }, 80); });

// ---------- ações ----------
function loadInfo(code) {
  S.joinInfo = null;
  return call('room:info', { code }, { silent: true })
    .then((i) => { S.joinInfo = i; }).catch((e) => { S.joinInfo = { error: e.message }; });
}
const clearSession = () => { LS.del('session'); S.code = null; };
const goOut = (screen) => { S.view = null; S.code = null; S.screen = screen; S.mountKey = null; S.ui = { rank: 'general', showRank: false, settings: false, detail: null }; history.replaceState(null, '', '/'); render(); };
const formData = (form) => Object.fromEntries(new FormData(form).entries());
const catList = () => structuredClone(S.view.settings.categories);
const saveCats = (list) => call('settings', { categories: list }).catch(swallow);
const setPatch = (path, val) => call('settings', path.startsWith('scoring.') ? { scoring: { [path.slice(8)]: val } } : { [path]: val }).catch(swallow);
const ask = (msg) => confirm(msg);

const A = {
  goHome: () => goOut('home'),
  goCreate: () => { S.screen = 'create'; render(); },
  goHistory: async () => { S.history = await call('history:list', { token }).catch(() => []); S.screen = 'history'; render(); },
  goJoinCode(form) {
    const code = formData(form).code.trim().toUpperCase();
    S.screen = 'join'; S.code = code; render(); loadInfo(code).then(render);
  },
  async doCreate(form) {
    const d = formData(form); LS.set('name', d.adminName);
    try {
      const { code } = await call('room:create', { ...d, maxPlayers: Number(d.maxPlayers), token });
      S.code = code; LS.set('session', code); history.replaceState(null, '', '/s/' + code);
    } catch { /* toast já exibido */ }
  },
  async doJoin(form) {
    const d = formData(form); LS.set('name', d.name);
    try {
      await call('room:join', { code: S.joinInfo.code, name: d.name, password: d.password, token });
      S.code = S.joinInfo.code; LS.set('session', S.code); history.replaceState(null, '', '/s/' + S.code);
    } catch { /* toast */ }
  },
  leaveRoom: async () => {
    if (!ask('Sair da sala? Você poderá voltar pelo mesmo link neste aparelho.')) return;
    await call('room:leave', {}, { silent: true }).catch(swallow); clearSession(); goOut('home');
  },
  copyLink: async () => {
    const link = inviteLink(S.view);
    try { await navigator.clipboard.writeText(link); toast('Link copiado!'); }
    catch { const i = $('.link'); i?.select(); document.execCommand?.('copy'); toast('Link copiado!'); }
  },
  whatsapp: () => {
    const v = S.view;
    window.open(`https://wa.me/?text=${encodeURIComponent(`Vem jogar Stop comigo na sala "${v.name}"! ${inviteLink(v)}`)}`, '_blank', 'noopener');
  },
  kick: (el) => { const p = S.view.players.find((x) => x.id === el.dataset.id); if (ask(`Remover ${p?.name} da sala?`)) call('player:kick', { playerId: el.dataset.id }).catch(swallow); },
  makeAdmin: (el) => { const p = S.view.players.find((x) => x.id === el.dataset.id); if (ask(`Transferir a administração para ${p?.name}?`)) call('admin:transfer', { playerId: el.dataset.id }).catch(swallow); },
  claimAdmin: () => call('admin:claim').catch(swallow),
  openSettings: async () => { S.ui.settings = true; S.sets = await call('sets:list', { token }, { silent: true }).catch(() => []); render(); },
  closeSettings: () => { S.ui.settings = false; render(); },
  startRound: () => call('round:start').catch(swallow),
  // categorias
  catToggle: (el) => { const l = catList(); l[+el.dataset.i].active = el.checked; saveCats(l); },
  catUp: (el) => { const l = catList(), i = +el.dataset.i; [l[i - 1], l[i]] = [l[i], l[i - 1]]; saveCats(l); },
  catDown: (el) => { const l = catList(), i = +el.dataset.i; [l[i + 1], l[i]] = [l[i], l[i + 1]]; saveCats(l); },
  catDel: (el) => { const l = catList(); l.splice(+el.dataset.i, 1); saveCats(l); },
  catAdd: (form) => { const l = catList(); l.push({ name: formData(form).name, active: true }); form.reset(); saveCats(l); },
  setLoad: async () => {
    const x = S.sets.find((s) => s.name === $('#setSel').value); if (!x) return;
    await saveCats(x.categories); toast('Conjunto carregado');
  },
  setDel: async () => { const n = $('#setSel').value; if (n && ask(`Excluir o conjunto "${n}"?`)) { S.sets = await call('sets:delete', { token, name: n }); render(); } },
  setSave: async (form) => {
    const cats = S.view.settings.categories.map(({ name, active }) => ({ name, active }));
    S.sets = await call('sets:save', { token, name: formData(form).name, categories: cats }).catch(() => S.sets); toast('Conjunto salvo'); render();
  },
  letterToggle: (el) => {
    const cur = new Set(S.view.settings.enabledLetters); cur.has(el.dataset.l) ? cur.delete(el.dataset.l) : cur.add(el.dataset.l);
    call('settings', { enabledLetters: [...cur] }).catch(swallow);
  },
  lettersAll: () => call('settings', { enabledLetters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('') }).catch(swallow),
  lettersEasy: () => call('settings', { enabledLetters: 'ABCDEFGHIJLMNOPQRSTUVZ'.split('') }).catch(swallow),
  timerPreset: (el) => call('settings', { timerSec: +el.dataset.t, endMode: 'timer' }).catch(swallow),
  // jogo
  confirm: async () => {
    try { await call('confirm', { answers: collectAnswers() }); setSave('ok'); } catch { /* toast */ }
  },
  stop: () => { Snd.stop(); call('stop', { answers: collectAnswers() }, { silent: true }).catch((e) => { if (e.code !== 'ENDED') toast(e.message, true); }); },
  pause: () => call('game:pause').catch(swallow),
  resume: () => call('game:resume').catch(swallow),
  endRound: () => { if (ask('Encerrar a rodada agora?')) call('round:end').catch(swallow); },
  restartRound: () => { if (ask('Reiniciar a rodada com a mesma letra? As respostas atuais serão descartadas.')) call('round:restart').catch(swallow); },
  voidRound: () => { if (ask('Anular esta rodada? Ela não contará pontos.')) call('round:void').catch(swallow); },
  endGame: () => { if (ask('Encerrar a partida e mostrar o resultado final?')) call('game:end').catch(swallow); },
  resetGame: () => call('game:reset').catch(swallow),
  // validação
  vote: (el) => call('vote', { authorId: el.dataset.a, catId: el.dataset.c, vote: el.dataset.v }).catch(swallow),
  confirmVotes: () => { if (ask('Confirmar seus votos? Depois disso não dá para alterar.')) call('votes:confirm').catch(swallow); },
  reopenVotes: () => call('votes:reopen').catch(swallow),
  decide: (el) => call('decide', { authorId: el.dataset.a, catId: el.dataset.c, status: el.dataset.s }).catch(swallow),
  correct: (el) => { const t = prompt('Corrigir a resposta:', el.dataset.t); if (t != null) call('correct', { authorId: el.dataset.a, catId: el.dataset.c, text: t }).catch(swallow); },
  finalize: () => {
    const p = S.view.round.pendingCount;
    if (!p || ask(`Ainda há ${p} resposta(s) pendente(s) de decisão. Finalizar mesmo assim?`)) call('validation:finalize').catch(swallow);
  },
  reopenRound: () => call('validation:reopen').catch(swallow),
  // ranking e som
  openRank: () => { S.ui.showRank = true; renderModal(); $('#modal button')?.focus(); },
  closeRank: () => { S.ui.showRank = false; S.ui.detail = null; renderModal(); },
  rankMode: (el) => { S.ui.rank = el.dataset.m; renderModal(); },
  roundDetail: async (el) => { S.ui.detail = await call('round:detail', { n: +el.dataset.n }).catch(() => null); renderModal(); },
  soundMenu: () => {
    S.ui.sound = !S.ui.sound; const old = $('#soundbox'); if (old) { old.remove(); return; }
    const b = document.createElement('div'); b.id = 'soundbox'; b.className = 'card';
    b.style.cssText = 'position:fixed;top:56px;right:12px;z-index:40;width:220px';
    b.innerHTML = `<label class="chk"><input type="checkbox" id="mute" ${Snd.mute ? 'checked' : ''}>Silenciar</label><label class="f"><span>Volume</span><input type="range" id="vol" min="0" max="1" step="0.05" value="${Snd.vol}"></label>`;
    document.body.append(b);
    $('#mute').onchange = (e) => { Snd.mute = e.target.checked; LS.set('mute', Snd.mute); renderTop(); };
    $('#vol').oninput = (e) => { Snd.vol = +e.target.value; LS.set('vol', Snd.vol); };
    $('#vol').onchange = () => Snd.tone(660, 0.12);
  },
};

document.addEventListener('click', (e) => {
  const sb = $('#soundbox'); if (sb && !e.target.closest('#soundbox, [data-act=soundMenu]')) sb.remove();
  if (e.target === modal) { A.closeRank(); return; }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  if (el.type === 'checkbox' && el.dataset.act === 'catToggle') return; // tratado em 'change'
  A[el.dataset.act]?.(el, e);
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-submit]'); if (!f) return;
  e.preventDefault(); A[f.dataset.submit]?.(f);
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset?.act === 'catToggle') return A.catToggle(t);
  if (t.dataset?.set) {
    const val = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value;
    setPatch(t.dataset.set, val);
  } else if (t.dataset?.catname !== undefined) {
    const l = catList(); l[+t.dataset.catname].name = t.value; saveCats(l);
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.ui.showRank) A.closeRank(); });

// ---------- conexão ----------
function banner(msg) { const b = $('#banner'); b.hidden = !msg; b.textContent = msg || ''; }

async function resume() {
  const code = S.code || LS.get('session') || (location.pathname.match(/^\/(?:s|sala)\/([A-Za-z0-9]{5})/)?.[1] || '').toUpperCase();
  if (!code) return;
  S.code = code;
  try {
    await call('room:join', { code, token, name: LS.get('name', '') }, { silent: true });
    LS.set('session', code);
    if ($('#answers')) flushAnswers();
  } catch (e) {
    if (e.code === 'NEED_NAME' || e.code === 'BAD_PASSWORD') { S.view = null; S.screen = 'join'; await loadInfo(code); render(); }
    else if (e.code === 'NO_ROOM' || e.code === 'REMOVED' || e.code === 'FULL') {
      clearSession(); goOut('home'); toast(e.message, true);
    }
  }
}

socket.on('connect', () => { S.online = true; banner(''); setSave(S.save); renderTop(); resume(); });
socket.on('disconnect', () => { S.online = false; banner('Sem conexão — tentando reconectar…'); renderTop(); setSave(S.save); });
socket.on('kicked', () => { clearSession(); goOut('home'); toast('Você foi removido da sala pelo administrador.', true); });
socket.on('state', (v) => {
  const prev = S.view;
  S.offset = v.serverNow - Date.now();
  S.view = v;
  if (!prev || prev.round?.id !== v.round?.id || prev.phase !== v.phase) {
    if (v.phase === 'playing' && (!prev || prev.round?.id !== v.round?.id)) Snd.draw();
    else if (prev && v.phase === 'validating' && prev.phase === 'playing') Snd.stop();
    else if (prev && v.phase === 'results' && prev.phase !== 'results') Snd.done();
  }
  if (prev && prev.phase !== v.phase && S.ui.showRank) S.ui.detail = null;
  render();
});

// rota inicial: /s/CODE abre direto a tela de entrada
const m = location.pathname.match(/^\/(?:s|sala)\/([A-Za-z0-9]{5})/);
if (m) { S.screen = 'join'; S.code = m[1].toUpperCase(); loadInfoWhenReady(); }
function loadInfoWhenReady() { const go = () => loadInfo(S.code).then(() => { if (!S.view) render(); }); socket.connected ? go() : socket.once('connect', go); }
render();
