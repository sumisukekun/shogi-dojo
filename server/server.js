/*
 * 将棋オンライン道場 v05 サーバー
 * 役割は「マッチング」「指し手の検証と中継」「対局時計」「チャット」「部屋管理」「保存」だけ。
 * AI・解析はすべてブラウザ側（サーバーの CPU/メモリを使わない）。
 */
'use strict';
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const Shogi = require('../public/js/shogi-core.js');
const db = require('./db.js');

const VERSION = '0.5.0';
const PORT = process.env.PORT || 3000;
const app = express();
app.disable('x-powered-by');

// セキュリティ・WASM（マルチスレッドAI）に必要なヘッダー
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
    "worker-src 'self' blob:",
    "connect-src 'self' ws: wss:",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
try {
  const engineDir = path.dirname(require.resolve('fairy-stockfish-nnue.wasm/stockfish.js'));
  app.use('/engine', express.static(engineDir, { maxAge: '7d' }));
} catch (e) { console.log('[info] fairy-stockfish 未インストール → ブラウザは内蔵AIを使用'); }

app.get('/health', (req, res) => res.json({ ok: true, version: VERSION, players: [...players.values()].filter((p) => p.socketId).length, games: [...games.values()].filter((g) => !g.result).length, mem: Math.round(process.memoryUsage().rss / 1e6) }));
app.get('/api/ranking', (req, res) => res.json(rankingCache));
app.get('/api/games/:id', (req, res) => {
  const g = db.getGame(+req.params.id);
  if (!g) return res.status(404).json({ error: 'not_found' });
  delete g.sente_id; delete g.gote_id;
  res.json(g);
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e4, pingInterval: 10000, pingTimeout: 8000 });

// ---- 持ち時間 ----
// main: 持ち時間, byoyomi: 秒読み, inc: 1手ごとの加算（フィッシャー）
const TIME_CONTROLS = {
  kire3:      { label: '3分切れ負け',            main: 3 * 60e3,  byoyomi: 0,     inc: 0 },
  fischer5:   { label: '5分＋1手5秒（加算）',     main: 5 * 60e3,  byoyomi: 0,     inc: 5e3 },
  kire10:     { label: '10分切れ負け',           main: 10 * 60e3, byoyomi: 0,     inc: 0 },
  m10b30:     { label: '10分＋秒読み30秒',       main: 10 * 60e3, byoyomi: 30e3,  inc: 0 },
  hayasashi2: { label: '早指し（秒読み30秒）',    main: 0,         byoyomi: 30e3,  inc: 0 },
  m15b60:     { label: '15分＋秒読み60秒',       main: 15 * 60e3, byoyomi: 60e3,  inc: 0 },
  m30b60:     { label: '長考（30分＋秒読み60秒）', main: 30 * 60e3, byoyomi: 60e3,  inc: 0 },
};
const DEFAULT_TC = 'm10b30';
const GRACE_MS = 1000;            // 通信遅延の猶予
const DISCONNECT_LIMIT = 60e3;    // 切断後この時間で負け
const RESTORE_LIMIT = 180e3;      // サーバー再起動後、戻ってくるまでの猶予
const REMATCH_WINDOW = 60e3;      // 再対局の申し込み受付時間

// ---- 状態 ----
const players = new Map();  // token -> player
const seeks = new Map();    // token -> { token, tc, rated, rating, since }
const privates = new Map(); // code -> { token, tc, created }
const games = new Map();    // gameId -> game
let gameSeq = db.nextGameId();
let rankingCache = db.ranking();

const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const newToken = () => crypto.randomBytes(18).toString('base64url');
const isToken = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(t);

function playerFromRow(token, row) {
  return {
    token, id: row.id, name: row.name, rating: row.rating, wins: row.wins, losses: row.losses, draws: row.draws,
    streak: row.streak || 0, bestStreak: row.bestStreak || row.best_streak || 0,
    socketId: null, gameId: null,
  };
}
function getPlayer(token) {
  let p = players.get(token);
  if (!p) {
    const row = db.findPlayer(token);
    if (!row) return null;
    p = playerFromRow(token, row);
    players.set(token, p);
  }
  return p;
}
const socketOf = (p) => p && p.socketId && io.sockets.sockets.get(p.socketId);

