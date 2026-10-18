/*
 * analysis.js — AI感想戦の判定と解説文（エンジンの解析結果だけを根拠にする）
 * ブラウザ（window.ShogiAnalysis）と Node.js（テスト用）の両方で動く。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./shogi-core.js'));
  else root.ShogiAnalysis = factory(root.ShogiCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  // 評価値 → 先手の勝率（将棋でよく使われる換算。600 で約73%）
  const winRate = (cp) => 1 / (1 + Math.exp(-cp / 600));
  const pct = (x) => Math.round(x * 100);

  const LABELS = {
    blunder: { name: '悪手', mark: '？？', cls: 'blunder' },
    mistake: { name: '疑問手', mark: '？', cls: 'mistake' },
    inaccuracy: { name: '緩手', mark: '？！', cls: 'inaccuracy' },
    best: { name: '最善手', mark: '◎', cls: 'best' },
    good: { name: '好手', mark: '！', cls: 'good' },
  };

  function kifSeq(startSfen, before, usis) {
    const g = new C.Game(startSfen);
    before.forEach((u) => g.play(u));
    const out = [];
    for (const u of usis) { const r = g.play(u); if (!r) break; out.push(r.kif); }
    return out;
  }

  /**
   * evals: analyze() の結果（局面数 = 手数+1）
   * 戻り値: { moves: [...各手の判定], decisive: 勝敗を分けた手の index, summary }
   */
  function review(startSfen, usiMoves, evals, result) {
    const g = new C.Game(startSfen);
    const items = [];
    const startTurn = g.pos.turn;
    for (let i = 0; i < usiMoves.length; i++) {
      const mover = (startTurn + i) % 2;
      const before = evals[i], after = evals[i + 1];
      if (!before || !after) break;
      const rec = g.play(usiMoves[i]);
      if (!rec) break;
      const wrB = mover === 0 ? winRate(before.score) : 1 - winRate(before.score);
      const wrA = mover === 0 ? winRate(after.score) : 1 - winRate(after.score);
      const loss = wrB - wrA;
      const isBest = before.best === usiMoves[i];
      let label = null;
      if (!isBest && loss >= 0.25) label = 'blunder';
      else if (!isBest && loss >= 0.12) label = 'mistake';
      else if (!isBest && loss >= 0.06) label = 'inaccuracy';
      // 好手：最善手で、しかも形勢が大きく動く局面（他の手なら損をしやすい難所）を正しく指した
      else if (isBest && wrB > 0.15 && wrB < 0.85 && wrA - wrB >= 0.05) label = 'good';
      else if (isBest) label = 'best';
      const bestKif = before.best ? kifSeq(startSfen, usiMoves.slice(0, i), [before.best])[0] : null;
      const pvKif = kifSeq(startSfen, usiMoves.slice(0, i), before.pv || []);
      items.push({
        ply: i + 1, mover, kif: rec.kif, usi: usiMoves[i], label,
        wrBefore: wrB, wrAfter: wrA, loss,
        scoreAfter: after.score, mateAfter: after.mate,
        best: before.best, bestKif, pvKif,
        text: explain(rec.kif, mover, label, wrB, wrA, bestKif, pvKif, isBest, after),
      });
    }
    // 勝敗を分けた一手：負けた側（引き分けなら両者）の最大の損
    let decisive = -1, worst = 0;
    const loser = result && result.winner >= 0 ? 1 - result.winner : -1;
    items.forEach((it, idx) => { if ((loser < 0 || it.mover === loser) && it.loss > worst) { worst = it.loss; decisive = idx; } });
    if (worst < 0.1) decisive = -1;
    const count = (side, lab) => items.filter((it) => it.mover === side && it.label === lab).length;
    const summary = [0, 1].map((s) => ({
      blunder: count(s, 'blunder'), mistake: count(s, 'mistake'), inaccuracy: count(s, 'inaccuracy'),
      best: count(s, 'best') + count(s, 'good'), good: count(s, 'good'),
      moves: items.filter((it) => it.mover === s).length,
      // 一致率：エンジンの最善手と同じ手を指した割合
      match: Math.round(100 * (count(s, 'best') + count(s, 'good')) / Math.max(1, items.filter((it) => it.mover === s).length)),
    }));
    return { moves: items, decisive, summary };
  }

  function explain(kif, mover, label, wrB, wrA, bestKif, pvKif, isBest, after) {
    const who = mover === 0 ? '先手' : '後手';
    const wrTxt = `${who}の勝率 ${pct(wrB)}% → ${pct(wrA)}%`;
    const pv = pvKif.length ? `（読み筋：${pvKif.slice(0, 6).join(' ')}）` : '';
    if (after.mate !== null && after.mate !== undefined && after.mate !== 0) {
      const winSide = after.mate > 0 ? '先手' : '後手';
      if (!isBest && bestKif && ((mover === 0) !== (after.mate > 0))) {
        return `${kif}で、${winSide}に${Math.abs(after.mate)}手以内の詰みが生じました。最善は${bestKif}${pv}。`;
      }
    }
    switch (label) {
      case 'blunder': return `${kif}は悪手です。${wrTxt}。この局面の最善は${bestKif}でした${pv}。`;
      case 'mistake': return `${kif}は疑問手です。${wrTxt}。${bestKif}のほうが良かったと考えられます${pv}。`;
      case 'inaccuracy': return `${kif}はやや緩い手です。${wrTxt}。候補は${bestKif}${pv}。`;
      case 'good': return `${kif}は好手です。AIの最善手と一致し、${wrTxt}と形勢を良くしました。`;
      case 'best': return `${kif}はAIの最善手と一致しています。${wrTxt}。`;
      default: return `${kif}。${wrTxt}。`;
    }
  }

  return { review, winRate, LABELS };
});
