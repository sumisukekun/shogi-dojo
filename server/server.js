/*
 * 将棋オンライン道場 v04 サーバー
 * 役割は「マッチング」「指し手の検証と中継」「対局時計」「チャット」「部屋管理」だけ。
 * AI・解析はすべてブラウザ側（サーバーの CPU/メモリを使わない）。
 */
'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const Shogi = require('../public/js/shogi-core.js');
const db = require('./db.js');

const PORT = process.env.PORT || 3000;
const app = express();

// WASM AI（マルチスレッド）に必要なヘッダー
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));
// Fairy-Stockfish（将棋対応）を /engine/ で配信（インストールされていれば）
try {
  const engineDir = path.dirname(require.resolve('fairy-stockfish-nnue.wasm/stockfish.js'));
  app.use('/engine', express.static(engineDir));
} catch (e) { console.log('[info] fairy-stockfish 未インストール → ブラウザは内蔵AIを使用'); }
app.get('/health', (req, res) => res.json({ ok: true, players: players.size, games: games.size }));
app.get('/api/ranking', (req, res) => res.json(rankingCache));
app.get('/api/games/:id', (req, res) => {
  const g = db.getGame(+req.params.id);
  if (!g) return res.status(404).json({ error: 'not_found' });
  delete g.sente_id; delete g.gote_id;
  res.json(g);
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e4 });

// ---- 持ち時間（24 と同じ4種類） ----
const TIME_CONTROLS = {
  hayasashi:  { label: '早指(1分+30秒)',   main: 60e3,   byoyomi: 30e3 },
  hayasashi2: { label: '早指2(0分+30秒)',  main: 0,      byoyomi: 30e3 },
  m15:        { label: '15分(+60秒)',      main: 15 * 60e3, byoyomi: 60e3 },
  choukou:    { label: '長考(30分+60秒)',  main: 30 * 60e3, byoyomi: 60e3 },
};
const GRACE_MS = 1000;           // 通信遅延の猶予
const DISCONNECT_LIMIT = 60e3;   // 切断後この時間で負け

// ---- 状態（対局中の情報はメモリ、会員・レーティング・棋譜は SQLite に保存） ----
const players = new Map();   // token -> { token, name, rating, socketId, gameId, seeking }
const seeks = new Map();     // tcKey -> [token,...]
const games = new Map();     // gameId -> game
let gameSeq = db.nextGameId();
let rankingCache = db.ranking();

const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

function lobbyState() {
  return {
    online: [...players.values()].filter((p) => p.socketId).length,
    seeks: Object.fromEntries([...seeks].map(([k, v]) => [k, v.length])),
    games: [...games.values()].filter((g) => !g.result).map((g) => ({
      id: g.id, tc: g.tc, sente: g.names[0], gote: g.names[1], ply: g.game.moves.length,
    })),
    timeControls: TIME_CONTROLS,
    ranking: rankingCache,
  };
}
const broadcastLobby = () => io.to('lobby').emit('lobby', lobbyState());

function gameState(g) {
  return {
    id: g.id, tc: g.tc, names: g.names, ratings: g.ratings,
    startSfen: g.game.startSfen, moves: g.game.moves.map((m) => ({ usi: m.usi, kif: m.kif })),
    clock: clockState(g), result: g.result,
  };
}
function clockState(g) {
  return { main: [...g.clock.main], byoyomi: g.clock.byoyomi, turn: g.game.pos.turn, turnStart: g.clock.turnStart, serverNow: Date.now(), running: !g.result };
}

// ---- 時計 ----
function armTimer(g) {
  clearTimeout(g.timer);
  if (g.result) return;
  const s = g.game.pos.turn;
  const limit = g.clock.main[s] + g.clock.byoyomi + GRACE_MS;
  g.timer = setTimeout(() => endGame(g, { winner: 1 - s, reason: 'timeout' }), limit);
}
function consumeTime(g, s) {
  const elapsed = Date.now() - g.clock.turnStart;
  if (elapsed <= g.clock.main[s]) { g.clock.main[s] -= elapsed; return true; }
  const over = elapsed - g.clock.main[s];
  g.clock.main[s] = 0;
  return over <= g.clock.byoyomi + GRACE_MS;
}

