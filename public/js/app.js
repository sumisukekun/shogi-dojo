/*
 * app.js — 画面の流れ（ロビー / 人間対局 / AI対局 / 観戦）
 */
(function () {
  'use strict';
  const C = window.ShogiCore;
  const $ = (id) => document.getElementById(id);
  const REASON = {
    checkmate: '詰み', resign: '投了', timeout: '時間切れ', disconnect: '接続切れ',
    sennichite: '千日手', perpetual_check: '連続王手の千日手',
  };

  const client = new DojoClient();
  const ai = new ShogiAI.AIManager();
  const ui = new ShogiBoardUI($('board'), { onMove: onLocalMove });

  const st = {
    mode: 'lobby',          // lobby | human | ai | watch
    game: null, gameId: null, mySide: -1,
    names: ['', ''], ratings: [null, null],
    clock: null, clockOffset: 0,
    aiLevel: 3, aiThinking: false,
    seeking: false, batonTimer: null,
    tcs: {}, pending: false,
  };

  // ---------- 共通 ----------
  let toastTimer;
  function toast(msg, ms = 3000) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
  }
  function showRoom(on) {
    $('lobby').hidden = on; $('room').hidden = !on;
    window.scrollTo(0, 0);
  }
  function addChat(boxId, name, text, sys) {
    const box = $(boxId), line = document.createElement('div');
    if (sys) { line.className = 'sys'; line.textContent = text; }
    else { const b = document.createElement('b'); b.textContent = name + '：'; line.append(b, document.createTextNode(text)); }
    box.appendChild(line);
    while (box.children.length > 200) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  // ---------- ログイン・ロビー ----------
  $('name').value = client.savedName();
  $('saveName').onclick = () => { const n = $('name').value.trim(); if (n) { client.login(n); toast('名前を変更しました'); } };

  client.on('login', (res) => {
    $('me').innerHTML = '';
    const b = document.createElement('b'); b.textContent = res.name;
    $('me').append(b, document.createTextNode(' R' + res.rating));
    if (!$('name').value) $('name').value = res.name;
    renderMe(res);
    renderLobby(res.lobby);
    if (res.resume) { toast('対局に復帰しました'); enterOnline(res.resume, 'human'); }
  });
  client.on('disconnect', () => { $('online').textContent = '再接続中…'; });
  client.on('lobby', renderLobby);

  function renderMe(res) {
    const n = res.wins + res.losses + res.draws;
    $('myStats').innerHTML = '';
    const b = document.createElement('b'); b.textContent = 'R' + res.rating;
    $('myStats').append(b, document.createTextNode(` ・ ${n}局 ${res.wins}勝 ${res.losses}敗` + (res.draws ? ` ${res.draws}分` : '')));
    const list = $('myGames');
    list.innerHTML = '';
    if (!res.recent || !res.recent.length) { list.innerHTML = '<li class="empty">まだ対局がありません</li>'; return; }
    res.recent.forEach((g) => {
      const li = document.createElement('li');
      const mine = g.my_side;
      const r = g.winner === -1 ? '分' : g.winner === mine ? '勝' : '負';
      const s = document.createElement('span');
      const mark = document.createElement('b'); mark.className = r === '勝' ? 'win' : r === '負' ? 'lose' : ''; mark.textContent = r + ' ';
      s.append(mark, document.createTextNode(`☗${g.sente_name} 対 ☖${g.gote_name}`));
      const sm = document.createElement('small'); sm.textContent = `${g.ply}手 ${REASON[g.reason] || ''}`;
      li.append(s, sm);
      li.title = '棋譜を再生';
      li.onclick = () => openReplay(g.id);
      list.appendChild(li);
    });
  }

  function renderLobby(l) {
    if (!l) return;
    const rk = $('ranking');
    if (l.ranking && l.ranking.length) {
      rk.innerHTML = '';
      l.ranking.forEach((p) => {
        const li = document.createElement('li');
        const r = document.createElement('span'); r.className = 'r'; r.textContent = `R${p.rating}`;
        li.append(document.createTextNode(`${p.name}　${p.wins}勝${p.losses}敗`), r);
        rk.appendChild(li);
      });
    }
    $('online').textContent = `オンライン ${l.online}人 ・ 対局中 ${l.games.length}局`;
    st.tcs = l.timeControls;
    const sel = $('tc');
    if (!sel.options.length) {
      Object.entries(l.timeControls).forEach(([k, v]) => sel.add(new Option(v.label, k)));
      sel.value = (DojoStore.get('dojo_tc')) || 'hayasashi';
    }
    [...sel.options].forEach((o) => {
      const n = l.seeks[o.value] || 0;
      o.textContent = st.tcs[o.value].label + (n ? `（${n}人待ち）` : '');
    });
    const list = $('gameList');
    list.innerHTML = '';
    if (!l.games.length) list.innerHTML = '<li class="empty">いまは対局がありません</li>';
    l.games.forEach((g) => {
      const li = document.createElement('li');
      const s = document.createElement('span'); s.textContent = `☗${g.sente} 対 ☖${g.gote}`;
      const sm = document.createElement('small'); sm.textContent = `${(st.tcs[g.tc] || {}).label || ''} ${g.ply}手`;
      li.append(s, sm);
      li.onclick = () => watchGame(g.id);
      list.appendChild(li);
    });
  }

  // ---------- 対局待ち（AIバトンタッチ付き） ----------
  $('seekBtn').onclick = () => {
    const tc = $('tc').value;
    DojoStore.set('dojo_tc', tc);
    client.seek(tc);
  };
  $('cancelSeek').onclick = () => { client.cancelSeek(); setSeeking(false); };
  client.on('seeking', () => {
    setSeeking(true);
    if ($('baton').checked) {
      st.batonTimer = setTimeout(() => {
        if (st.seeking && st.mode === 'lobby') { toast('相手を待つ間、AIと練習します。見つかったら自動で切り替えます', 4000); startAI(true); }
      }, 8000);
    }
  });
  function setSeeking(on) {
    st.seeking = on;
    $('waiting').hidden = !on; $('seekBtn').disabled = on;
    clearTimeout(st.batonTimer);
    updateInfo();
  }

  // ---------- 人間との対局・観戦 ----------
  client.on('gameStart', (d) => {
    setSeeking(false);
    if (st.mode === 'ai') { ai.stop(); toast('対戦相手が見つかりました！ 対局を開始します', 4000); }
    enterOnline(d, 'human');
  });

  function enterOnline(d, mode) {
    st.mode = mode;
    st.game = new C.Game(d.startSfen);
    d.moves.forEach((m) => st.game.play(m.usi));
    st.gameId = d.id; st.mySide = d.you;
    st.names = d.names; st.ratings = d.ratings;
    setClock(d.clock);
    $('gameChat').innerHTML = '';
    addChat('gameChat', '', mode === 'watch' ? '観戦を始めました' : `対局開始：あなたは${d.you === 0 ? '先手☗' : '後手☖'}です。よろしくお願いします。`, true);
    ui.setGame(st.game, { perspective: d.you === 1 ? 1 : 0, mySide: d.you, interactive: mode === 'human' });
    showRoom(true);
    if (d.result) st.game.result = d.result;
    refresh();
  }

  async function watchGame(id) {
    const d = await client.watch(id);
    if (!d) return toast('この対局は終了しました');
    enterOnline(d, 'watch');
  }

  client.on('move', (d) => {
    if (d.id !== st.gameId || (st.mode !== 'human' && st.mode !== 'watch')) return;
    if (!st.game.play(d.usi)) return; // 二重受信は無視
    st.pending = false;
    setClock(d.clock);
    ui.setInteractive(st.mode === 'human');
    refresh();
  });

  client.on('gameEnd', (d) => {
    if (d.id !== st.gameId || st.mode === 'ai' || st.mode === 'lobby') return;
    st.game.result = d.result;
    setClock(d.clock);
    ui.setInteractive(false);
    refresh();
    showResult(d.result);
    client.login(); // レーティング表示を更新
  });

  client.on('opponentStatus', (d) => {
    if (d.connected) toast('相手が再接続しました');
    else toast(`相手の接続が切れました。${Math.round(d.limit / 1000)}秒以内に戻らなければあなたの勝ちです`, 5000);
  });

  client.on('chat', (d) => {
    if (d.room === 'lobby') addChat('lobbyChat', d.name, d.text, d.system);
    else if (String(d.room) === String(st.gameId)) addChat('gameChat', d.name, d.text, d.system);
  });
  document.querySelectorAll('.chat-form').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = f.querySelector('input'), text = inp.value.trim();
    if (!text) return;
    const room = f.dataset.room === 'lobby' ? 'lobby' : st.gameId;
    if (room) client.chat(room, text);
    inp.value = '';
  }));

  // ---------- AI 対局 ----------
  ai.ready.then((name) => { $('aiEngine').textContent = `（使用エンジン：${name}）`; });
  $('aiBtn').onclick = () => startAI(false);

  function startAI(fromBaton) {
    st.mode = 'ai';
    st.aiLevel = +$('aiLevel').value;
    const sv = $('aiSide').value;
    st.mySide = sv === 'r' ? (Math.random() < 0.5 ? 0 : 1) : +sv;
    st.game = new C.Game();
    st.gameId = null; st.clock = null;
    const lv = ShogiAI.LEVELS[st.aiLevel].label;
    st.names = st.mySide === 0 ? ['あなた', 'AI・' + lv] : ['AI・' + lv, 'あなた'];
    st.ratings = [null, null];
    $('gameChat').innerHTML = '';
    addChat('gameChat', '', fromBaton ? '対戦相手を待つ間のAI練習です。相手が見つかると自動で切り替わります。' : 'AIとの練習対局です（持ち時間なし）。', true);
    ui.setGame(st.game, { perspective: st.mySide, mySide: st.mySide, interactive: true });
    showRoom(true);
    refresh();
    if (st.game.pos.turn !== st.mySide) aiTurn();
  }

  async function aiTurn() {
    const g = st.game;
    st.aiThinking = true; updateInfo();
    const mv = await ai.getMove(g, st.aiLevel);
    st.aiThinking = false;
    if (st.mode !== 'ai' || st.game !== g || g.result) return; // 途中で切り替わった
    if (mv === 'resign') g.result = { winner: st.mySide, reason: 'resign' };
    else g.play(mv);
    refresh();
    if (g.result) showResult(g.result);
  }

  // ---------- 棋譜再生 ----------
  async function openReplay(id) {
    let d;
    try { const r = await fetch('/api/games/' + id); if (!r.ok) throw 0; d = await r.json(); }
    catch (e) { return toast('棋譜を読み込めませんでした'); }
    st.mode = 'replay';
    st.replay = { start: d.start_sfen, moves: d.moves ? d.moves.split(' ') : [], result: d.winner === null ? null : { winner: d.winner, reason: d.reason } };
    st.names = [d.sente_name, d.gote_name];
    st.ratings = [d.sente_rating, d.gote_rating];
    st.clock = null; st.gameId = null; st.mySide = -1;
    showRoom(true);
    replayTo(st.replay.moves.length);
  }
  function replayTo(n) {
    const rp = st.replay;
    n = Math.max(0, Math.min(rp.moves.length, n));
    const g = new C.Game(rp.start);
    for (let i = 0; i < n; i++) g.play(rp.moves[i]);
    rp.idx = n;
    rp.kifs = rp.kifs || (() => { const t = new C.Game(rp.start); return rp.moves.map((u) => (t.play(u) || {}).kif); })();
    if (n === rp.moves.length && rp.result) g.result = rp.result;
    const persp = ui.game && st.mode === 'replay' ? ui.perspective : 0;
    st.game = g;
    ui.setGame(g, { perspective: persp, mySide: -1, interactive: false });
    $('replayPos').textContent = `${n} / ${rp.moves.length}手`;
    refresh();
  }
  $('replayNav').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || st.mode !== 'replay') return;
    const i = st.replay.idx, last = st.replay.moves.length;
    replayTo({ first: 0, prev: i - 1, next: i + 1, last }[b.dataset.r]);
  });
  document.addEventListener('keydown', (e) => {
    if (st.mode !== 'replay' || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') replayTo(st.replay.idx - 1);
    if (e.key === 'ArrowRight') replayTo(st.replay.idx + 1);
  });

  // ---------- 自分の指し手 ----------
  async function onLocalMove(usi) {
    if (st.mode === 'ai') {
      if (st.aiThinking) return;
      st.game.play(usi);
      refresh();
      if (st.game.result) return showResult(st.game.result);
      aiTurn();
    } else if (st.mode === 'human') {
      if (st.pending) return;
      st.pending = true;
      ui.setInteractive(false);
      const r = await client.move(st.gameId, usi);
      if (!r.ok) {
        st.pending = false;
        if (r.error !== 'timeout') ui.setInteractive(true);
        toast(r.error === 'illegal' ? 'その手は指せません' : r.error === 'not_your_turn' ? '相手の手番です' : '送信できませんでした');
      }
    }
  }

  // ---------- 時計 ----------
  function setClock(c) {
    if (!c) { st.clock = null; return; }
    st.clock = c;
    st.clockOffset = c.serverNow - Date.now();
  }
  function fmt(ms) {
    ms = Math.max(0, ms);
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function clockText(side) {
    const c = st.clock;
    if (!c) return { text: '持ち時間なし', cls: '' };
    let main = c.main[side], byo = c.byoyomi;
    if (c.running && c.turn === side) {
      const el = Date.now() + st.clockOffset - c.turnStart;
      if (el <= main) main -= el;
      else { byo -= el - main; main = 0; }
    }
    if (main > 0) return { text: fmt(main), cls: main < 10e3 ? 'low' : '' };
    return { text: '秒読み ' + Math.max(0, Math.ceil(byo / 1000)), cls: byo < 10e3 ? 'byo low' : 'byo' };
  }
  setInterval(() => { if (st.mode !== 'lobby') renderBars(); }, 200);

  // ---------- 表示更新 ----------
  function renderBars() {
    const persp = ui.perspective;
    [['pBottom', persp], ['pTop', 1 - persp]].forEach(([id, side]) => {
      const el = $(id);
      const r = st.ratings[side];
      el.querySelector('.pname').textContent = (side === 0 ? '☗' : '☖') + st.names[side] + (r ? ` R${r}` : '');
      const ck = clockText(side), ce = el.querySelector('.clock');
      ce.textContent = ck.text; ce.className = 'clock ' + ck.cls;
      el.classList.toggle('turn', !!st.game && !st.game.result && st.game.pos.turn === side);
    });
  }

  function updateInfo() {
    if (st.mode === 'lobby' || !st.game) return;
    const g = st.game, info = $('info');
    let t;
    if (st.mode === 'replay') t = '棋譜再生' + (g.result ? ' ・ ' + resultText(g.result) : '');
    else if (g.result) t = '終局：' + resultText(g.result);
    else if (st.mode === 'watch') t = `観戦中 ・ ${g.moves.length + 1}手目`;
    else if (st.mode === 'ai' && st.aiThinking) t = 'AIが考えています…';
    else t = (g.pos.turn === st.mySide ? 'あなたの番です' : '相手の番です') + ` ・ ${g.moves.length + 1}手目` + (C.inCheck(g.pos) ? ' ・ 王手！' : '');
    if (st.seeking && st.mode === 'ai') t += '（相手を探しています…）';
    info.textContent = t;
  }

  function refresh() {
    ui.render();
    renderBars();
    updateInfo();
    const k = $('kifu');
    k.innerHTML = '';
    if (st.mode === 'replay') {
      st.replay.kifs.forEach((kif, i) => {
        const li = document.createElement('li');
        li.textContent = kif; li.className = 'clickable' + (i === st.replay.idx - 1 ? ' cur' : '');
        li.onclick = () => replayTo(i + 1);
        k.appendChild(li);
      });
      const cur = k.querySelector('.cur'); if (cur) cur.scrollIntoView({ block: 'nearest' });
    } else {
      st.game.moves.forEach((m) => { const li = document.createElement('li'); li.textContent = m.kif; k.appendChild(li); });
      k.scrollTop = k.scrollHeight;
    }
    $('replayNav').hidden = st.mode !== 'replay';
    const playing = (st.mode === 'human' || st.mode === 'ai') && !st.game.result;
    $('resignBtn').hidden = !playing;
    $('hintBtn').hidden = !(st.mode === 'ai' && !st.game.result);
    $('backBtn').hidden = playing && st.mode === 'human';
    $('gameChatBox').hidden = st.mode === 'ai' || st.mode === 'replay';
  }

  function resultText(r) {
    const reason = REASON[r.reason] || r.reason;
    if (r.winner === -1) return `引き分け（${reason}）`;
    return `${r.winner === 0 ? '先手' : '後手'}の勝ち（${reason}）`;
  }
  function showResult(r) {
    let title;
    if (st.mySide < 0) title = '終局';
    else if (r.winner === -1) title = '引き分け';
    else title = r.winner === st.mySide ? '勝ち' : '負け';
    $('resultTitle').textContent = title;
    let txt = resultText(r) + ` ・ ${st.game.moves.length}手`;
    if (r.ratingChange && st.mySide >= 0) { const d = r.ratingChange[st.mySide]; txt += ` ・ レーティング ${d >= 0 ? '+' : ''}${d}`; }
    $('resultText').textContent = txt;
    $('result').hidden = false;
    refresh();
  }
  $('resultClose').onclick = () => { $('result').hidden = true; };

  // ---------- ボタン ----------
  $('resignBtn').onclick = () => {
    if (!confirm('投了しますか？')) return;
    if (st.mode === 'human') client.resign(st.gameId);
    else if (st.mode === 'ai') { ai.stop(); st.game.result = { winner: 1 - st.mySide, reason: 'resign' }; showResult(st.game.result); }
  };
  $('hintBtn').onclick = async () => {
    if (st.mode !== 'ai' || st.aiThinking || st.game.pos.turn !== st.mySide) return;
    const g = st.game;
    $('hintBtn').disabled = true;
    const mv = await ai.getMove(g, 5);
    $('hintBtn').disabled = false;
    if (st.game !== g) return;
    const m = C.moveFromUsi(g.pos, mv);
    const prev = g.moves.length ? g.moves[g.moves.length - 1].to : -1;
    toast(m ? 'ヒント：' + C.moveToKif(g.pos, m, prev) : 'ヒントが見つかりません', 5000);
  };
  $('flipBtn').onclick = () => { ui.flip(); renderBars(); };
  $('copyBtn').onclick = async () => {
    let g = st.game;
    if (st.mode === 'replay') { g = new C.Game(st.replay.start); st.replay.moves.forEach((u) => g.play(u)); g.result = st.replay.result; }
    const text = `先手：${st.names[0]}\n後手：${st.names[1]}\n` + g.moves.map((m, i) => `${i + 1} ${m.kif}`).join('\n') +
      (g.result ? `\nまで${g.moves.length}手で${resultText(g.result)}` : '') + `\n\nUSI: ${g.usiPosition()}`;
    try { await navigator.clipboard.writeText(text); toast('棋譜をコピーしました'); }
    catch (e) { prompt('棋譜（コピーしてください）', text); }
  };
  $('backBtn').onclick = () => {
    if (st.mode === 'watch') client.unwatch(st.gameId);
    if (st.mode === 'ai') ai.stop();
    st.mode = 'lobby'; st.game = null; st.gameId = null;
    $('result').hidden = true;
    showRoom(false);
  };
})();
