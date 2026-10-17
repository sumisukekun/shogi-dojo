/*
 * shogi-core.js — 将棋オンライン道場 ルールエンジン（v03）
 * ブラウザ（window.ShogiCore）と Node.js（require）の両方で動く共通コード。
 * サーバー側でも同じ判定を使い、不正な指し手を受け付けない。
 *
 * 盤面: index = r*9 + c   r=0..8 が「一段〜九段」, c=0..8 が「９筋〜１筋」
 * 先手(0)は r が小さい方向へ進む。後手(1)は逆。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShogiCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- 駒コード ----
  const P = 1, L = 2, N = 3, S = 4, G = 5, B = 6, R = 7, K = 8;
  const PP = 9, PL = 10, PN = 11, PS = 12, PB = 13, PR = 14;
  const GOTE = 16;
  const PROMOTE = { 1: 9, 2: 10, 3: 11, 4: 12, 6: 13, 7: 14 };
  const UNPROMOTE = { 9: 1, 10: 2, 11: 3, 12: 4, 13: 6, 14: 7 };
  const SFEN_CH = { 1: 'P', 2: 'L', 3: 'N', 4: 'S', 5: 'G', 6: 'B', 7: 'R', 8: 'K' };
  const CH_KIND = { P: 1, L: 2, N: 3, S: 4, G: 5, B: 6, R: 7, K: 8 };
  const KANJI = { 1: '歩', 2: '香', 3: '桂', 4: '銀', 5: '金', 6: '角', 7: '飛', 8: '玉', 9: 'と', 10: '成香', 11: '成桂', 12: '成銀', 13: '馬', 14: '龍' };
  const KANJI1 = { 1: '歩', 2: '香', 3: '桂', 4: '銀', 5: '金', 6: '角', 7: '飛', 8: '玉', 9: 'と', 10: '杏', 11: '圭', 12: '全', 13: '馬', 14: '龍' };
  const START_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

  const side = (p) => (p & GOTE ? 1 : 0);
  const kind = (p) => p & 15;

  // ---- 利き（先手向き。dr<0 が前） ----
  const ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const ALL8 = ORTH.concat(DIAG);
  const GOLD = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0]];
  const SILVER = [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 1]];
  const STEP_BASE = { 1: [[-1, 0]], 3: [[-2, -1], [-2, 1]], 4: SILVER, 5: GOLD, 8: ALL8, 9: GOLD, 10: GOLD, 11: GOLD, 12: GOLD, 13: ORTH, 14: DIAG };
  const SLIDE_BASE = { 2: [[-1, 0]], 6: DIAG, 7: ORTH, 13: DIAG, 14: ORTH };

  const STEPS = [{}, {}], SLIDES = [{}, {}];
  const STEP_GRID = [[], []], SLIDE_GRID = [[], []];
  for (let s = 0; s < 2; s++) {
    const f = s === 0 ? 1 : -1;
    for (let k = 1; k <= 14; k++) {
      STEPS[s][k] = (STEP_BASE[k] || []).map(([dr, dc]) => [dr * f, dc]);
      SLIDES[s][k] = (SLIDE_BASE[k] || []).map(([dr, dc]) => [dr * f, dc]);
      const sg = new Array(9).fill(false), lg = new Array(9).fill(false);
      STEPS[s][k].forEach(([dr, dc]) => { if (Math.abs(dr) <= 1) sg[(dr + 1) * 3 + dc + 1] = true; });
      SLIDES[s][k].forEach(([dr, dc]) => { lg[(dr + 1) * 3 + dc + 1] = true; });
      STEP_GRID[s][k] = sg; SLIDE_GRID[s][k] = lg;
    }
  }

  // ---- 局面 ----
  class Position {
    constructor() {
      this.board = new Int8Array(81);
      this.hands = [new Int8Array(8), new Int8Array(8)];
      this.turn = 0;
      this.ply = 1;
    }
    clone() {
      const p = new Position();
      p.board.set(this.board);
      p.hands[0].set(this.hands[0]);
      p.hands[1].set(this.hands[1]);
      p.turn = this.turn; p.ply = this.ply;
      return p;
    }
    key() { return toSfen(this, false); }
  }

  function fromSfen(sfen) {
    const parts = (sfen || START_SFEN).trim().split(/\s+/);
    const pos = new Position();
    const rows = parts[0].split('/');
    if (rows.length !== 9) throw new Error('bad sfen');
    for (let r = 0; r < 9; r++) {
      let c = 0, prom = false;
      for (const ch of rows[r]) {
        if (ch >= '1' && ch <= '9') { c += +ch; continue; }
        if (ch === '+') { prom = true; continue; }
        let k = CH_KIND[ch.toUpperCase()];
        if (!k) throw new Error('bad sfen piece ' + ch);
        if (prom) k = PROMOTE[k];
        pos.board[r * 9 + c] = k | (ch === ch.toLowerCase() ? GOTE : 0);
        c++; prom = false;
      }
    }
    pos.turn = parts[1] === 'w' ? 1 : 0;
    if (parts[2] && parts[2] !== '-') {
      let n = 0;
      for (const ch of parts[2]) {
        if (ch >= '0' && ch <= '9') { n = n * 10 + +ch; continue; }
        const k = CH_KIND[ch.toUpperCase()];
        pos.hands[ch === ch.toLowerCase() ? 1 : 0][k] += n || 1;
        n = 0;
      }
    }
    pos.ply = parts[3] ? +parts[3] : 1;
    return pos;
  }

  function toSfen(pos, withPly = true) {
    let s = '';
    for (let r = 0; r < 9; r++) {
      let empty = 0;
      for (let c = 0; c < 9; c++) {
        const p = pos.board[r * 9 + c];
        if (!p) { empty++; continue; }
        if (empty) { s += empty; empty = 0; }
        let k = kind(p), pre = '';
        if (UNPROMOTE[k]) { pre = '+'; k = UNPROMOTE[k]; }
        const ch = SFEN_CH[k];
        s += pre + (side(p) ? ch.toLowerCase() : ch);
      }
      if (empty) s += empty;
      if (r < 8) s += '/';
    }
    s += pos.turn ? ' w ' : ' b ';
    let h = '';
    const order = [7, 6, 5, 4, 3, 2, 1];
    for (let sd = 0; sd < 2; sd++) for (const k of order) {
      const n = pos.hands[sd][k];
      if (n) h += (n > 1 ? n : '') + (sd ? SFEN_CH[k].toLowerCase() : SFEN_CH[k]);
    }
    s += h || '-';
    if (withPly) s += ' ' + pos.ply;
    return s;
  }

  // ---- 利き判定 ----
  function attacked(b, sq, by) {
    if (sq < 0) return false;
    const r = (sq / 9) | 0, c = sq % 9;
    const f = by === 0 ? -1 : 1;
    // 桂馬
    const ar = r - 2 * f;
    if (ar >= 0 && ar < 9) {
      for (const dc of [-1, 1]) {
        const ac = c - dc;
        if (ac < 0 || ac > 8) continue;
        const p = b[ar * 9 + ac];
        if (p && side(p) === by && kind(p) === N) return true;
      }
    }
    // 8方向（近接＋飛び駒）
    for (let i = 0; i < 8; i++) {
      const dr = ALL8[i][0], dc = ALL8[i][1];
      let rr = r - dr, cc = c - dc, dist = 1;
      const gi = (dr + 1) * 3 + dc + 1;
      while (rr >= 0 && rr < 9 && cc >= 0 && cc < 9) {
        const p = b[rr * 9 + cc];
        if (p) {
          if (side(p) === by) {
            const k = kind(p);
            if (dist === 1 && STEP_GRID[by][k][gi]) return true;
            if (SLIDE_GRID[by][k][gi]) return true;
          }
          break;
        }
        rr -= dr; cc -= dc; dist++;
      }
    }
    return false;
  }

  function findKing(pos, s) {
    const target = K | (s ? GOTE : 0);
    for (let i = 0; i < 81; i++) if (pos.board[i] === target) return i;
    return -1;
  }

  function inCheck(pos, s = pos.turn) {
    return attacked(pos.board, findKing(pos, s), 1 - s);
  }

  // ---- 指し手生成 ----
  const inZone = (s, r) => (s === 0 ? r <= 2 : r >= 6);
  function mustPromote(k, s, r) {
    if (k === P || k === L) return s === 0 ? r === 0 : r === 8;
    if (k === N) return s === 0 ? r <= 1 : r >= 7;
    return false;
  }

  function pushBoardMove(out, s, k, from, to, captured) {
    const fr = (from / 9) | 0, tr = (to / 9) | 0;
    const canProm = PROMOTE[k] !== undefined && (inZone(s, fr) || inZone(s, tr));
    if (canProm) out.push({ from, to, drop: 0, promote: true, piece: k, captured });
    if (!mustPromote(k, s, tr)) out.push({ from, to, drop: 0, promote: false, piece: k, captured, canPromote: canProm });
  }

  function genPseudo(pos) {
    const out = [], b = pos.board, s = pos.turn;
    for (let sq = 0; sq < 81; sq++) {
      const p = b[sq];
      if (!p || side(p) !== s) continue;
      const k = kind(p), r = (sq / 9) | 0, c = sq % 9;
      for (const [dr, dc] of STEPS[s][k]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr > 8 || cc < 0 || cc > 8) continue;
        const to = rr * 9 + cc, t = b[to];
        if (t && side(t) === s) continue;
        pushBoardMove(out, s, k, sq, to, t);
      }
      for (const [dr, dc] of SLIDES[s][k]) {
        let rr = r + dr, cc = c + dc;
        while (rr >= 0 && rr < 9 && cc >= 0 && cc < 9) {
          const to = rr * 9 + cc, t = b[to];
          if (t && side(t) === s) break;
          pushBoardMove(out, s, k, sq, to, t);
          if (t) break;
          rr += dr; cc += dc;
        }
      }
    }
    // 打つ手
    const hand = pos.hands[s];
    let pawnCols = null;
    for (let k = 1; k <= 7; k++) {
      if (!hand[k]) continue;
      if (k === P) {
        pawnCols = new Array(9).fill(false);
        for (let i = 0; i < 81; i++) if (b[i] === (P | (s ? GOTE : 0))) pawnCols[i % 9] = true;
      }
      for (let to = 0; to < 81; to++) {
        if (b[to]) continue;
        const r = (to / 9) | 0;
        if (mustPromote(k, s, r)) continue;           // 行き所のない駒
        if (k === P && pawnCols[to % 9]) continue;    // 二歩
        out.push({ from: -1, to, drop: k, promote: false, piece: k, captured: 0 });
      }
    }
    return out;
  }

  function makeMove(pos, m) {
    const np = pos.clone(), b = np.board, s = pos.turn, sb = s ? GOTE : 0;
    if (m.drop) {
      b[m.to] = m.drop | sb;
      np.hands[s][m.drop]--;
    } else {
      const cap = b[m.to];
      if (cap) { const ck = kind(cap); np.hands[s][UNPROMOTE[ck] || ck]++; }
      let k = kind(b[m.from]);
      if (m.promote) k = PROMOTE[k];
      b[m.from] = 0;
      b[m.to] = k | sb;
    }
    np.turn = 1 - s;
    np.ply = pos.ply + 1;
    return np;
  }

  // 自玉が取られない手か
  function isSafe(pos, m) {
    const np = makeMove(pos, m);
    return attacked(np.board, findKing(np, pos.turn), 1 - pos.turn) ? null : np;
  }

  // 打ち歩詰め判定を除いた「指せる手が1つでもあるか」
  function hasSafeMove(pos) {
    const ms = genPseudo(pos);
    for (const m of ms) if (isSafe(pos, m)) return true;
    return false;
  }

  function legalMoves(pos) {
    const res = [];
    for (const m of genPseudo(pos)) {
      const np = isSafe(pos, m);
      if (!np) continue;
      // 打ち歩詰め
      if (m.drop === P && inCheck(np) && !hasSafeMove(np)) continue;
      res.push(m);
    }
    return res;
  }

  function hasLegalMove(pos) {
    for (const m of genPseudo(pos)) {
      const np = isSafe(pos, m);
      if (!np) continue;
      if (m.drop === P && inCheck(np) && !hasSafeMove(np)) continue;
      return true;
    }
    return false;
  }

  // ---- USI 表記 ----
  const RANKS = 'abcdefghi';
  const sqToUsi = (sq) => (9 - (sq % 9)) + RANKS[(sq / 9) | 0];
  function usiToSq(str) {
    const f = +str[0], r = RANKS.indexOf(str[1]);
    if (!(f >= 1 && f <= 9) || r < 0) return -1;
    return r * 9 + (9 - f);
  }
  function moveToUsi(m) {
    if (m.drop) return SFEN_CH[m.drop] + '*' + sqToUsi(m.to);
    return sqToUsi(m.from) + sqToUsi(m.to) + (m.promote ? '+' : '');
  }
  function moveFromUsi(pos, usi) {
    if (typeof usi !== 'string') return null;
    usi = usi.trim();
    for (const m of legalMoves(pos)) if (moveToUsi(m) === usi) return m;
    return null;
  }

  // ---- 日本語表記（棋譜） ----
  const ZEN = ['', '１', '２', '３', '４', '５', '６', '７', '８', '９'];
  const KAN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  function moveToKif(pos, m, prevTo) {
    const mark = pos.turn === 0 ? '▲' : '△';
    const dest = m.to === prevTo ? '同　' : ZEN[9 - (m.to % 9)] + KAN[((m.to / 9) | 0) + 1];
    let s = mark + dest + KANJI[m.piece];
    if (m.drop) s += '打';
    else if (m.promote) s += '成';
    else if (m.canPromote) s += '不成';
    return s;
  }

  // ---- 対局（千日手・詰み管理） ----
  class Game {
    constructor(sfen) {
      this.startSfen = sfen || START_SFEN;
      this.pos = fromSfen(this.startSfen);
      this.history = [{ key: this.pos.key(), turn: this.pos.turn, check: false }];
      this.moves = [];
      this.result = null;
    }
    legalMoves() { return legalMoves(this.pos); }
    play(usi) {
      if (this.result) return null;
      const m = typeof usi === 'string' ? moveFromUsi(this.pos, usi) : usi;
      if (!m) return null;
      const prevTo = this.moves.length ? this.moves[this.moves.length - 1].to : -1;
      const kif = moveToKif(this.pos, m, prevTo);
      const np = makeMove(this.pos, m);
      const check = inCheck(np);
      this.pos = np;
      this.history.push({ key: np.key(), turn: np.turn, check });
      const rec = { usi: moveToUsi(m), kif, to: m.to, check };
      this.moves.push(rec);
      this.result = this.evaluate();
      return rec;
    }
    evaluate() {
      const pos = this.pos;
      if (!hasLegalMove(pos)) return { winner: 1 - pos.turn, reason: 'checkmate' };
      const last = this.history[this.history.length - 1];
      const idx = [];
      this.history.forEach((h, i) => { if (h.key === last.key) idx.push(i); });
      if (idx.length >= 4) {
        let senteAll = true, goteAll = true;
        for (let i = idx[0] + 1; i < this.history.length; i++) {
          const mover = this.history[i - 1].turn;
          if (!this.history[i].check) { if (mover === 0) senteAll = false; else goteAll = false; }
        }
        if (senteAll) return { winner: 1, reason: 'perpetual_check' };
        if (goteAll) return { winner: 0, reason: 'perpetual_check' };
        return { winner: -1, reason: 'sennichite' };
      }
      return null;
    }
    sfen() { return toSfen(this.pos); }
    usiPosition() {
      return 'position sfen ' + this.startSfen + (this.moves.length ? ' moves ' + this.moves.map((m) => m.usi).join(' ') : '');
    }
  }

  // ---- perft（テスト用） ----
  function perft(pos, depth) {
    if (depth === 0) return 1;
    const ms = legalMoves(pos);
    if (depth === 1) return ms.length;
    let n = 0;
    for (const m of ms) n += perft(makeMove(pos, m), depth - 1);
    return n;
  }

  return {
    P, L, N, S, G, B, R, K, PP, PL, PN, PS, PB, PR, GOTE,
    PROMOTE, UNPROMOTE, KANJI, KANJI1, START_SFEN,
    side, kind, Position, fromSfen, toSfen, attacked, findKing, inCheck,
    genPseudo, legalMoves, hasLegalMove, makeMove,
    moveToUsi, moveFromUsi, sqToUsi, usiToSq, moveToKif, Game, perft,
  };
});
