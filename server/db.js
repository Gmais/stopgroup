// Persistência em SQLite (módulo nativo node:sqlite, sem dependências extras).
// - rooms: snapshot completo de cada sala (usado para restaurar após reinício)
// - players/rounds/answers/votes/scores: espelho relacional, gravado a cada rodada finalizada
// - category_sets: conjuntos de categorias favoritos (por dono)
// - history/history_players: histórico de partidas encerradas
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, name TEXT, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS players (room_code TEXT, id TEXT, name TEXT, removed INTEGER, joined_at INTEGER, PRIMARY KEY (room_code, id));
    CREATE TABLE IF NOT EXISTS rounds (id TEXT PRIMARY KEY, room_code TEXT, n INTEGER, letter TEXT, categories TEXT, started_at INTEGER, ended_at INTEGER, end_reason TEXT, stopped_by TEXT);
    CREATE TABLE IF NOT EXISTS answers (round_id TEXT, player_id TEXT, category_id TEXT, category TEXT, raw TEXT, text TEXT, status TEXT, source TEXT, points INTEGER, reason TEXT, PRIMARY KEY (round_id, player_id, category_id));
    CREATE TABLE IF NOT EXISTS votes (round_id TEXT, voter_id TEXT, author_id TEXT, category_id TEXT, vote TEXT, PRIMARY KEY (round_id, voter_id, author_id, category_id));
    CREATE TABLE IF NOT EXISTS scores (round_id TEXT, player_id TEXT, points INTEGER, PRIMARY KEY (round_id, player_id));
    CREATE TABLE IF NOT EXISTS category_sets (owner TEXT, name TEXT, data TEXT NOT NULL, PRIMARY KEY (owner, name));
    CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, room_code TEXT, name TEXT, finished_at INTEGER, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS history_players (history_id INTEGER, token_hash TEXT);
    CREATE INDEX IF NOT EXISTS idx_hp_token ON history_players (token_hash);
  `);

  const q = {
    saveRoom: db.prepare('INSERT INTO rooms (code, name, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET name=excluded.name, data=excluded.data, updated_at=excluded.updated_at'),
    allRooms: db.prepare('SELECT data FROM rooms'),
    delRoom: db.prepare('DELETE FROM rooms WHERE code = ?'),
    upPlayer: db.prepare('INSERT OR REPLACE INTO players VALUES (?, ?, ?, ?, ?)'),
    upRound: db.prepare('INSERT OR REPLACE INTO rounds VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    delAnswers: db.prepare('DELETE FROM answers WHERE round_id = ?'),
    delVotes: db.prepare('DELETE FROM votes WHERE round_id = ?'),
    delScores: db.prepare('DELETE FROM scores WHERE round_id = ?'),
    delRound: db.prepare('DELETE FROM rounds WHERE id = ?'),
    insAnswer: db.prepare('INSERT OR REPLACE INTO answers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    insVote: db.prepare('INSERT OR REPLACE INTO votes VALUES (?, ?, ?, ?, ?)'),
    insScore: db.prepare('INSERT OR REPLACE INTO scores VALUES (?, ?, ?)'),
    delRoomRel: [
      'DELETE FROM answers WHERE round_id IN (SELECT id FROM rounds WHERE room_code = ?)',
      'DELETE FROM votes WHERE round_id IN (SELECT id FROM rounds WHERE room_code = ?)',
      'DELETE FROM scores WHERE round_id IN (SELECT id FROM rounds WHERE room_code = ?)',
      'DELETE FROM rounds WHERE room_code = ?',
      'DELETE FROM players WHERE room_code = ?',
    ].map((s) => db.prepare(s)),
    listSets: db.prepare('SELECT name, data FROM category_sets WHERE owner = ? ORDER BY name'),
    saveSet: db.prepare('INSERT OR REPLACE INTO category_sets VALUES (?, ?, ?)'),
    delSet: db.prepare('DELETE FROM category_sets WHERE owner = ? AND name = ?'),
    countSets: db.prepare('SELECT COUNT(*) AS n FROM category_sets WHERE owner = ?'),
    addHistory: db.prepare('INSERT INTO history (room_code, name, finished_at, data) VALUES (?, ?, ?, ?)'),
    addHistoryPlayer: db.prepare('INSERT INTO history_players VALUES (?, ?)'),
    listHistory: db.prepare('SELECT h.id, h.room_code, h.name, h.finished_at, h.data FROM history h JOIN history_players hp ON hp.history_id = h.id WHERE hp.token_hash = ? ORDER BY h.finished_at DESC LIMIT 30'),
  };

  const tx = (fn) => {
    db.exec('BEGIN');
    try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  return {
    raw: db,
    saveRoom(code, name, json) { q.saveRoom.run(code, name, json, Date.now()); },
    loadRooms() { return q.allRooms.all().map((r) => r.data); },
    deleteRoom(code) { tx(() => { q.delRoom.run(code); q.delRoomRel.forEach((s) => s.run(code)); }); },

    /** Espelho relacional de uma rodada (idempotente: apaga e regrava). */
    recordRound(room, round) {
      tx(() => {
        for (const p of Object.values(room.players)) q.upPlayer.run(room.code, p.id, p.name, p.removed ? 1 : 0, p.joinedAt);
        q.delAnswers.run(round.id); q.delVotes.run(round.id); q.delScores.run(round.id);
        if (round.voided || !round.final || !round.result) { q.delRound.run(round.id); return; }
        q.upRound.run(round.id, room.code, round.n, round.letter, JSON.stringify(round.categories), round.startedAt, round.endedAt ?? null, round.endReason ?? null, round.stoppedBy ?? null);
        const catName = Object.fromEntries(round.categories.map((c) => [c.id, c.name]));
        for (const it of Object.values(round.result.items)) {
          q.insAnswer.run(round.id, it.pid, it.catId, catName[it.catId] ?? '', it.raw, it.text, it.status, it.source, it.points, it.reason);
        }
        for (const [k, v] of Object.entries(round.votes)) {
          const [voter, author, cat] = k.split('|');
          q.insVote.run(round.id, voter, author, cat, v);
        }
        for (const [pid, pp] of Object.entries(round.result.perPlayer)) q.insScore.run(round.id, pid, pp.total);
      });
    },

    listSets(owner) { return q.listSets.all(owner).map((r) => ({ name: r.name, categories: JSON.parse(r.data) })); },
    saveSet(owner, name, cats) {
      if (q.countSets.get(owner).n >= 30) {
        const exists = q.listSets.all(owner).some((r) => r.name === name);
        if (!exists) throw new Error('Limite de 30 conjuntos favoritos atingido.');
      }
      q.saveSet.run(owner, name, JSON.stringify(cats));
    },
    deleteSet(owner, name) { q.delSet.run(owner, name); },

    addHistory(room, summary, tokenHashes) {
      tx(() => {
        const r = q.addHistory.run(room.code, room.name, Date.now(), JSON.stringify(summary));
        const id = Number(r.lastInsertRowid);
        for (const t of tokenHashes) q.addHistoryPlayer.run(id, t);
      });
    },
    listHistory(tokenHash) {
      return q.listHistory.all(tokenHash).map((r) => ({ id: r.id, code: r.room_code, name: r.name, finishedAt: r.finished_at, ...JSON.parse(r.data) }));
    },
    close() { db.close(); },
  };
}
