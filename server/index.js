// Transporte: Express (estáticos) + Socket.IO (tempo real). Toda regra vive em game.js.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { openDb } from './db.js';
import { GameManager, GameError } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Rate limit simples por chave (janela deslizante). */
function makeLimiter(max, windowMs) {
  const hits = new Map();
  const t = setInterval(() => { const c = Date.now() - windowMs; for (const [k, a] of hits) if (!a.some((x) => x > c)) hits.delete(k); }, windowMs);
  t.unref?.();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((x) => x > now - windowMs);
    arr.push(now); hits.set(key, arr);
    return arr.length <= max;
  };
}

export function createServer({ dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'stop.db'), manager: mopts = {} } = {}) {
  const db = openDb(dbFile);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY ? 1 : false);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, { maxAge: '5m' }));
  app.get('/health', (_req, res) => res.json({ ok: true, rooms: manager.rooms.size }));
  app.get(['/s/:code', '/sala/:code'], (_req, res) => res.sendFile(path.join(pub, 'index.html')));

  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 64 * 1024, pingInterval: 10000, pingTimeout: 8000, serveClient: true });

  // ---- difusão de estado: cada jogador recebe somente a sua visão ----
  const softTimers = new Map();
  function sendState(room) {
    for (const [pid, sids] of room.rt.sockets) {
      const view = manager.view(room, pid);
      for (const sid of sids) io.to(sid).emit('state', view);
    }
  }
  function broadcast(room, soft) {
    if (!soft) { clearTimeout(softTimers.get(room.code)); softTimers.delete(room.code); return sendState(room); }
    if (softTimers.has(room.code)) return; // respostas digitadas: no máx. ~3 envios/s por sala
    softTimers.set(room.code, setTimeout(() => { softTimers.delete(room.code); sendState(room); }, 350));
  }

  const manager = new GameManager(db, {
    notify: broadcast,
    onKick: (room, pid) => {
      for (const sid of room.rt.sockets.get(pid) || []) {
        io.to(sid).emit('kicked');
        const s = io.sockets.sockets.get(sid);
        if (s) { s.data = {}; s.leave(room.code); }
      }
      room.rt.sockets.delete(pid);
    },
    ...mopts,
  });
  manager.restoreAll();

  const createLimit = makeLimiter(20, 3600e3);
  const joinLimit = makeLimiter(40, 60e3);

  io.on('connection', (socket) => {
    const ip = socket.handshake.address;
    socket.data = {};
    // proteção contra abuso: balde de fichas por conexão
    let tokens = 80, last = Date.now(), strikes = 0;
    const allow = () => {
      const now = Date.now();
      tokens = Math.min(80, tokens + ((now - last) / 1000) * 40); last = now;
      if (tokens < 1) { if (++strikes > 50) socket.disconnect(true); return false; }
      tokens -= 1; return true;
    };

    const ctx = () => {
      const { code, pid } = socket.data;
      if (!code) throw new GameError('Você não está em uma sala.', 'NO_SESSION');
      const room = manager.rooms.get(code);
      const player = room?.players[pid];
      if (!room || !player || player.removed) throw new GameError('Sessão expirada.', 'NO_SESSION');
      return { room, player };
    };

    const enter = (room, player) => {
      if (socket.data.code && socket.data.code !== room.code) leave();
      socket.data = { code: room.code, pid: player.id };
      socket.join(room.code);
      manager.attach(room, player.id, socket.id);
      socket.emit('state', manager.view(room, player.id));
    };
    const leave = () => {
      const { code, pid } = socket.data;
      if (!code) return;
      const room = manager.rooms.get(code);
      socket.leave(code);
      socket.data = {};
      if (room) manager.detach(room, pid, socket.id);
    };

    // handlers públicos (sem sessão)
    const open = {
      'room:info': ({ code }) => manager.info(code),
      'room:create': (p) => {
        if (!createLimit(ip)) throw new GameError('Muitas salas criadas. Tente novamente mais tarde.');
        const { room, player } = manager.createRoom(p || {});
        enter(room, player);
        return { code: room.code };
      },
      'room:join': (p) => {
        if (!joinLimit(ip)) throw new GameError('Muitas tentativas. Aguarde um minuto.');
        const { room, player } = manager.join(p || {});
        enter(room, player);
        return { code: room.code };
      },
      'room:leave': () => { leave(); return {}; },
      'sets:list': ({ token }) => db.listSets(manager.checkToken(token)),
      'sets:save': ({ token, name, categories }) => {
        const owner = manager.checkToken(token);
        const n = String(name || '').trim().slice(0, 40);
        const cats = manager.categoriesFrom(categories);
        if (!n || !cats?.length) throw new GameError('Informe um nome e ao menos uma categoria.');
        db.saveSet(owner, n, cats.map(({ name: nm, active }) => ({ name: nm, active })));
        return db.listSets(owner);
      },
      'sets:delete': ({ token, name }) => { const owner = manager.checkToken(token); db.deleteSet(owner, String(name)); return db.listSets(owner); },
      'history:list': ({ token }) => db.listHistory(manager.checkToken(token)),
    };

    // handlers de sala (exigem sessão; permissões validadas no servidor)
    const inRoom = {
      'settings': (p) => { const c = ctx(); manager.setSettings(c.room, c.player, p); return {}; },
      'round:start': () => { const c = ctx(); manager.startRound(c.room, c.player); return {}; },
      'answer': (p) => { const c = ctx(); return manager.answer(c.room, c.player, p || {}); },
      'answers': (p) => { const c = ctx(); return manager.syncAnswers(c.room, c.player, p || {}); },
      'confirm': (p) => { const c = ctx(); manager.confirm(c.room, c.player, p || {}); return {}; },
      'stop': (p) => { const c = ctx(); manager.stop(c.room, c.player, p || {}); return {}; },
      'round:end': () => { const c = ctx(); manager.adminEndRound(c.room, c.player); return {}; },
      'game:pause': () => { const c = ctx(); manager.pause(c.room, c.player); return {}; },
      'game:resume': () => { const c = ctx(); manager.resume(c.room, c.player); return {}; },
      'vote': (p) => { const c = ctx(); manager.vote(c.room, c.player, p || {}); return {}; },
      'votes:confirm': () => { const c = ctx(); manager.confirmVotes(c.room, c.player); return {}; },
      'votes:reopen': (p) => { const c = ctx(); manager.reopenVotes(c.room, c.player, p || {}); return {}; },
      'decide': (p) => { const c = ctx(); manager.decide(c.room, c.player, p || {}); return {}; },
      'correct': (p) => { const c = ctx(); manager.correct(c.room, c.player, p || {}); return {}; },
      'validation:finalize': () => { const c = ctx(); manager.finalize(c.room, c.player); return {}; },
      'validation:reopen': () => { const c = ctx(); manager.reopenRound(c.room, c.player); return {}; },
      'round:void': () => { const c = ctx(); manager.voidRound(c.room, c.player); return {}; },
      'round:restart': () => { const c = ctx(); manager.voidRound(c.room, c.player, { restart: true }); return {}; },
      'round:detail': ({ n }) => { const c = ctx(); return manager.roundDetail(c.room, Number(n)); },
      'game:end': () => { const c = ctx(); manager.endGame(c.room, c.player); return {}; },
      'game:reset': () => { const c = ctx(); manager.resetGame(c.room, c.player); return {}; },
      'player:kick': (p) => { const c = ctx(); manager.kick(c.room, c.player, p || {}); return {}; },
      'admin:transfer': (p) => { const c = ctx(); manager.transferAdmin(c.room, c.player, p || {}); return {}; },
      'admin:claim': () => { const c = ctx(); manager.claimAdmin(c.room, c.player); return {}; },
    };

    socket.on('call', async (name, payload, ack) => {
      if (typeof ack !== 'function') return;
      if (!allow()) return ack({ ok: false, error: 'Muitas requisições. Vá com calma.' });
      try {
        const fn = open[name] || inRoom[name];
        if (!fn) throw new GameError('Ação desconhecida.');
        if (payload != null && (typeof payload !== 'object' || Array.isArray(payload))) throw new GameError('Requisição inválida.');
        ack({ ok: true, data: await fn(payload || {}) });
      } catch (e) {
        if (!(e instanceof GameError)) console.error(e);
        ack({ ok: false, error: e instanceof GameError ? e.message : 'Erro interno.', code: e.code });
      }
    });

    socket.on('disconnect', () => leave());
  });

  return {
    app, server, io, manager, db,
    listen: (port, host) => new Promise((res) => server.listen(port, host, () => res(server.address().port))),
    close: () => new Promise((res) => {
      manager.shutdown();
      io.close(() => { try { db.close(); } catch { /* noop */ } res(); });
    }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const srv = createServer();
  const port = Number(process.env.PORT) || 3000;
  srv.listen(port, process.env.HOST || '0.0.0.0').then((p) => console.log(`Stop Online rodando em http://localhost:${p}`));
  const bye = () => srv.close().then(() => process.exit(0));
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
