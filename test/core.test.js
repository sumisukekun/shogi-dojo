// node test/core.test.js
const C = require('../public/js/shogi-core.js');
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? '  OK  ' : '  NG  ') + msg); if (!cond) fail++; };

// 1. perft（初期局面の既知の値）
const start = C.fromSfen(C.START_SFEN);
[[1, 30], [2, 900], [3, 25470]].forEach(([d, n]) => {
  const t = Date.now(); const r = C.perft(start, d);
  ok(r === n, `perft(${d}) = ${r} (期待 ${n}) ${Date.now() - t}ms`);
});

// 2. SFEN 往復
ok(C.toSfen(start) === C.START_SFEN, 'SFEN 往復');

// 3. 二歩
{
  const p = C.fromSfen('4k4/9/9/9/9/9/4P4/9/4K4 b P 1');
  const ms = C.legalMoves(p).filter((m) => m.drop === C.P);
  ok(!ms.some((m) => m.to % 9 === 4), '二歩は打てない（5筋）');
  ok(!ms.some((m) => ((m.to / 9) | 0) === 0), '一段目に歩は打てない');
}

// 4. 打ち歩詰め（５二に歩を打つと詰む局面）
{
  const p = C.fromSfen('3lkl3/9/4G4/9/9/9/9/9/4K4 b P 1');
  const usi = C.moveToUsi({ drop: C.P, to: C.usiToSq('5b') });
  ok(C.moveFromUsi(p, usi) === null, '打ち歩詰めは反則として除外');
}
// 4b. 突き歩詰めはOK
{
  const p = C.fromSfen('3gkg3/9/4P4/9/9/9/9/4G4/4K4 b - 1');
  // ５三歩が５二歩成ではなく…  ここでは突き歩（盤上の歩を動かす）が合法か確認
  const m = C.moveFromUsi(p, '5c5b');
  ok(m !== null, '突き歩は合法（打ち歩ではない）');
}

// 5. 王手放置の禁止
{
  const p = C.fromSfen('4k4/9/9/9/9/9/9/4r4/4K4 b - 1');
  const ms = C.legalMoves(p);
  ok(ms.every((m) => !C.inCheck(C.makeMove(p, m), 0)), '王手を放置する手は生成されない');
}

// 6. 行き所のない駒（桂を一・二段目に打てない／香は一段目で強制成り）
{
  const p = C.fromSfen('4k4/9/9/9/9/9/9/9/4K4 b NL 1');
  const ms = C.legalMoves(p);
  ok(!ms.some((m) => m.drop === C.N && ((m.to / 9) | 0) <= 1), '桂は一・二段目に打てない');
  const p2 = C.fromSfen('k8/9/L8/9/9/9/9/9/4K4 b - 1');
  const lm = C.legalMoves(p2).filter((m) => m.from === C.usiToSq('9c') && m.to === C.usiToSq('9b'));
  ok(lm.length === 2, '香の二段目移動は成・不成の両方あり');
}

// 7. 詰み判定（頭金）
{
  const g = new C.Game('4k4/9/4P4/9/9/9/9/9/4K4 b G 1');
  g.play('G*5b');
  ok(g.result && g.result.winner === 0 && g.result.reason === 'checkmate', '頭金で詰み → 先手勝ち');
}

// 8. 千日手（同一局面4回で引き分け）
{
  const g = new C.Game('4k4/9/9/9/9/9/9/9/4K4 b - 1');
  const loop = ['5i5h', '5a5b', '5h5i', '5b5a'];
  for (let i = 0; i < 3; i++) loop.forEach((u) => g.play(u));
  ok(g.result && g.result.reason === 'sennichite', '千日手 → 引き分け');
}

// 9. 連続王手の千日手（王手している側の負け）
{
  // 先手の飛車が後手玉に王手を繰り返す
  const g = new C.Game('8k/9/9/9/9/9/9/9/K7R b - 1');
  const seq = ['1i1h', '1a2a', '1h2h', '2a1a', '2h1h', '1a2a', '1h2h', '2a1a', '2h1h', '1a2a', '1h2h', '2a1a', '2h1h', '1a2a'];
  for (const u of seq) { if (!g.play(u)) break; if (g.result) break; }
  ok(g.result && g.result.reason === 'perpetual_check' && g.result.winner === 1, '連続王手の千日手 → 王手側（先手）の負け');
}