function lobbyState() {
  const seekCounts = {};
  for (const s of seeks.values()) seekCounts[s.tc] = (seekCounts[s.tc] || 0) + 1;
  return {
    online: [...players.values()].filter((p) => p.socketId).length,
    seeks: seekCounts,
    games: [...games.values()].filter((g) => !g.result).map((g) => ({
      id: g.id, tc: g.tc, rated: g.rated, sente: g.names[0], gote: g.names[1], ratings: g.ratings, ply: g.game.moves.length,
    })),
    timeControls: TIME_CONTROLS,
    ranking: rankingCache,
    version: VERSION,
  };
}
let lobbyTimer = null;
function broadcastLobby() { // 連続した更新は100msにまとめる
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(() => { lobbyTimer = null; io.to('lobby').emit('lobby', lobbyState()); }, 100);
}

function gameState(g) {
  return {
    id: g.id, tc: g.tc, rated: g.rated, names: g.names, ratings: g.ratings,
    startSfen: g.game.startSfen, moves: g.game.moves.map((m) => ({ usi: m.usi, kif: m.kif })),
    clock: clockState(g), result: g.result,
  };
}
function clockState(g) {
  return { main: [...g.clock.main], byoyomi: g.clock.byoyomi, inc: g.clock.inc, turn: g.game.pos.turn, turnStart: g.clock.turnStart, serverNow: Date.now(), running: !g.result };
}

// ---- 時計 ----
function armTimer(g) {
  clearTimeout(g.timer);
  if (g.result) return;
  const s = g.game.pos.turn;
  const left = g.clock.main[s] + g.clock.byoyomi + GRACE_MS - (Date.now() - g.clock.turnStart);
  g.timer = setTimeout(() => endGame(g, { winner: 1 - s, reason: 'timeout' }), Math.max(0, left));
}
function consumeTime(g, s) {
  const elapsed = Date.now() - g.clock.turnStart;
  if (elapsed <= g.clock.main[s]) { g.clock.main[s] -= elapsed; return true; }
  const over = elapsed - g.clock.main[s];
  g.clock.main[s] = 0;
  return over <= g.clock.byoyomi + GRACE_MS;
}

// ---- 対局 ----
function persistLive(g) {
  if (g.result) return;
  db.saveLive(g.id, {
    id: g.id, tc: g.tc, rated: g.rated, tokens: g.tokens, names: g.names, ratings: g.ratings,
    startSfen: g.game.startSfen, moves: g.game.moves.map((m) => m.usi),
    clock: { main: g.clock.main, byoyomi: g.clock.byoyomi, inc: g.clock.inc }, startedAt: g.startedAt,
  });
}

function makeGame(id, tcKey, tokens, opts = {}) {
  const tc = TIME_CONTROLS[tcKey] || TIME_CONTROLS[DEFAULT_TC];
  const [ps, pg] = tokens.map(getPlayer);
  return {
    id: String(id), tc: tcKey, rated: opts.rated !== false, tokens,
    names: opts.names || [ps.name, pg.name], ratings: opts.ratings || [ps.rating, pg.rating],
    game: new Shogi.Game(opts.startSfen), result: null, timer: null, dcTimers: [null, null],
    clock: { main: opts.main ? [...opts.main] : [tc.main, tc.main], byoyomi: tc.byoyomi, inc: tc.inc || 0, turnStart: Date.now() },
    startedAt: opts.startedAt || Date.now(), rematch: new Set(), endedAt: 0,
  };
}

function startGame(t1, t2, tcKey, { rated = true, fixedColors = false } = {}) {
  const pair = fixedColors || Math.random() < 0.5 ? [t1, t2] : [t2, t1];
  const g = makeGame(gameSeq++, tcKey, pair, { rated });
  games.set(g.id, g);
  pair.forEach((t, i) => {
    const p = getPlayer(t);
    p.gameId = g.id;
    seeks.delete(t);
    for (const [code, pv] of privates) if (pv.token === t) privates.delete(code);
    const sock = socketOf(p);
    if (sock) { sock.join('g' + g.id); sock.emit('gameStart', { ...gameState(g), you: i }); }
  });
  persistLive(g);
  armTimer(g);
  broadcastLobby();
  return g;
}

