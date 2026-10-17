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

console.log(fail ? `\n${fail} 件失敗` : '\nすべて成功');
process.exit(fail ? 1 : 0);
