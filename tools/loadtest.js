// node tools/loadtest.js [URL] [人数] [秒] — 同時対局の負荷試験（ランダムな合法手を指し続ける）
const { io } = require('socket.io-client');
const C = require('../public/js/shogi-core.js');
const URL = process.argv[2] || 'http://localhost:3999';
const N = +(process.argv[3] || 200), SEC = +(process.argv[4] || 40);
const lat = [];
let games = 0, moves = 0, errors = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function bot(i) {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  await new Promise((r) => s.on('connect', r));
  await new Promise((r) => s.emit('login', { name: 'bot' + i + '_' + Date.now() % 100000 }, r));
  let g = null, you = -1, id = null;
  const think = async () => {
    if (!g || g.result || g.pos.turn !== you) return;
    await sleep(500 + Math.random() * 1500);
    if (!g || g.result || g.pos.turn !== you) return;
    const ms = C.legalMoves(g.pos);
    const m = ms[Math.floor(Math.random() * ms.length)];
    const t = Date.now();
    s.emit('move', { gameId: id, usi: C.moveToUsi(m), ply: g.moves.length }, (r) => { lat.push(Date.now() - t); if (!r.ok) errors++; });
  };
  s.on('gameStart', (d) => { games++; id = d.id; you = d.you; g = new C.Game(d.startSfen); think(); });
  s.on('move', (d) => { if (g && d.id === id) { g.play(d.usi); moves++; think(); } });
  s.on('gameEnd', () => { g = null; setTimeout(() => s.emit('seek', { tc: 'm30b60', rated: false }), 300); });
  s.emit('seek', { tc: 'm30b60', rated: false });
  return s;
}
(async () => {
  const health = async () => (await (await fetch(URL + '/health')).json());
  console.log('開始前', await health());
  const socks = [];
  for (let i = 0; i < N; i++) { socks.push(await bot(i)); if (i % 50 === 49) await sleep(200); }
  const t0 = Date.now(); const m0 = moves;
  await sleep(SEC * 1000);
  const h = await health();
  lat.sort((a, b) => a - b);
  const q = (p) => lat[Math.floor(lat.length * p)] || 0;
  console.log(`接続 ${N}人 / 進行中 ${h.games}局 / ${SEC}秒で ${moves - m0}手（毎秒 ${((moves - m0) / ((Date.now() - t0) / 1000)).toFixed(1)}手）`);
  console.log(`応答時間 中央値 ${q(0.5)}ms / 95% ${q(0.95)}ms / 最大 ${lat[lat.length - 1]}ms / エラー ${errors}`);
  console.log('サーバーのメモリ', h.mem, 'MB');
  socks.forEach((s) => s.close());
  process.exit(0);
})();
