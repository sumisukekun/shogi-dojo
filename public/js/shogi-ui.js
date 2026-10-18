/*
 * shogi-ui.js — 盤・持ち駒の描画と操作（タップでもドラッグでも指せる）
 * new ShogiBoardUI(rootEl, { onMove(usi) }) → setGame(game, { perspective, mySide, interactive })
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
      this.perspective = 0;
      this.mySide = -1;
      this.interactive = false;
      this.sel = null;
      this.targets = new Map();
      this.marks = null;          // 解析用の矢印など { from, to }
      this.build();
    }

    build() {
      this.root.innerHTML = `
        <div class="hand hand-top"></div>
        <div class="board-wrap">
          <div class="files"></div>
          <div class="board-row"><div class="board"><svg class="arrow" viewBox="0 0 900 900" aria-hidden="true"></svg></div><div class="ranks"></div></div>
        </div>
        <div class="hand hand-bottom"></div>
        <div class="promo" hidden><div class="promo-box"><p>成りますか？</p>
          <div class="promo-choices"><button data-p="1" class="pc-btn"></button><button data-p="0" class="pc-btn"></button></div>
          <button class="btn btn-small promo-cancel">やめる</button></div></div>`;
      this.boardEl = this.root.querySelector('.board');
      this.arrowEl = this.root.querySelector('.arrow');
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
      this.root.addEventListener('pointerdown', (e) => this.onDown(e));
      window.addEventListener('pointermove', (e) => this.onDragMove(e));
      window.addEventListener('pointerup', (e) => this.onUp(e));
      window.addEventListener('pointercancel', () => this.endDrag());
    }

    setGame(game, { perspective = 0, mySide = -1, interactive = false } = {}) {
      this.game = game;
      this.perspective = perspective;
      this.mySide = mySide;
      this.interactive = interactive;
      this.marks = null;
      this.clearSel();
      this.render();
    }
    setInteractive(v) { this.interactive = v; if (!v) this.clearSel(); this.render(); }
    setMarks(m) { this.marks = m; this.renderArrow(); }
    flip() { this.perspective ^= 1; this.render(); }

    canAct() {
      return this.interactive && this.game && !this.game.result && this.game.pos.turn === this.mySide;
    }
    clearSel() { this.sel = null; this.targets = new Map(); }

    // ---- 操作（タップ・ドラッグ共通） ----
    onDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      const cell = e.target.closest('.sq');
      const hp = e.target.closest('.hp');
      if (!cell && !hp) return;
      if (!this.canAct()) return;
      if (hp) {
        const side = +hp.dataset.side, kind = +hp.dataset.kind;
        if (side !== this.game.pos.turn) return;
        const already = this.sel && this.sel.drop === kind;
        this.selectDrop(kind);
        this.startDrag(e, hp, already);
      } else {
        const sq = +cell.dataset.sq;
        if (this.sel && this.targets.has(sq)) { this.choose(this.targets.get(sq)); return; }
        const p = this.game.pos.board[sq];
        if (p && C.side(p) === this.game.pos.turn) {
          const already = this.sel && this.sel.from === sq;
          this.selectFrom(sq);
          this.startDrag(e, cell, already);
        } else { this.clearSel(); this.render(); }
      }
      e.preventDefault();
    }

    selectFrom(sq) {
      this.sel = { from: sq };
      this.targets = new Map();
      for (const m of this.game.legalMoves()) if (m.from === sq) {
        if (!this.targets.has(m.to)) this.targets.set(m.to, []);
        this.targets.get(m.to).push(m);
      }
      this.render();
    }
    selectDrop(kind) {
      this.sel = { drop: kind };
      this.targets = new Map();
      for (const m of this.game.legalMoves()) if (m.drop === kind) this.targets.set(m.to, [m]);
      this.render();
    }

    startDrag(e, el, wasSelected) {
      const pc = el.querySelector('.pc');
      if (!pc) return;
      this.drag = { x0: e.clientX, y0: e.clientY, moved: false, wasSelected, src: pc, ghost: null, pointerId: e.pointerId };
    }
    onDragMove(e) {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
      if (!d.moved) {
        d.moved = true;
        const r = d.src.getBoundingClientRect();
        d.ghost = d.src.cloneNode(true);
        d.ghost.classList.add('ghost');
        d.ghost.style.width = r.width + 'px'; d.ghost.style.height = r.height + 'px';
        document.body.appendChild(d.ghost);
        d.src.classList.add('lifted');
      }
      d.ghost.style.left = e.clientX + 'px';
      d.ghost.style.top = e.clientY + 'px';
      const over = document.elementFromPoint(e.clientX, e.clientY);
      const cell = over && over.closest && over.closest('.sq');
      this.cells.forEach((c) => c.classList.toggle('hover', c === cell && this.targets.has(+c.dataset.sq)));
    }
    onUp(e) {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) return;
      if (d.moved) {
        if (d.ghost) d.ghost.style.display = 'none';
        const over = document.elementFromPoint(e.clientX, e.clientY);
        const cell = over && over.closest && over.closest('.sq');
        this.endDrag();
        if (cell && this.targets.has(+cell.dataset.sq)) return this.choose(this.targets.get(+cell.dataset.sq));
        this.render();
      } else {
        this.endDrag();
        if (d.wasSelected) { this.clearSel(); this.render(); } // もう一度タップで選択解除
      }
    }
    endDrag() {
      const d = this.drag;
      if (!d) return;
      if (d.ghost) d.ghost.remove();
      if (d.src) d.src.classList.remove('lifted');
      this.cells.forEach((c) => c.classList.remove('hover'));
      this.drag = null;
    }

    choose(moves) {
      const done = (m) => { this.clearSel(); this.render(); this.onMove(C.moveToUsi(m)); };
      if (moves.length === 1) return done(moves[0]);
      // 成・不成を駒の絵で選ぶ
      const base = moves[0].piece, side = this.game.pos.turn;
      const away = (side === 1) !== (this.perspective === 1);
      const [bp, bn] = this.promoEl.querySelectorAll('.pc-btn');
      bp.innerHTML = `<span class="pc${away ? ' away' : ''} prom">${C.KANJI1[C.PROMOTE[base]]}</span><small>成る</small>`;
      bn.innerHTML = `<span class="pc${away ? ' away' : ''}">${C.KANJI1[base]}</span><small>成らない</small>`;
      this.promoEl.hidden = false;
      this.promoEl.onclick = (e) => {
        const b = e.target.closest('[data-p]');
        if (!b && !e.target.closest('.promo-cancel')) return;
        this.promoEl.hidden = true;
        if (!b) { this.clearSel(); return this.render(); }
        done(moves.find((m) => m.promote === (b.dataset.p === '1')));
      };
    }

    // ---- 描画 ----
    render() {
      if (!this.game) return;
      const pos = this.game.pos, flip = this.perspective === 1;
      const last = this.game.moves.length ? this.game.moves[this.game.moves.length - 1].to : -1;
      const checkSq = C.inCheck(pos) ? C.findKing(pos, pos.turn) : -1;
      const files = [9, 8, 7, 6, 5, 4, 3, 2, 1], ranks = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      if (flip) { files.reverse(); ranks.reverse(); }
      this.filesEl.innerHTML = files.map((f) => `<span>${ZEN[f]}</span>`).join('');
      this.ranksEl.innerHTML = ranks.map((r) => `<span>${KAN[r]}</span>`).join('');
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
      this.renderHand(this.handBottom, this.perspective, false);
      this.renderHand(this.handTop, 1 - this.perspective, true);
      this.renderArrow();
    }

    renderHand(el, side, away) {
      const h = this.game.pos.hands[side];
      const turn = !this.game.result && this.game.pos.turn === side;
      const items = HAND_ORDER.filter((k) => h[k] > 0).map((k) => {
        const sel = this.sel && this.sel.drop === k && side === this.game.pos.turn ? ' sel' : '';
        return `<button class="hp${sel}" data-side="${side}" data-kind="${k}" aria-label="持ち駒 ${C.KANJI[k]} ${h[k]}枚"><span class="pc${away ? ' away' : ''}">${C.KANJI1[k]}</span>${h[k] > 1 ? `<small>${h[k]}</small>` : ''}</button>`;
      });
      el.classList.toggle('turn', turn);
      el.innerHTML = `<span class="hand-label">${side === 0 ? '☗' : '☖'}</span>` + (items.join('') || '<span class="hand-none">なし</span>');
    }

    // 解析の最善手などを矢印で表示
    renderArrow() {
      const m = this.marks;
      if (!m || m.to === undefined) { this.arrowEl.innerHTML = ''; return; }
      const flip = this.perspective === 1;
      const xy = (sq) => { const i = flip ? 80 - sq : sq; return [(i % 9) * 100 + 50, ((i / 9) | 0) * 100 + 50]; };
      const [x2, y2] = xy(m.to);
      let body;
      if (m.from >= 0) {
        const [x1, y1] = xy(m.from);
        const ang = Math.atan2(y2 - y1, x2 - x1), len = Math.hypot(x2 - x1, y2 - y1) - 28;
        const ex = x1 + Math.cos(ang) * len, ey = y1 + Math.sin(ang) * len;
        body = `<line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}"/><polygon points="${x2},${y2} ${ex + Math.cos(ang + 1.9) * 26},${ey + Math.sin(ang + 1.9) * 26} ${ex + Math.cos(ang - 1.9) * 26},${ey + Math.sin(ang - 1.9) * 26}"/>`;
      } else body = `<circle cx="${x2}" cy="${y2}" r="40" fill="none"/>`;
      this.arrowEl.innerHTML = `<g class="arrow-${m.kind || 'best'}">${body}</g>`;
    }
  }

  window.ShogiBoardUI = ShogiBoardUI;
})();
