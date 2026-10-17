/*
 * db.js — 保存（SQLite）
 * Node.js 22.13 以上に内蔵の node:sqlite を使うので、追加インストール不要。
 * 保存先: data/dojo.db（環境変数 DB_PATH で変更可、テストは ':memory:'）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 「実験的機能です」の警告を1行だけ抑える
const origEmit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  if (String(w && w.message || w).includes('SQLite')) return;
  return origEmit.call(process, w, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'dojo.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    rating INTEGER NOT NULL DEFAULT 1500,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY,
    tc TEXT NOT NULL,
    sente_id INTEGER, gote_id INTEGER,
    sente_name TEXT, gote_name TEXT,
    sente_rating INTEGER, gote_rating INTEGER,
    start_sfen TEXT NOT NULL,
    moves TEXT NOT NULL,
    kif TEXT NOT NULL,
    winner INTEGER, reason TEXT, rating_diff INTEGER,
    started_at INTEGER NOT NULL, ended_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_games_sente ON games(sente_id);
  CREATE INDEX IF NOT EXISTS idx_games_gote ON games(gote_id);
  CREATE INDEX IF NOT EXISTS idx_players_rating ON players(rating);
`);

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

const q = {
  byToken: db.prepare('SELECT * FROM players WHERE token_hash = ?'),
  insert: db.prepare('INSERT INTO players (token_hash, name, created_at, last_seen) VALUES (?, ?, ?, ?)'),
  touch: db.prepare('UPDATE players SET name = ?, last_seen = ? WHERE id = ?'),
  result: db.prepare('UPDATE players SET rating = ?, wins = wins + ?, losses = losses + ?, draws = draws + ? WHERE id = ?'),
  ranking: db.prepare('SELECT name, rating, wins, losses, draws FROM players WHERE wins + losses + draws > 0 ORDER BY rating DESC, wins DESC LIMIT ?'),
  maxGame: db.prepare('SELECT MAX(id) AS m FROM games'),
  saveGame: db.prepare(`INSERT INTO games (id, tc, sente_id, gote_id, sente_name, gote_name, sente_rating, gote_rating,
    start_sfen, moves, kif, winner, reason, rating_diff, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  game: db.prepare('SELECT * FROM games WHERE id = ?'),
  recent: db.prepare(`SELECT id, tc, sente_name, gote_name, winner, reason, ended_at,
    CASE WHEN sente_id = ? THEN 0 ELSE 1 END AS my_side,
    length(moves) - length(replace(moves, ' ', '')) + (moves != '') AS ply
    FROM games WHERE sente_id = ? OR gote_id = ? ORDER BY id DESC LIMIT ?`),
};

module.exports = {
  /** トークンで会員を探す。いなければ作る。 */
  loginPlayer(token, name) {
    const now = Date.now(), h = hash(token);
    let row = q.byToken.get(h);
    if (!row) { q.insert.run(h, name, now, now); row = q.byToken.get(h); }
    else q.touch.run(name, now, row.id);
    return { id: row.id, name, rating: row.rating, wins: row.wins, losses: row.losses, draws: row.draws };
  },
  /** 対局結果をまとめて保存（トランザクション） */
  saveResult(g, players, result) {
    const [ps, pg] = players;
    db.exec('BEGIN');
    try {
      const w = result.winner;
      if (ps) q.result.run(ps.rating, w === 0 ? 1 : 0, w === 1 ? 1 : 0, w === -1 ? 1 : 0, ps.id);
      if (pg) q.result.run(pg.rating, w === 1 ? 1 : 0, w === 0 ? 1 : 0, w === -1 ? 1 : 0, pg.id);
      q.saveGame.run(+g.id, g.tc, ps ? ps.id : null, pg ? pg.id : null, g.names[0], g.names[1], g.ratings[0], g.ratings[1],
        g.game.startSfen, g.game.moves.map((m) => m.usi).join(' '), g.game.moves.map((m) => m.kif).join(' '),
        w === undefined ? null : w, result.reason, result.ratingChange ? result.ratingChange[0] : 0, g.startedAt, Date.now());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); console.error('[db] 保存失敗', e); }
  },
  nextGameId() { return (q.maxGame.get().m || 0) + 1; },
  ranking(n = 20) { return q.ranking.all(n); },
  getGame(id) { return q.game.get(id) || null; },
  recentGames(playerId, n = 20) { return q.recent.all(playerId, playerId, playerId, n); },
  findPlayer(token) { return q.byToken.get(hash(token)) || null; },
  close() { db.close(); },
};