// ---- 対局 ----
function startGame(t1, t2, tcKey) {
  const pair = Math.random() < 0.5 ? [t1, t2] : [t2, t1];
  const [ps, pg] = pair.map((t) => players.get(t));
  const tc = TIME_CONTROLS[tcKey];
  const g = {
    id: String(gameSeq++), tc: tcKey, tokens: pair,
    names: [ps.name, pg.name], ratings: [ps.rating, pg.rating],
    game: new Shogi.Game(), result: null, timer: null, dcTimers: [null, null],
    clock: { main: [tc.main, tc.main], byoyomi: tc.byoyomi, turnStart: Date.now() },
    startedAt: Date.now(),
  };
  games.set(g.id, g);
  [ps, pg].forEach((p, i) => {
    p.gameId = g.id; p.seeking = null;
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) { sock.join('g' + g.id); sock.emit('gameStart', { ...gameState(g), you: i }); }
  });
  armTimer(g);
  broadcastLobby();
}

function endGame(g, result) {
  if (g.result) return;
  g.result = result;
  clearTimeout(g.timer);
  g.dcTimers.forEach((t) => clearTimeout(t));
  // レーティング（Elo、K=32。引き分けは 0.5）
  const [a, b] = g.tokens.map((t) => players.get(t));
  {
    if (a && b) {
      const ea = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
      const sa = result.winner === 0 ? 1 : result.winner === 1 ? 0 : 0.5;
      const d = Math.round(32 * (sa - ea));
      a.rating += d; b.rating -= d;
      result.ratingChange = [d, -d];
      [a, b].forEach((p, i) => { const w = result.winner; if (w === -1) p.draws++; else if (w === i) p.wins++; else p.losses++; });
    }
  }
  db.saveResult(g, [a, b], result);
  rankingCache = db.ranking();
  g.tokens.forEach((t) => { const p = players.get(t); if (p && p.gameId === g.id) p.gameId = null; });
  io.to('g' + g.id).emit('gameEnd', { id: g.id, result, clock: clockState(g) });
  broadcastLobby();
  setTimeout(() => games.delete(g.id), 30 * 60e3); // 観戦用に30分残す
}

function removeSeek(p) {
  if (!p.seeking) return;
  const q = seeks.get(p.seeking) || [];
  seeks.set(p.seeking, q.filter((t) => t !== p.token));
  p.seeking = null;
}

// ---- ソケット ----
const RATE = new Map(); // socketId -> [timestamps]（チャット連投対策）

