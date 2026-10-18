// node test/tsume.test.js — 収録した詰将棋がすべて正しいか（ルールエンジンで検証）
const C = require('../public/js/shogi-core.js');
const data = require('../public/data/tsume.json');
let bad = 0;
const mate = (p) => C.inCheck(p) && !C.hasLegalMove(p);
data.one.forEach((q, i) => {
  const pos = C.fromSfen(q.sfen);
  const mates = C.legalMoves(pos).filter((m) => mate(C.makeMove(pos, m)));
  if (mates.length !== 1 || C.moveToUsi(mates[0]) !== q.answer[0] || C.inCheck(pos, 1)) { bad++; console.log('NG 1手詰', i); }
});
data.three.forEach((q, i) => {
  const pos = C.fromSfen(q.sfen);
  const m1 = C.moveFromUsi(pos, q.answer[0]);
  const p1 = m1 && C.makeMove(pos, m1);
  const ok = p1 && C.inCheck(p1) && C.legalMoves(p1).every((r) => { const p2 = C.makeMove(p1, r); return C.legalMoves(p2).some((m) => mate(C.makeMove(p2, m))); });
  const r = p1 && C.moveFromUsi(p1, q.answer[1]);
  const p2 = r && C.makeMove(p1, r);
  const m3 = p2 && C.moveFromUsi(p2, q.answer[2]);
  if (!ok || !m3 || !mate(C.makeMove(p2, m3))) { bad++; console.log('NG 3手詰', i); }
});
console.log(`  ${bad ? 'NG' : 'OK'}  詰将棋 1手詰${data.one.length}問・3手詰${data.three.length}問を検証`);
console.log(bad ? `\n${bad} 件失敗` : '\nすべて成功');
process.exit(bad ? 1 : 0);