function endGame(g, result) {
  if (g.result) return;
  g.result = result;
  g.endedAt = Date.now();
  clearTimeout(g.timer);
  g.dcTimers.forEach((t) => clearTimeout(t));
  const [a, b] = g.tokens.map(getPlayer);
  if (g.rated && a && b && result.winner !== undefined) {
    // Elo。対局数が少ないうちは変動を大きく（早く実力に近づける）
    const k = (p) => (p.wins + p.losses + p.draws < 20 ? 40 : 24);
    const ea = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
    const sa = result.winner === 0 ? 1 : result.winner === 1 ? 0 : 0.5;
    const da = Math.round(k(a) * (sa - ea)), dbb = Math.round(k(b) * ((1 - sa) - (1 - ea)));
    a.rating += da; b.rating += dbb;
    result.ratingChange = [da, dbb];
    [a, b].forEach((p, i) => {
      const w = result.winner;
      if (w === -1) { p.draws++; }
      else if (w === i) { p.wins++; p.streak = Math.max(0, p.streak) + 1; p.bestStreak = Math.max(p.bestStreak, p.streak); }
      else { p.losses++; p.streak = 0; }
    });
  }
  db.saveResult(g, [a, b], result);
  rankingCache = db.ranking();
  g.tokens.forEach((t) => { const p = players.get(t); if (p && p.gameId === g.id) p.gameId = null; });
  io.to('g' + g.id).emit('gameEnd', { id: g.id, result, clock: clockState(g), rated: g.rated });
  broadcastLobby();
  setTimeout(() => games.delete(g.id), 30 * 60e3); // 観戦・再対局用に30分残す
}

// ---- マッチング（棋力の近い相手を優先。待つほど範囲を広げる） ----
function windowOf(s, now) { return Math.min(150 + 25 * ((now - s.since) / 1000), 2000); }
function runMatcher() {
  const now = Date.now();
  const list = [...seeks.values()].filter((s) => { const p = players.get(s.token); return p && p.socketId && !p.gameId; });
  const used = new Set();
  list.sort((x, y) => x.since - y.since);
  for (const a of list) {
    if (used.has(a.token)) continue;
    let best = null, bestDiff = Infinity;
    for (const b of list) {
      if (b === a || used.has(b.token) || b.tc !== a.tc || b.rated !== a.rated) continue;
      const diff = Math.abs(a.rating - b.rating);
      if (diff <= Math.max(windowOf(a, now), windowOf(b, now)) && diff < bestDiff) { best = b; bestDiff = diff; }
    }
    if (best) {
      used.add(a.token); used.add(best.token);
      startGame(a.token, best.token, a.tc, { rated: a.rated });
    }
  }
}
setInterval(runMatcher, 1000).unref();

function clearWaiting(p) {
  if (!p) return;
  seeks.delete(p.token);
  for (const [code, pv] of privates) if (pv.token === p.token) privates.delete(code);
}

// ---- 起動時：再起動前に進行中だった対局を復元 ----
function restoreLiveGames() {
  let n = 0;
  for (const d of db.loadLive()) {
    try {
      if (!d.tokens.every(getPlayer)) { db.deleteLive(d.id); continue; }
      const g = makeGame(d.id, d.tc, d.tokens, { rated: d.rated, names: d.names, ratings: d.ratings, startSfen: d.startSfen, main: d.clock.main, startedAt: d.startedAt });
      for (const u of d.moves) if (!g.game.play(u)) throw new Error('bad move ' + u);
      g.clock.turnStart = Date.now(); // 停止中の時間は消費しない
      games.set(g.id, g);
      d.tokens.forEach((t, i) => {
        getPlayer(t).gameId = g.id;
        g.dcTimers[i] = setTimeout(() => endGame(g, { winner: 1 - i, reason: 'disconnect' }), RESTORE_LIMIT);
      });
      armTimer(g);
      n++;
    } catch (e) { console.error('[restore] 失敗', d && d.id, e.message); db.deleteLive(d.id); }
  }
  if (n) console.log(`[restore] 進行中の対局を ${n} 局復元しました`);
}
restoreLiveGames();

// ---- ソケット ----
const reply = (ack, r) => typeof ack === 'function' && ack(r);

