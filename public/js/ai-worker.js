/*
 * ai-worker.js — 予備の内蔵AI（Fairy-Stockfish が使えない環境用）
 * Web Worker で動くので画面は固まらない。
 */
importScripts('shogi-core.js');
const C = self.ShogiCore;

// 駒の価値（成駒は 9〜14）
const VAL = [0, 90, 315, 405, 495, 540, 855, 990, 0, 540, 540, 540, 540, 945, 1395];
const HAND = [0, 100, 350, 450, 550, 600, 950, 1100, 0];
const KING_HIT = 100000;

function evaluate(pos) {
  let s = 0;
  const b = pos.board;
  for (let i = 0; i < 81; i++) {
    const p = b[i];
    if (!p) continue;
    const k = p & 15;
    let v = VAL[k];
    // 歩・銀は前に出るほど少し評価
    if (k === 1 || k === 4) {
      const r = (i / 9) | 0;
      v += (p & 16 ? r : 8 - r) * 3;
    }
    s += p & 16 ? -v : v;
  }
  for (let k = 1; k <= 7; k++) s += (pos.hands[0][k] - pos.hands[1][k]) * HAND[k];
  return pos.turn === 0 ? s : -s;
}

let deadline = 0, nodes = 0, stop = false;

function order(ms) {
  // 取る手（価値の高い駒を取る）→ 成る手 → その他
  return ms.sort((a, b) => (VAL[b.captured & 15] + (b.promote ? 200 : 0)) - (VAL[a.captured & 15] + (a.promote ? 200 : 0)));
}

function search(pos, depth, alpha, beta, qdepth) {
  if ((++nodes & 1023) === 0 && Date.now() > deadline) stop = true;
  if (stop) return 0;
  if (depth <= 0) {
    const stand = evaluate(pos);
    if (stand >= beta || qdepth <= 0) return stand;
    if (stand > alpha) alpha = stand;
    const caps = order(C.genPseudo(pos).filter((m) => m.captured));
    for (const m of caps) {
      if ((m.captured & 15) === 8) return KING_HIT;
      const v = -search(C.makeMove(pos, m), 0, -beta, -alpha, qdepth - 1);
      if (v >= beta) return v;
      if (v > alpha) alpha = v;
    }
    return alpha;
  }
  const ms = order(C.genPseudo(pos));
  let best = -Infinity;
  for (const m of ms) {
    if ((m.captured & 15) === 8) return KING_HIT; // 玉を取れる＝相手の反則手
    const v = -search(C.makeMove(pos, m), depth - 1, -beta, -alpha, 3);
    if (stop) return 0;
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

self.onmessage = (e) => {
  const { id, sfen, moves, level, timeMs } = e.data;
  const g = new C.Game(sfen);
  for (const u of moves) g.play(u);
  const pos = g.pos;
  const legal = order(C.legalMoves(pos));
  if (!legal.length) return self.postMessage({ id, move: 'resign' });

  const maxDepth = [0, 1, 2, 2, 3, 4][level] || 2;
  const noise = [0, 300, 120, 40, 10, 0][level] || 0;
  deadline = Date.now() + (timeMs || 1500);
  stop = false; nodes = 0;
  let bestMove = legal[0];
  for (let d = 1; d <= maxDepth; d++) {
    let bestVal = -Infinity, cand = null;
    for (const m of legal) {
      const v = -search(C.makeMove(pos, m), d - 1, -Infinity, Infinity, 3) + (noise ? (Math.random() - 0.5) * noise : 0);
      if (stop) break;
      if (v > bestVal) { bestVal = v; cand = m; }
    }
    if (stop && d > 1) break;
    if (cand) bestMove = cand;
    if (bestVal >= KING_HIT / 2) break;
  }
  self.postMessage({ id, move: C.moveToUsi(bestMove) });
};