// 10. 日本語表記
{
  const g = new C.Game();
  const r1 = g.play('7g7f');
  const r2 = g.play('3c3d');
  const r3 = g.play('8h2b+');
  const r4 = g.play('3a2b');
  ok(r1.kif === '▲７六歩' && r2.kif === '△３四歩' && r3.kif === '▲２二角成' && r4.kif === '△同　銀', '棋譜表記: ' + [r1, r2, r3, r4].map((r) => r.kif).join(' '));
}

// 11. 入玉宣言（27点法）
{
  // 先手玉が敵陣、敵陣に大駒2枚＋小駒8枚＝18点、持ち駒で10点 → 28点・10枚
  const ok1 = C.fromSfen('RBGGSSNN1/PPK6/9/9/9/9/9/9/7k1 b 10P 1');
  const i1 = C.declareInfo(ok1);
  ok(i1.ok && i1.points === 28 && i1.pieces === 10, '入玉宣言：28点・10枚で成立 ' + JSON.stringify(i1));
  const ng = C.fromSfen('RBGGSSNN1/PPK6/9/9/9/9/9/9/7k1 b 9P 1');
  ok(!C.declareInfo(ng).ok, '入玉宣言：27点（先手）は不成立');
  const g = new C.Game('RBGGSSNN1/PPK6/9/9/9/9/9/9/7k1 b 10P 1');
  g.declare();
  ok(g.result && g.result.reason === 'nyugyoku' && g.result.winner === 0, '宣言成功で手番側の勝ち');
  const g2 = new C.Game();
  g2.declare();
  ok(g2.result && g2.result.reason === 'bad_declare' && g2.result.winner === 1, '条件不足の宣言は反則負け');
}

// 12. 待った（undo）
{
  const g = new C.Game();
  ['7g7f', '3c3d', '2g2f'].forEach((u) => g.play(u));
  g.undo(2);
  ok(g.moves.length === 1 && g.pos.turn === 1 && C.toSfen(g.pos).startsWith('lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP'), '待った（2手戻す）');
}

// 13. KIF 出力 → 読み込みで元に戻る
{
  const moves = ['7g7f', '3c3d', '8h2b+', '3a2b', 'B*4e', '8b3b', '4e3d', '2b3c', '3d4e', '3c4d', '4e5f'];
  const g = new C.Game(); moves.forEach((u) => g.play(u));
  const kif = C.toKifFile(C.START_SFEN, moves, { sente: '太郎', gote: '花子', result: { reason: 'resign' } });
  const back = C.parseKifu(kif);
  ok(back.moves.join(' ') === moves.join(' ') && back.sente === '太郎', 'KIF 出力→読込で一致');
  ok(/   3 ２二角成\(88\)/.test(kif) && /   4 同　銀\(31\)/.test(kif) && /   5 ４五角打/.test(kif), 'KIF 表記（成・同・打）');
}

// 14. CSA 読み込み
{
  const csa = 'V2.2\nN+先手さん\nN-後手さん\nPI\n+\n+7776FU\n-3334FU\n+8822UM\n-3122GI\n%TORYO\n';
  const r = C.parseKifu(csa);
  ok(r.moves.join(' ') === '7g7f 3c3d 8h2b+ 3a2b' && r.gote === '後手さん', 'CSA 読み込み（成りを含む）');
}

// 15. 位置省略（KI2風）の読み込み
{
  const r = C.parseKifu('手合割：平手\n手数----指手--\n1 ▲７六歩\n2 △３四歩\n3 ▲２二角成\n4 △同　銀\n');
  ok(r.moves.join(' ') === '7g7f 3c3d 8h2b+ 3a2b', '位置省略の棋譜も読める');
}

console.log(fail ? `\n${fail} 件失敗` : '\nすべて成功');
process.exit(fail ? 1 : 0);
