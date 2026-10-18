/*
 * client-ws.js — Socket.io クライアント（自動再接続・トークン保持）
 */
(function () {
  'use strict';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 保存不可でも動く */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* noop */ } },
  };

  class DojoClient {
    constructor() {
      this.socket = io({ transports: ['websocket', 'polling'] });
      this.handlers = {};
      this.me = null;
      this.socket.on('connect', () => this.login());
      ['lobby', 'seeking', 'gameStart', 'move', 'gameEnd', 'chat', 'opponentStatus', 'disconnect', 'rematchOffer', 'kicked']
        .forEach((ev) => this.socket.on(ev, (d) => this.emit(ev, d)));
    }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
    emit(ev, d) { (this.handlers[ev] || []).forEach((fn) => fn(d)); }
    call(ev, d) { return new Promise((resolve) => this.socket.emit(ev, d, (r) => resolve(r || {}))); }

    async login(name) {
      const res = await this.call('login', { token: store.get('dojo_token'), name: name || store.get('dojo_name') });
      if (res.error) return res;
      store.set('dojo_token', res.token);
      store.set('dojo_name', res.name);
      this.me = res;
      this.emit('login', res);
      return res;
    }
    /** 引き継ぎコードで別端末のアカウントに切り替える */
    async transfer(code) {
      const res = await this.call('login', { token: String(code || '').trim(), transfer: true });
      if (res.error) return res;
      store.set('dojo_token', res.token);
      store.set('dojo_name', res.name);
      this.me = res;
      this.emit('login', res);
      return res;
    }
    token() { return store.get('dojo_token') || ''; }
    savedName() { return store.get('dojo_name') || ''; }
    seek(tc, rated) { this.socket.emit('seek', { tc, rated }); }
    cancelSeek() { this.socket.emit('cancelSeek'); }
    move(gameId, usi, ply) { return this.call('move', { gameId, usi, ply }); }
    declare(gameId) { return this.call('declare', { gameId }); }
    resign(gameId) { this.socket.emit('resign', { gameId }); }
    rematch(gameId) { return this.call('rematch', { gameId }); }
    createPrivate(tc) { return this.call('createPrivate', { tc }); }
    joinPrivate(code) { return this.call('joinPrivate', { code }); }
    chat(room, text) { this.socket.emit('chat', { room, text }); }
    report(name, room, text) { return this.call('report', { name, room, text }); }
    watch(gameId) { return new Promise((resolve) => this.socket.emit('watch', { gameId }, resolve)); }
    unwatch(gameId) { this.socket.emit('unwatch', { gameId }); }
  }

  window.DojoClient = DojoClient;
  window.DojoStore = store;
})();
