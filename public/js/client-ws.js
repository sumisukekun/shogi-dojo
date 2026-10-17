/*
 * client-ws.js — Socket.io クライアント（自動再接続・トークン保持）
 */
(function () {
  'use strict';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 保存不可でも動く */ } },
  };

  class DojoClient {
    constructor() {
      this.socket = io({ transports: ['websocket', 'polling'] });
      this.handlers = {};
      this.me = null;
      this.socket.on('connect', () => this.login());
      ['lobby', 'seeking', 'gameStart', 'move', 'gameEnd', 'chat', 'opponentStatus', 'disconnect']
        .forEach((ev) => this.socket.on(ev, (d) => this.emit(ev, d)));
    }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
    emit(ev, d) { (this.handlers[ev] || []).forEach((fn) => fn(d)); }

    login(name) {
      if (name) store.set('dojo_name', name);
      this.socket.emit('login', { token: store.get('dojo_token'), name: name || store.get('dojo_name') }, (res) => {
        store.set('dojo_token', res.token);
        this.me = res;
        this.emit('login', res);
      });
    }
    savedName() { return store.get('dojo_name') || ''; }
    seek(tc) { this.socket.emit('seek', { tc }); }
    cancelSeek() { this.socket.emit('cancelSeek'); }
    move(gameId, usi) {
      return new Promise((resolve) => this.socket.emit('move', { gameId, usi }, (r) => resolve(r || { ok: false })));
    }
    resign(gameId) { this.socket.emit('resign', { gameId }); }
    chat(room, text) { this.socket.emit('chat', { room, text }); }
    watch(gameId) { return new Promise((resolve) => this.socket.emit('watch', { gameId }, resolve)); }
    unwatch(gameId) { this.socket.emit('unwatch', { gameId }); }
  }

  window.DojoClient = DojoClient;
  window.DojoStore = store;
})();