io.on('connection', (socket) => {
  let me = null;
  socket.join('lobby');

  // 連打・荒らし対策：10秒間に80イベントを超えたら無視
  let evCount = 0, evStart = Date.now();
  socket.use((packet, next) => {
    const now = Date.now();
    if (now - evStart > 10e3) { evStart = now; evCount = 0; }
    if (++evCount > 80) return; // 黙って捨てる
    next();
  });

  socket.on('login', (data, ack) => {
    data = data || {};
    let token = isToken(data.token) ? data.token : null;
    let p = token ? getPlayer(token) : null;
    if (data.transfer && !p) return reply(ack, { error: 'transfer_not_found' });
    if (!token) token = newToken();
    // 名前：他人が使っている名前は使えない
    let name = clean(data.name, 16);
    let nameError = null;
    if (name) {
      const owner = db.nameOwner(name);
      if (owner && (!p || owner !== p.id)) { nameError = 'taken'; name = ''; }
      if (/^(システム|運営|管理者|admin)/i.test(name)) { nameError = 'reserved'; name = ''; }
    }
    if (!name) name = p ? p.name : '';
    for (let i = 0; !name && i < 20; i++) {
      const cand = 'ゲスト' + Math.floor(Math.random() * 90000 + 10000);
      if (!db.nameOwner(cand)) name = cand;
    }
    const row = db.loginPlayer(token, name);
    if (!p) { p = playerFromRow(token, { ...row, name }); players.set(token, p); }
    p.name = name;
    const prev = socketOf(p);
    if (prev && prev.id !== socket.id) prev.emit('kicked', { reason: 'other_login' });
    p.socketId = socket.id;
    me = p;
    const res = {
      token, name: p.name, nameError, rating: p.rating, wins: p.wins, losses: p.losses, draws: p.draws,
      streak: p.streak, bestStreak: p.bestStreak,
      recent: db.recentGames(p.id, 15), history: db.ratingHistory(p.id, 100), lobby: lobbyState(),
    };
    if (p.gameId && games.has(p.gameId)) {
      const g = games.get(p.gameId);
      const i = g.tokens.indexOf(token);
      clearTimeout(g.dcTimers[i]); g.dcTimers[i] = null;
      socket.join('g' + g.id);
      res.resume = { ...gameState(g), you: i };
      socket.to('g' + g.id).emit('opponentStatus', { connected: true });
    }
    reply(ack, res);
    broadcastLobby();
  });

  socket.on('seek', (data) => {
    if (!me || me.gameId) return;
    const tc = data && TIME_CONTROLS[data.tc] ? data.tc : DEFAULT_TC;
    clearWaiting(me);
    seeks.set(me.token, { token: me.token, tc, rated: !(data && data.rated === false), rating: me.rating, since: Date.now() });
    socket.emit('seeking', { tc });
    runMatcher();
    broadcastLobby();
  });

  socket.on('cancelSeek', () => { if (me) { clearWaiting(me); broadcastLobby(); } });

  // 合言葉対局（友達と指す）。レーティングは変動しない
  socket.on('createPrivate', (data, ack) => {
    if (!me || me.gameId) return reply(ack, { error: 'busy' });
    clearWaiting(me);
    const tc = data && TIME_CONTROLS[data.tc] ? data.tc : DEFAULT_TC;
    let code;
    do { code = String(crypto.randomInt(100000, 1000000)); } while (privates.has(code));
    privates.set(code, { token: me.token, tc, created: Date.now() });
    reply(ack, { code, tc });
  });
  socket.on('joinPrivate', (data, ack) => {
    if (!me || me.gameId) return reply(ack, { error: 'busy' });
    const code = clean(data && data.code, 6);
    const pv = privates.get(code);
    if (!pv || Date.now() - pv.created > 30 * 60e3) return reply(ack, { error: 'not_found' });
    if (pv.token === me.token) return reply(ack, { error: 'self' });
    const host = getPlayer(pv.token);
    if (!host || !host.socketId || host.gameId) { privates.delete(code); return reply(ack, { error: 'not_found' }); }
    privates.delete(code);
    clearWaiting(me);
    startGame(pv.token, me.token, pv.tc, { rated: false });
    reply(ack, { ok: true });
  });

  socket.on('move', (data, ack) => {
    if (!me || !data) return reply(ack, { ok: false, error: 'not_logged_in' });
    const g = games.get(String(data.gameId));
    if (!g || g.result) return reply(ack, { ok: false, error: 'no_game' });
    const s = g.tokens.indexOf(me.token);
    if (s < 0 || g.game.pos.turn !== s) return reply(ack, { ok: false, error: 'not_your_turn' });
    // 二重送信・古い画面からの着手を防ぐ（何手目に対する指し手か）
    if (data.ply !== undefined && +data.ply !== g.game.moves.length) return reply(ack, { ok: false, error: 'stale' });
    if (!consumeTime(g, s)) { endGame(g, { winner: 1 - s, reason: 'timeout' }); return reply(ack, { ok: false, error: 'timeout' }); }
    const rec = g.game.play(String(data.usi || ''));
    if (!rec) return reply(ack, { ok: false, error: 'illegal' });
    if (g.clock.inc && !g.clock.byoyomi) g.clock.main[s] += g.clock.inc;
    g.clock.turnStart = Date.now();
    io.to('g' + g.id).emit('move', { id: g.id, usi: rec.usi, kif: rec.kif, ply: g.game.moves.length, check: rec.check, clock: clockState(g) });
    reply(ack, { ok: true });
    if (g.game.result) endGame(g, g.game.result);
    else { persistLive(g); armTimer(g); }
  });

  socket.on('declare', (data, ack) => {
    if (!me || !data) return reply(ack, { ok: false });
    const g = games.get(String(data.gameId));
    if (!g || g.result) return reply(ack, { ok: false, error: 'no_game' });
    const s = g.tokens.indexOf(me.token);
    if (s < 0 || g.game.pos.turn !== s) return reply(ack, { ok: false, error: 'not_your_turn' });
    if (!consumeTime(g, s)) { endGame(g, { winner: 1 - s, reason: 'timeout' }); return reply(ack, { ok: false, error: 'timeout' }); }
    const info = g.game.declare();
    reply(ack, { ok: true, info });
    endGame(g, g.game.result);
  });

  socket.on('resign', (data) => {
    if (!me) return;
    const g = games.get(String(data && data.gameId));
    if (!g || g.result) return;
    const s = g.tokens.indexOf(me.token);
    if (s >= 0) endGame(g, { winner: 1 - s, reason: 'resign' });
  });

  socket.on('rematch', (data, ack) => {
    if (!me) return reply(ack, { error: 'no' });
    const g = games.get(String(data && data.gameId));
    if (!g || !g.result || Date.now() - g.endedAt > REMATCH_WINDOW) return reply(ack, { error: 'expired' });
    const s = g.tokens.indexOf(me.token);
    if (s < 0) return reply(ack, { error: 'no' });
    const opp = getPlayer(g.tokens[1 - s]);
    if (me.gameId || !opp || !opp.socketId || opp.gameId) return reply(ack, { error: 'unavailable' });
    g.rematch.add(s);
    if (g.rematch.size === 2) {
      g.rematch.clear();
      g.endedAt = 0;
      startGame(g.tokens[1], g.tokens[0], g.tc, { rated: g.rated, fixedColors: true }); // 先後入れ替え
      return reply(ack, { ok: true, started: true });
    }
    const os = socketOf(opp);
    if (os) os.emit('rematchOffer', { gameId: g.id, name: me.name });
    reply(ack, { ok: true, waiting: true });
  });

  socket.on('watch', (data, ack) => {
    const g = games.get(String(data && data.gameId));
    if (!g) return reply(ack, null);
    socket.join('g' + g.id);
    reply(ack, { ...gameState(g), you: -1 });
  });
  socket.on('unwatch', (data) => socket.leave('g' + String(data && data.gameId)));

  const chatTimes = [];
  socket.on('chat', (data) => {
    if (!me || !data) return;
    const text = clean(data.text, 200);
    if (!text) return;
    const now = Date.now();
    while (chatTimes.length && now - chatTimes[0] > 10e3) chatTimes.shift();
    if (chatTimes.length >= 5) return socket.emit('chat', { room: data.room, name: 'システム', text: '発言が速すぎます。少し待ってください。', system: true });
    chatTimes.push(now);
    const room = data.room === 'lobby' ? 'lobby' : 'g' + String(data.room);
    if (room !== 'lobby' && !socket.rooms.has(room)) return;
    io.to(room).emit('chat', { room: data.room, name: me.name, text, time: now });
  });

  socket.on('report', (data, ack) => {
    if (!me || !data) return reply(ack, { ok: false });
    db.report(me.id, clean(data.name, 16), clean(data.room, 20), clean(data.text, 200));
    reply(ack, { ok: true });
  });

  socket.on('disconnect', () => {
    if (!me || me.socketId !== socket.id) return;
    me.socketId = null;
    clearWaiting(me);
    if (me.gameId && games.has(me.gameId)) {
      const g = games.get(me.gameId), i = g.tokens.indexOf(me.token);
      if (!g.result) {
        socket.to('g' + g.id).emit('opponentStatus', { connected: false, limit: DISCONNECT_LIMIT });
        clearTimeout(g.dcTimers[i]);
        g.dcTimers[i] = setTimeout(() => endGame(g, { winner: 1 - i, reason: 'disconnect' }), DISCONNECT_LIMIT);
      }
    }
    broadcastLobby();
  });
});

function shutdown() {
  // 進行中の対局は live_games に保存済み。次回起動時に復元される
  for (const g of games.values()) if (!g.result) persistLive(g);
  io.close();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (require.main === module) {
  server.listen(PORT, () => console.log(`将棋オンライン道場 v${VERSION} 起動: http://localhost:${PORT}`));
}
module.exports = { server, io, TIME_CONTROLS, VERSION };
