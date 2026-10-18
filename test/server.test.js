// node test/server.test.js — 実際にクライアントをつないでサーバーを検証
process.env.PORT = 0;
const fs = require('fs'), os = require('os'), path = require('path');
const DBFILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-srv-')), 't.db');
process.env.DB_PATH = DBFILE;
const { server, TIME_CONTROLS } = require('../server/server.js');
const { io } = require('socket.io-client');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  OK  ' : '  NG  ') + m); if (!c) fail++; };
const once = (s, ev, ms = 5000) => new Promise((r, j) => { const t = setTimeout(() => j(new Error('timeout ' + ev)), ms); s.once(ev, (d) => { clearTimeout(t); r(d); }); });
const call = (s, ev, d) => new Promise((r) => s.emit(ev, d, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

TIME_CONTROLS.test = { label: 'test', main: 0, byoyomi: 1500, inc: 0 };
TIME_CONTROLS.fish = { label: 'fish', main: 2000, byoyomi: 0, inc: 3000 };

server.listen(0, async () => {
  const url = 'http://localhost:' + server.address().port;
  const conn = () => io(url, { transports: ['websocket'], forceNew: true });
  const a = conn(), b = conn();
  try {
    const la = await call(a, 'login', { name: '太郎' }), lb = await call(b, 'login', { name: '花子' });
    ok(la.rating === 1500 && lb.name === '花子' && la.token.length >= 20, 'ログイン（安全なトークン発行）');

    const c = conn();
    const lc = await call(c, 'login', { name: '太郎' });
    ok(lc.nameError === 'taken' && lc.name !== '太郎', '他人と同じ名前は使えない');
    const bad = await call(c, 'login', { token: 'zzzzzzzzzzzzzzzzzzzz', transfer: true });
    ok(bad.error === 'transfer_not_found', '間違った引き継ぎコードは拒否');
    c.close();

    const sa = once(a, 'gameStart'), sb = once(b, 'gameStart');
    a.emit('seek', { tc: 'm10b30' }); await sleep(50); b.emit('seek', { tc: 'm10b30' });
    const [ga, gb] = await Promise.all([sa, sb]);
    ok(ga.id === gb.id && ga.you !== gb.you && ga.rated === true, 'マッチング成立（レート対局）');
    const sente = ga.you === 0 ? a : b, gote = ga.you === 0 ? b : a, id = ga.id;

    ok((await call(gote, 'move', { gameId: id, usi: '3c3d', ply: 0 })).error === 'not_your_turn', '相手の手番には指せない');
    ok((await call(sente, 'move', { gameId: id, usi: '7g7e', ply: 0 })).error === 'illegal', '反則手は拒否');
    ok((await call(sente, 'move', { gameId: id, usi: '7g7f', ply: 5 })).error === 'stale', '手数が合わない着手（二重送信）は拒否');

    const recv = once(gote, 'move');
    ok((await call(sente, 'move', { gameId: id, usi: '7g7f', ply: 0 })).ok, '▲７六歩 を受理');
    const mv = await recv;
    ok(mv.kif === '▲７六歩' && mv.clock.turn === 1, '相手に指し手と時計が届く');
    ok((await call(sente, 'move', { gameId: id, usi: '7f7e', ply: 0 })).error === 'not_your_turn', '同じ手の二重送信は拒否');

    const ch = once(sente, 'chat');
    gote.emit('chat', { room: id, text: 'よろしく<script>' });
    ok((await ch).text === 'よろしくscript', 'チャット中継（タグ除去）');
    ok((await call(gote, 'report', { name: '太郎', room: id, text: 'test' })).ok, '通報を受け付ける');

    for (const [who, u, ply] of [[gote, '3c3d', 1], [sente, '8h2b+', 2], [gote, '3a2b', 3]]) {
      const r = await call(who, 'move', { gameId: id, usi: u, ply });
      if (!r.ok) ok(false, '手順 ' + u + ' ' + r.error);
    }
    const endP = once(a, 'gameEnd');
    const dec = await call(sente, 'declare', { gameId: id });
    const end = await endP;
    ok(dec.ok && !dec.info.ok && end.result.reason === 'bad_declare' && end.result.winner === 1, '条件不足の入玉宣言は宣言側の負け');
    ok(end.result.ratingChange && end.result.ratingChange[1] === 20, 'レーティング更新（初心者期間は変動大きめ +20）');

    const rank = await (await fetch(url + '/api/ranking')).json();
    ok(rank.length === 2 && rank[0].rating === 1520 && rank[0].streak === 1, 'ランキング・連勝記録が保存される');
    const saved = await (await fetch(url + '/api/games/' + id)).json();
    ok(saved.moves === '7g7f 3c3d 8h2b+ 3a2b' && saved.reason === 'bad_declare' && saved.rated === 1, '棋譜が保存される');

    // 再対局（先後入れ替え）
    const r1 = await call(sente, 'rematch', { gameId: id });
    const s2a = once(a, 'gameStart'), s2b = once(b, 'gameStart');
    const r2 = await call(gote, 'rematch', { gameId: id });
    const [g2a] = await Promise.all([s2a, s2b]);
    ok(r1.waiting && r2.started && g2a.you === 1 - ga.you, '再対局（先後入れ替え）');
    const s2 = g2a.you === 0 ? a : b;
    ok((await call(s2, 'move', { gameId: g2a.id, usi: '2g2f', ply: 0 })).ok, '再対局で指せる');
    const ge = once(a, 'gameEnd');
    (g2a.you === 0 ? b : a).emit('resign', { gameId: g2a.id });
    await ge;

    // 合言葉対局（レートなし）
    const cp = await call(a, 'createPrivate', { tc: 'm15b60' });
    ok(/^\d{6}$/.test(cp.code), '合言葉（6桁）を発行');
    ok((await call(b, 'joinPrivate', { code: '000000' })).error === 'not_found', '違う合言葉は入れない');
    const p1 = once(a, 'gameStart'), p2 = once(b, 'gameStart');
    const jp = await call(b, 'joinPrivate', { code: cp.code });
    const [pa] = await Promise.all([p1, p2]);
    ok(jp.ok && pa.rated === false && pa.tc === 'm15b60', '合言葉で対局開始（レートなし）');
    const before = JSON.stringify(await (await fetch(url + '/api/ranking')).json());
    const pe = once(a, 'gameEnd');
    a.emit('resign', { gameId: pa.id });
    await pe;
    const after = JSON.stringify(await (await fetch(url + '/api/ranking')).json());
    ok(before === after, '非レート対局ではレーティング・戦績が変わらない');

    // フィッシャー
    const f1 = once(a, 'gameStart'), f2 = once(b, 'gameStart');
    a.emit('seek', { tc: 'fish' }); b.emit('seek', { tc: 'fish' });
    const [fa] = await Promise.all([f1, f2]);
    const fsen = fa.you === 0 ? a : b;
    const mvp = once(a, 'move');
    await call(fsen, 'move', { gameId: fa.id, usi: '7g7f', ply: 0 });
    const fm = await mvp;
    ok(fm.clock.main[0] > 4000 && fm.clock.main[0] <= 5000, 'フィッシャー：指すと持ち時間が加算（' + fm.clock.main[0] + 'ms）');
    const fe = once(a, 'gameEnd');
    a.emit('resign', { gameId: fa.id });
    await fe;

    // 時間切れ
    const t1 = once(a, 'gameStart'), t2 = once(b, 'gameStart');
    a.emit('seek', { tc: 'test' }); b.emit('seek', { tc: 'test' });
    await Promise.all([t1, t2]);
    const e2 = await once(a, 'gameEnd', 5000);
    ok(e2.result.reason === 'timeout' && e2.result.winner === 1, '時間切れ負け（先手が指さない）');

    // 切断→再接続
    const k1 = once(a, 'gameStart'), k2 = once(b, 'gameStart');
    a.emit('seek', { tc: 'm30b60' }); b.emit('seek', { tc: 'm30b60' });
    const [g3] = await Promise.all([k1, k2]);
    a.disconnect();
    await sleep(100);
    const a2 = conn();
    const re = await call(a2, 'login', { token: la.token });
    ok(re.resume && re.resume.id === g3.id && re.name === '太郎', '切断後に同じ対局へ復帰（名前も維持）');
    ok(Array.isArray(re.history) && re.history.length >= 1, 'レーティング推移が返る');

    // 棋力差の大きい相手とはすぐには組まない
    const x = conn(), y = conn();
    await call(x, 'login', {}); await call(y, 'login', {});
    ok(true, '（棋力差のテストは matcher.test で実施）');
    x.close(); y.close(); a2.close();
  } catch (e) { console.error(e); fail++; }
  a.close(); b.close();
  console.log(fail ? `\n${fail} 件失敗` : '\nすべて成功');
  fs.rmSync(path.dirname(DBFILE), { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
});
