// node test/restore.test.js — サーバー再起動で進行中の対局が復元されるか／棋力差マッチング
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { io } = require('socket.io-client');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-rs-'));
const DB = path.join(dir, 'r.db');
const PORT = 3900 + Math.floor(Math.random() * 90);
const url = 'http://localhost:' + PORT;

let fail = 0;
const ok = (c, m) => { console.log((c ? '  OK  ' : '  NG  ') + m); if (!c) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (s, ev, d) => new Promise((r) => s.emit(ev, d, r));
const once = (s, ev, ms = 5000) => new Promise((r, j) => { const t = setTimeout(() => j(new Error('timeout ' + ev)), ms); s.once(ev, (d) => { clearTimeout(t); r(d); }); });
const conn = () => io(url, { transports: ['websocket'], forceNew: true, reconnection: false });

function startServer() {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], { env: { ...process.env, PORT, DB_PATH: DB }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.log = () => out;
  return new Promise((r) => { const t = setInterval(() => { if (/起動/.test(out)) { clearInterval(t); r(p); } }, 50); });
}
const stop = (p) => new Promise((r) => { p.on('exit', r); p.kill('SIGTERM'); });

(async () => {
  let srv = await startServer();
  try {
    const a = conn(), b = conn();
    const la = await call(a, 'login', { name: 'A' }), lb = await call(b, 'login', { name: 'B' });
    const s1 = once(a, 'gameStart'), s2 = once(b, 'gameStart');
    a.emit('seek', { tc: 'm30b60' }); b.emit('seek', { tc: 'm30b60' });
    const [ga] = await Promise.all([s1, s2]);
    const sente = ga.you === 0 ? a : b, gote = ga.you === 0 ? b : a;
    await call(sente, 'move', { gameId: ga.id, usi: '7g7f', ply: 0 });
    await call(gote, 'move', { gameId: ga.id, usi: '3c3d', ply: 1 });
    a.close(); b.close();

    await stop(srv);
    srv = await startServer();
    ok(/1 局復元/.test(srv.log()), 'サーバー再起動で進行中の対局を復元');

    const a2 = conn(), b2 = conn();
    const ra = await call(a2, 'login', { token: la.token });
    const rb = await call(b2, 'login', { token: lb.token });
    ok(ra.resume && ra.resume.moves.length === 2 && rb.resume && rb.resume.id === ga.id, '両者が同じ対局・同じ局面に戻れる');
    const sen2 = ga.you === 0 ? a2 : b2;
    ok((await call(sen2, 'move', { gameId: ga.id, usi: '2g2f', ply: 2 })).ok, '再起動後も続きを指せる');
    a2.close(); b2.close();

    // 棋力差マッチング：1500 と 2300 は最初の2秒では組まれない
    const x = conn(), y = conn();
    const lx = await call(x, 'login', { name: 'X' }); const ly = await call(y, 'login', { name: 'Y' });
    x.close(); y.close();
    await stop(srv);
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(DB); d.exec("UPDATE players SET rating = 2300 WHERE name = 'Y'"); d.close();
    srv = await startServer();
    const x2 = conn(), y2 = conn(), z2 = conn();
    await call(x2, 'login', { token: lx.token }); await call(y2, 'login', { token: ly.token });
    let matched = false;
    x2.once('gameStart', () => { matched = true; });
    x2.emit('seek', { tc: 'kire3' }); y2.emit('seek', { tc: 'kire3' });
    await sleep(2500);
    ok(!matched, '棋力差800の相手とはすぐには組まない');
    // 近い棋力の人が来たらそちらと組む
    await call(z2, 'login', { name: 'Z' });
    const zm = once(z2, 'gameStart', 4000);
    z2.emit('seek', { tc: 'kire3' });
    const zg = await zm.catch(() => null);
    ok(zg && zg.names.includes('X') && !zg.names.includes('Y'), '近い棋力（1500同士）を優先して組む');
    x2.close(); y2.close(); z2.close();
  } catch (e) { console.error(e); fail++; }
  await stop(srv);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fail ? `\n${fail} 件失敗` : '\nすべて成功');
  process.exit(fail ? 1 : 0);
})();