io.on('connection', (socket) => {
  let me = null;
  socket.join('lobby');

  socket.on('login', (data, ack) => {
    const token = clean(data && data.token, 64) || Math.random().toString(36).slice(2) + Date.now().toString(36);
    const known = players.get(token) || db.findPlayer(token);
    const name = clean(data && data.name, 16) || (known && known.name) || 'ゲスト' + Math.floor(Math.random() * 9000 + 1000);
    const row = db.loginPlayer(token, name);
    me = players.get(token);
    if (!me) { me = { token, ...row, socketId: null, gameId: null, seeking: null }; players.set(token, me); }
    me.name = name;
    me.socketId = socket.id;
    const res = {
      token, name: me.name, rating: me.rating, wins: me.wins, losses: me.losses, draws: me.draws,
      recent: db.recentGames(me.id, 10), lobby: lobbyState(),
    };
    // 対局中の再接続
    if (me.gameId && games.has(me.gameId)) {
      const g = games.get(me.gameId);
      const i = g.tokens.indexOf(token);
      clearTimeout(g.dcTimers[i]); g.dcTimers[i] = null;
      socket.join('g' + g.id);
      res.resume = { ...gameState(g), you: i };
      socket.to('g' + g.id).emit('opponentStatus', { connected: true });
    }
    if (typeof ack === 'function') ack(res);
    broadcastLobby();
  });

  socket.on('seek', (data) => {
    if (!me || me.gameId) return;
    const tc = data && TIME_CONTROLS[data.tc] ? data.tc : 'hayasashi';
    removeSeek(me);
    const q = (seeks.get(tc) || []).filter((t) => players.get(t) && players.get(t).socketId);
    const opp = q.find((t) => t !== me.token);
    if (opp) {
      seeks.set(tc, q.filter((t) => t !== opp));
      players.get(opp).seeking = null;
      startGame(opp, me.token, tc);
    } else {
      q.push(me.token); seeks.set(tc, q); me.seeking = tc;
      socket.emit('seeking', { tc });
      broadcastLobby();
    }
  });

  socket.on('cancelSeek', () => { if (me) { removeSeek(me); broadcastLobby(); } });

  socket.on('move', (data, ack) => {
    const reply = (r) => typeof ack === 'function' && ack(r);
    if (!me || !data) return reply({ ok: false, error: 'not_logged_in' });
    const g = games.get(String(data.gameId));
    if (!g || g.result) return reply({ ok: false, error: 'no_game' });
    const s = g.tokens.indexOf(me.token);
    if (s < 0 || g.game.pos.turn !== s) return reply({ ok: false, error: 'not_your_turn' });
    if (!consumeTime(g, s)) { endGame(g, { winner: 1 - s, reason: 'timeout' }); return reply({ ok: false, error: 'timeout' }); }
    const rec = g.game.play(String(data.usi || ''));
    if (!rec) return reply({ ok: false, error: 'illegal' });
    g.clock.turnStart = Date.now();
    io.to('g' + g.id).emit('move', { id: g.id, usi: rec.usi, kif: rec.kif, ply: g.game.moves.length, clock: clockState(g) });
    reply({ ok: true });
    if (g.game.result) endGame(g, g.game.result);
    else armTimer(g);
  });

  socket.on('resign', (data) => {
    if (!me) return;
    const g = games.get(String(data && data.gameId));
    if (!g || g.result) return;
    const s = g.tokens.indexOf(me.token);
    if (s >= 0) endGame(g, { winner: 1 - s, reason: 'resign' });
  });

  socket.on('watch', (data, ack) => {
    const g = games.get(String(data && data.gameId));
    if (!g) return typeof ack === 'function' && ack(null);
    socket.join('g' + g.id);
    if (typeof ack === 'function') ack({ ...gameState(g), you: -1 });
  });
  socket.on('unwatch', (data) => socket.leave('g' + String(data && data.gameId)));

  socket.on('chat', (data) => {
    if (!me || !data) return;
    const text = clean(data.text, 200);
    if (!text) return;
    const now = Date.now();
    const hist = (RATE.get(socket.id) || []).filter((t) => now - t < 10e3);
    if (hist.length >= 5) return socket.emit('chat', { room: data.room, name: 'システム', text: '発言が速すぎます。少し待ってください。', system: true });
    hist.push(now); RATE.set(socket.id, hist);
    const room = data.room === 'lobby' ? 'lobby' : 'g' + String(data.room);
    if (room !== 'lobby' && !socket.rooms.has(room)) return;
    io.to(room).emit('chat', { room: data.room, name: me.name, text, time: now });
  });

  socket.on('disconnect', () => {
    RATE.delete(socket.id);
    if (!me || me.socketId !== socket.id) return;
    me.socketId = null;
    removeSeek(me);
    if (me.gameId && games.has(me.gameId)) {
      const g = games.get(me.gameId), i = g.tokens.indexOf(me.token);
      socket.to('g' + g.id).emit('opponentStatus', { connected: false, limit: DISCONNECT_LIMIT });
      g.dcTimers[i] = setTimeout(() => endGame(g, { winner: 1 - i, reason: 'disconnect' }), DISCONNECT_LIMIT);
    }
    broadcastLobby();
  });
});

function shutdown() {
  io.close();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (require.main === module) {
  server.listen(PORT, () => console.log(`将棋オンライン道場 v04 起動: http://localhost:${PORT}`));
}
module.exports = { server, io, TIME_CONTROLS };
