// node test/server.test.js — 2人のクライアントで実際に対局してサーバーを検証
process.env.PORT = 0;
process.env.DB_PATH = ':memory:';
const { server, TIME_CONTROLS } = require('../server/server.js');
const { io } = require('socket.io-client');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  OK  ' : '  NG  ') + m); if (!c) fail++; };
const once = (s, ev) => new Promise((r) => s.once(ev, r));
const login = (s, name) => new Promise((r) => s.emit('login', { name }, r));
const move = (s, gameId, usi) => new Promise((r) => s.emit('move', { gameId, usi }, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

TIME_CONTROLS.test = { label: 'test', main: 0, byoyomi: 1500 };

server.listen(0, async () => {
  const url = 'http://localhost:' + server.address().port;
  const a = io(url, { transports: ['websocket'] }), b = io(url, { transports: ['websocket'] });
  try {
    const la = await login(a, '太郎'), lb = await login(b, '花子');
    ok(la.rating === 1500 && lb.name === '花子', 'ログイン');

    // マッチング
    const sa = once(a, 'gameStart'), sb = once(b, 'gameStart');
    a.emit('seek', { tc: 'hayasashi' }); await sleep(50); b.emit('seek', { tc: 'hayasashi' });
    const [ga, gb] = await Promise.all([sa, sb]);
    ok(ga.id === gb.id && ga.you !== gb.you, 'マッチング成立・先後が分かれる');
    const sente = ga.you === 0 ? a : b, gote = ga.you === 0 ? b : a, id = ga.id;

    // 手番違い・反則手
    ok((await move(gote, id, '3c3d')).error === 'not_your_turn', '相手の手番には指せない');
    ok((await move(sente, id, '7g7e')).error === 'illegal', '反則手は拒否');

    // 正常な指し手が両者に届く
    const recv = once(gote, 'move');
    ok((await move(sente, id, '7g7f')).ok, '▲７六歩 を受理');
    const mv = await recv;
    ok(mv.kif === '▲７六歩' && mv.clock.turn === 1, '相手に指し手と時計が届く');

    // チャット
    const ch = once(sente, 'chat');
    gote.emit('chat', { room: id, text: 'よろしく<script>' });
    const c = await ch;
    ok(c.text === 'よろしくscript', 'チャット中継（タグ除去）');

    // 数手進める（角成りを含む）
    const seq = ['3c3d', '8h2b+', '3a2b'];
    let endP = once(a, 'gameEnd');
    for (let i = 0; i < seq.length; i++) {
      const who = i % 2 === 0 ? gote : sente;
      const r = await move(who, id, seq[i]);
      if (!r.ok) { ok(false, '手順 ' + seq[i] + ' ' + r.error); break; }
    }
    // 投了で終局
    gote.emit('resign', { gameId: id });
    const end = await endP;
    ok(end.result.reason === 'resign' && end.result.winner === 0, '投了で先手勝ち');
    ok(end.result.ratingChange && end.result.ratingChange[0] === 16, 'レーティング更新 +16');

    // 保存の確認（API）
    const rank = await (await fetch(url + '/api/ranking')).json();
    ok(rank.length === 2 && rank[0].rating === 1516 && rank[0].wins === 1, 'ランキングに保存される');
    const saved = await (await fetch(url + '/api/games/' + id)).json();
    ok(saved.moves === '7g7f 3c3d 8h2b+ 3a2b' && saved.reason === 'resign' && saved.winner === 0, '棋譜が保存される');
    ok(!('sente_id' in saved), '内部IDは公開しない');
    const sl = ga.you === 0 ? la : lb;
    const relog = await new Promise((r) => sente.emit('login', { token: sl.token, name: sl.name }, r));
    ok(relog.wins === 1 && relog.recent.length === 1 && relog.recent[0].ply === 4, '戦績・最近の対局が返る');

    // 時間切れ（秒読み1.5秒のテスト用持ち時間）
    const s2a = once(a, 'gameStart'), s2b = once(b, 'gameStart');
    a.emit('seek', { tc: 'test' }); await sleep(50); b.emit('seek', { tc: 'test' });
    const [g2] = await Promise.all([s2a, s2b]);
    endP = once(a, 'gameEnd');
    const e2 = await endP;
    ok(e2.result.reason === 'timeout' && e2.result.winner === 1, '時間切れ負け（先手が指さない）');

    // 切断→再接続で対局復帰
    const s3a = once(a, 'gameStart'), s3b = once(b, 'gameStart');
    a.emit('seek', { tc: 'choukou' }); await sleep(50); b.emit('seek', { tc: 'choukou' });
    const [g3] = await Promise.all([s3a, s3b]);
    const tokenA = la.token;
    a.disconnect();
    await sleep(100);
    const a2 = io(url, { transports: ['websocket'] });
    const re = await new Promise((r) => a2.emit('login', { token: tokenA, name: '太郎' }, r));
    ok(re.resume && re.resume.id === g3.id, '切断後に同じ対局へ復帰できる');
    a2.close();
  } catch (e) { console.error(e); fail++; }
  a.close(); b.close();
  console.log(fail ? `\n${fail} 件失敗` : '\nすべて成功');
  process.exit(fail ? 1 : 0);
});
