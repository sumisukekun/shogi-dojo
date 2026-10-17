/*
 * shogi-ui.js — 盤・持ち駒の描画と操作
 * new ShogiBoardUI(rootEl, { onMove(usi) }) → setGame(game, { perspective, interactive })
 */
(function () {
  'use strict';
  const C = window.ShogiCore;
  const ZEN = ['', '１', '２', '３', '４', '５', '６', '７', '８', '９'];
  const KAN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const HAND_ORDER = [7, 6, 5, 4, 3, 2, 1];

  class ShogiBoardUI {
    constructor(root, opts) {
      this.root = root;
      this.onMove = opts.onMove || (() => {});
      this.game = null;
      this.perspective = 0;       // 0=先手が手前
      this.mySide = -1;           // 操作できる側（-1=観戦）
      this.interactive = false;
      this.sel = null;            // { from } または { drop }
      this.targets = new Map();   // to -> [moves]
      this.build();
    }

    build() {
      this.root.innerHTML = `
        <div class="hand hand-top" data-pos="top"></div>
        <div class="board-wrap">
          <div class="files"></div>
          <div class="board-row"><div class="board"></div><div class="ranks"></div></div>
        </div>
        <div class="hand hand-bottom" data-pos="bottom"></div>
        <div class="promo" hidden><div class="promo-box"><p>成りますか？</p>
          <button data-p="1" class="btn btn-primary">成る</button><button data-p="0" class="btn">成らない</button></div></div>`;
      this.boardEl = this.root.querySelector('.board');
      this.filesEl = this.root.querySelector('.files');
      this.ranksEl = this.root.querySelector('.ranks');
      this.handTop = this.root.querySelector('.hand-top');
      this.handBottom = this.root.querySelector('.hand-bottom');
      this.promoEl = this.root.querySelector('.promo');
      this.cells = [];
      for (let i = 0; i < 81; i++) {
        const d = document.createElement('div');
        d.className = 'sq';
        this.boardEl.appendChild(d);
        this.cells.push(d);
      }
      this.boardEl.addEventListener('click', (e) => {
        const cell = e.target.closest('.sq');
        if (cell) this.clickSquare(+cell.dataset.sq);
      });
      [this.handTop, this.handBottom].forEach((h) => h.addEventListener('click', (e) => {
        const p = e.target.closest('.hp');
        if (p) this.clickHand(+p.dataset.side, +p.dataset.kind);
      }));
    }

    setGame(game, { perspective = 0, mySide = -1, interactive = false } = {}) {
      this.game = game;
      this.perspective = perspective;
      this.mySide = mySide;
      this.interactive = interactive;
      this.clearSel();
      this.render();
    }
    setInteractive(v) { this.interactive = v; if (!v) this.clearSel(); this.render(); }
    flip() { this.perspective ^= 1; this.render(); }

    canAct() {
      return this.interactive && this.game && !this.game.result && this.game.pos.turn === this.mySide;
    }

    clearSel() { this.sel = null; this.targets = new Map(); }

    clickSquare(sq) {
      if (!this.canAct()) return;
      const pos = this.game.pos;
      if (this.sel && this.targets.has(sq)) return this.choose(this.targets.get(sq));
      const p = pos.board[sq];
      if (p && C.side(p) === pos.turn && !(this.sel && this.sel.from === sq)) {
        this.sel = { from: sq };
        this.targets = new Map();
        for (const m of this.game.legalMoves()) if (m.from === sq) {
          if (!this.targets.has(m.to)) this.targets.set(m.to, []);
          this.targets.get(m.to).push(m);
        }
      } else this.clearSel();
      this.render();
    }

    clickHand(side, kind) {
      if (!this.canAct() || side !== this.game.pos.turn) return;
      if (this.sel && this.sel.drop === kind) { this.clearSel(); return this.render(); }
      this.sel = { drop: kind };
      this.targets = new Map();
      for (const m of this.game.legalMoves()) if (m.drop === kind) this.targets.set(m.to, [m]);
      this.render();
    }

    choose(moves) {
      const done = (m) => { this.clearSel(); this.render(); this.onMove(C.moveToUsi(m)); };
      if (moves.length === 1) return done(moves[0]);
      // 成・不成の選択
      this.promoEl.hidden = false;
      this.promoEl.onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) { this.promoEl.hidden = true; this.clearSel(); return this.render(); }
        this.promoEl.hidden = true;
        done(moves.find((m) => m.promote === (b.dataset.p === '1')));
      };
    }

    render() {
      if (!this.game) return;
      const pos = this.game.pos, flip = this.perspective === 1;
      const last = this.game.moves.length ? this.game.moves[this.game.moves.length - 1].to : -1;
      const checkSq = C.inCheck(pos) ? C.findKing(pos, pos.turn) : -1;
      // 座標
      const files = [9, 8, 7, 6, 5, 4, 3, 2, 1], ranks = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      if (flip) { files.reverse(); ranks.reverse(); }
      this.filesEl.innerHTML = files.map((f) => `<span>${ZEN[f]}</span>`).join('');
      this.ranksEl.innerHTML = ranks.map((r) => `<span>${KAN[r]}</span>`).join('');
      // 盤
      for (let i = 0; i < 81; i++) {
        const sq = flip ? 80 - i : i;
        const cell = this.cells[i];
        cell.dataset.sq = sq;
        const p = pos.board[sq];
        let cls = 'sq';
        if (sq === last) cls += ' last';
        if (this.sel && this.sel.from === sq) cls += ' sel';
        if (this.targets.has(sq)) cls += p ? ' target cap' : ' target';
        if (sq === checkSq) cls += ' check';
        cell.className = cls;
        if (p) {
          const k = C.kind(p), s = C.side(p);
          const name = k === C.K ? (s === 0 ? '玉' : '王') : C.KANJI1[k];
          const away = (s === 1) !== flip;
          cell.innerHTML = `<span class="pc${away ? ' away' : ''}${k >= 9 ? ' prom' : ''}">${name}</span>`;
        } else cell.innerHTML = '';
      }
      // 持ち駒（手前＝perspective 側）
      this.renderHand(this.handBottom, this.perspective, false);
      this.renderHand(this.handTop, 1 - this.perspective, true);
    }

    renderHand(el, side, away) {
      const h = this.game.pos.hands[side];
      const items = HAND_ORDER.filter((k) => h[k] > 0).map((k) => {
        const sel = this.sel && this.sel.drop === k && side === this.game.pos.turn ? ' sel' : '';
        return `<button class="hp${sel}" data-side="${side}" data-kind="${k}"><span class="pc${away ? ' away' : ''}">${C.KANJI1[k]}</span>${h[k] > 1 ? `<small>${h[k]}</small>` : ''}</button>`;
      });
      el.innerHTML = `<span class="hand-label">${side === 0 ? '☗先手' : '☖後手'}</span>` + (items.join('') || '<span class="hand-none">持ち駒なし</span>');
    }
  }

  window.ShogiBoardUI = ShogiBoardUI;
})();
