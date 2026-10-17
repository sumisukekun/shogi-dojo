/*
 * shogi-ai.js — ブラウザ内 AI マネージャー
 * 1) Fairy-Stockfish（将棋対応 WASM）を優先して使う
 * 2) 使えない環境（古いブラウザ・ヘッダー未設定など）は内蔵AI（ai-worker.js）に自動切替
 * サーバーには一切負荷をかけない。
 */
(function () {
  'use strict';
  const C = window.ShogiCore;

  // レベル 1〜5
  const LEVELS = {
    1: { skill: -10, ms: 300,  label: '入門' },
    2: { skill: -2,  ms: 500,  label: '初級' },
    3: { skill: 5,   ms: 800,  label: '中級' },
    4: { skill: 12,  ms: 1500, label: '上級' },
    5: { skill: 20,  ms: 3000, label: '最強' },
  };

  class AIManager {
    constructor() {
      this.engine = null;      // Fairy-Stockfish
      this.engineName = '内蔵AI';
      this.listeners = [];
      this.worker = null;
      this.reqId = 0;
      this.busy = false;
      this.ready = this.init();
    }

    async init() {
      try {
        if (!window.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') throw new Error('not isolated');
        await loadScript('/engine/stockfish.js');
        const sf = await withTimeout(window.Stockfish(), 15000);
        sf.addMessageListener((line) => this.listeners.slice().forEach((fn) => fn(line)));
        this.engine = sf;
        await this.cmd('usi', (l) => l === 'usiok');
        this.engine.postMessage('setoption name USI_Variant value shogi');
        await this.cmd('isready', (l) => l === 'readyok');
        this.engineName = 'Fairy-Stockfish';
      } catch (e) {
        console.info('[AI] Fairy-Stockfish を使わず内蔵AIで動作:', e.message);
        this.engine = null;
      }
      return this.engineName;
    }

    cmd(text, until, timeout = 15000) {
      return new Promise((resolve, reject) => {
        const fn = (line) => {
          if (until(line)) { this.listeners = this.listeners.filter((f) => f !== fn); clearTimeout(t); resolve(line); }
        };
        const t = setTimeout(() => { this.listeners = this.listeners.filter((f) => f !== fn); reject(new Error('timeout')); }, timeout);
        this.listeners.push(fn);
        this.engine.postMessage(text);
      });
    }

    /**
     * game: ShogiCore.Game  level: 1〜5
     * 戻り値: USI 文字列（合法手）または 'resign'
     */
    async getMove(game, level = 3) {
      await this.ready;
      const lv = LEVELS[level] || LEVELS[3];
      if (this.engine) {
        try {
          this.engine.postMessage('setoption name Skill_Level value ' + lv.skill);
          this.engine.postMessage(game.usiPosition());
          const line = await this.cmd('go movetime ' + lv.ms, (l) => l.startsWith('bestmove'), lv.ms + 10000);
          const mv = line.split(/\s+/)[1];
          if (mv === 'resign' || mv === 'win') return 'resign';
          if (C.moveFromUsi(game.pos, mv)) return mv;
          console.warn('[AI] エンジンの手が不正のため内蔵AIへ:', mv);
        } catch (e) {
          console.warn('[AI] エンジン応答なし → 内蔵AIへ', e);
        }
      }
      return this.workerMove(game, level, lv.ms + 700);
    }

    workerMove(game, level, timeMs) {
      if (!this.worker) this.worker = new Worker('/js/ai-worker.js');
      const id = ++this.reqId;
      return new Promise((resolve) => {
        const fn = (e) => {
          if (e.data.id !== id) return;
          this.worker.removeEventListener('message', fn);
          resolve(e.data.move);
        };
        this.worker.addEventListener('message', fn);
        this.worker.postMessage({ id, sfen: game.startSfen, moves: game.moves.map((m) => m.usi), level, timeMs });
      });
    }

    stop() { if (this.engine) this.engine.postMessage('stop'); }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('load failed ' + src));
      document.head.appendChild(s);
    });
  }
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  }

  window.ShogiAI = { AIManager, LEVELS };
})();
