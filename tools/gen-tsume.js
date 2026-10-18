// node tools/gen-tsume.js — 詰将棋（1手詰・3手詰）を自動生成して public/data/tsume.json に保存
// すべて自前のルールエンジンで「詰みが正しいこと」「初手が1通りに決まること」を検証済みの問題だけを採用する。
const fs = require('fs'), path = require('path');
const C = require('../public/js/shogi-core.js');

let seed = 20261018;
const rnd = () => { // mulberry32（再現性のある乱数）
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const G = C.GOTE;

function isMate(pos) { return C.inCheck(pos) && !C.hasLegalMove(pos); }
function mateMoves(pos) { return C.legalMoves(pos).filter((m) => isMate(C.makeMove(pos, m))); }

function randomPosition(level) {
  const pos = new C.Position();
  const occupied = new Set();
  const put = (sq, p) => { if (sq < 0 || sq > 80 || occupied.has(sq)) return false; pos.board[sq] = p; occupied.add(sq); return true; };
  const kr = Math.floor(rnd() * 2), kc = 1 + Math.floor(rnd() * 7);
  const ksq = kr * 9 + kc;
  put(ksq, C.K | G);
  put(8 * 9 + 8, C.K); // 先手玉は遠くに置く（問題には関係しない）
  const near = (r) => { const dr = Math.floor(rnd() * (2 * r + 1)) - r, dc = Math.floor(rnd() * (2 * r + 1)) - r; const rr = kr + dr, cc = kc + dc; return rr >= 0 && rr < 9 && cc >= 0 && cc < 9 ? rr * 9 + cc : -1; };
  // 後手の守り駒
  const def = 1 + Math.floor(rnd() * (level === 1 ? 3 : 4));
  for (let i = 0; i < def; i++) put(near(2), pick([C.G, C.G, C.S, C.P, C.L, C.N]) | G);
  // 先手の攻め駒（盤上）
  const att = 1 + Math.floor(rnd() * (level === 1 ? 2 : 3));
  for (let i = 0; i < att; i++) {
    const k = pick([C.G, C.S, C.R, C.B, C.N, C.L, C.P, C.PR, C.PB]);
    const sq = near(3);
    if (sq < 0) continue;
    const r = (sq / 9) | 0;
    if ((k === C.P || k === C.L) && r === 0) continue;
    if (k === C.N && r <= 1) continue;
    put(sq, k);
  }
  // 持ち駒
  const hand = level === 1 ? Math.floor(rnd() * 2) + 1 : Math.floor(rnd() * 3) + 1;
  for (let i = 0; i < hand; i++) pos.hands[0][pick([C.G, C.G, C.S, C.R, C.B, C.N, C.L])]++;
  pos.turn = 0;
  // 後手に二歩・行き所のない駒がないか、後手玉に王手がかかっていないか
  if (C.attacked(pos.board, ksq, 0)) return null;
  for (let i = 0; i < 81; i++) {
    const p = pos.board[i];
    if (p && C.side(p) === 1 && (C.kind(p) === C.P || C.kind(p) === C.L) && ((i / 9) | 0) === 8) return null;
  }
  return pos;
}

function oneMove(pos) {
  const mates = mateMoves(pos);
  return mates.length === 1 ? mates[0] : null;
}

function threeMove(pos) {
  if (mateMoves(pos).length) return null; // 1手で詰むなら3手詰ではない
  const checks = C.legalMoves(pos).filter((m) => C.inCheck(C.makeMove(pos, m)));
  const solutions = [];
  for (const m1 of checks) {
    const p1 = C.makeMove(pos, m1);
    const replies = C.legalMoves(p1);
    if (!replies.length) continue;
    let all = true, line = null;
    for (const r of replies) {
      const p2 = C.makeMove(p1, r);
      const m3 = mateMoves(p2);
      if (!m3.length) { all = false; break; }
      // 応手の中で一番粘る（詰み方が1通りの）手を本筋にする
      if (!line || m3.length < line.n) line = { r, m3: m3[0], n: m3.length };
    }
    if (all) solutions.push({ m1, line });
    if (solutions.length > 1) return null;
  }
  return solutions.length === 1 ? solutions[0] : null;
}

const out = { generatedAt: new Date().toISOString().slice(0, 10), one: [], three: [] };
const seen = new Set();
let tries = 0;
while ((out.one.length < 150 || out.three.length < 100) && tries < 400000) {
  tries++;
  const level = out.one.length < 150 ? (rnd() < 0.6 ? 1 : 3) : 3;
  const pos = randomPosition(level);
  if (!pos) continue;
  const sfen = C.toSfen(pos);
  if (seen.has(sfen)) continue;
  seen.add(sfen);
  if (level === 1 && out.one.length < 150) {
    const m = oneMove(pos);
    if (m) out.one.push({ sfen, answer: [C.moveToUsi(m)] });
  } else if (level === 3 && out.three.length < 100) {
    const s = threeMove(pos);
    if (s) out.three.push({ sfen, answer: [C.moveToUsi(s.m1), C.moveToUsi(s.line.r), C.moveToUsi(s.line.m3)] });
  }
}
fs.mkdirSync(path.join(__dirname, '..', 'public', 'data'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'public', 'data', 'tsume.json'), JSON.stringify(out));
console.log(`1手詰 ${out.one.length}問 / 3手詰 ${out.three.length}問（試行 ${tries}）`);
