/*
 * app.js — 画面の流れ（ロビー / 人間対局 / 観戦 / AI練習 / 棋譜再生・AI感想戦 / 詰将棋）
 */
(function () {
  'use strict';
  const C = window.ShogiCore;
  const A = window.ShogiAnalysis;
  const S = window.DojoSound;
  const $ = (id) => document.getElementById(id);
  const REASON = {
    checkmate: '詰み', resign: '投了', timeout: '時間切れ', disconnect: '接続切れ',
    sennichite: '千日手', perpetual_check: '連続王手の千日手', nyugyoku: '入玉宣言', bad_declare: '宣言の条件不足', jishogi: '持将棋',
  };
  const TC_HINT = {
    kire3: '持ち時間3分・秒読みなし', fischer5: '1手ごとに5秒増える（加算）', kire10: '持ち時間10分・秒読みなし',
    m10b30: 'じっくりも早指しも', hayasashi2: '持ち時間なし・毎手30秒', m15b60: '落ち着いて指す', m30b60: '持ち時間30分・秒読み60秒',
  };

  // ---- 段級位（レーティングからの目安。独自の換算） ----
  function danOf(r) {
    if (r == null) return '—';
    if (r >= 1550) { const d = Math.min(9, Math.floor((r - 1550) / 200) + 1); return ['初段', '二段', '三段', '四段', '五段', '六段', '七段', '八段', '九段'][d - 1]; }
    const k = Math.min(15, Math.floor((1549 - r) / 100) + 1);
    return k + '級';
  }

  const client = new DojoClient();
  const ai = new ShogiAI.AIManager();
  const ui = new ShogiBoardUI($('board'), { onMove: onLocalMove });

  const st = {
    mode: 'lobby', game: null, gameId: null, mySide: -1, names: ['', ''], ratings: [null, null], rated: true,
    clock: null, clockOffset: 0, aiLevel: 3, aiThinking: false, seeking: false, batonTimer: null,
    tcs: {}, tcSel: DojoStore.get('dojo_tc') || 'm10b30', ratedSel: DojoStore.get('dojo_rated') !== '0',
    pending: false, replay: null, tsume: null, lastEnded: null, analysisRun: 0,
    muted: new Set(JSON.parse(DojoStore.get('dojo_muted') || '[]')),
  };

  // ---------- 共通 ----------
  let toastTimer;
  function toast(msg, ms = 3000) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
  }
  function showRoom(on) { $('lobby').hidden = on; $('room').hidden = !on; window.scrollTo(0, 0); }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function addChat(boxId, name, text, sys, room) {
    if (!sys && st.muted.has(name)) return;
    const box = $(boxId), line = el('div', sys ? 'sys' : '');
    if (sys) line.textContent = text;
    else {
      const who = el('button', 'who', name + '：');
      who.type = 'button';
      who.onclick = (e) => openNamePop(e, name, room, text);
      line.append(who, document.createTextNode(text));
    }
    box.appendChild(line);
    while (box.children.length > 200) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
  document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => $(b.dataset.open).showModal()));

  // ---------- 名前メニュー（ミュート・通報） ----------
  let popCtx = null;
  function openNamePop(e, name, room, text) {
    if (client.me && name === client.me.name) return;
    popCtx = { name, room, text };
    const p = $('namePop');
    $('popName').textContent = name;
    $('popMute').textContent = st.muted.has(name) ? 'ミュート解除' : 'ミュート';
    p.hidden = false;
    p.style.left = Math.min(e.clientX, window.innerWidth - 240) + 'px';
    p.style.top = (e.clientY + 8) + 'px';
  }
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#namePop') && !e.target.closest('.who')) $('namePop').hidden = true; });
  $('popMute').onclick = () => {
    const n = popCtx.name;
    if (st.muted.has(n)) { st.muted.delete(n); toast(n + ' さんのミュートを解除しました'); }
    else { st.muted.add(n); toast(n + ' さんの発言を表示しないようにしました'); }
    DojoStore.set('dojo_muted', JSON.stringify([...st.muted]));
    $('namePop').hidden = true;
  };
  $('popReport').onclick = async () => {
    await client.report(popCtx.name, String(popCtx.room || ''), popCtx.text || '');
    $('namePop').hidden = true;
    toast('通報を受け付けました。運営が確認します');
  };

  // ---------- ログイン・ロビー ----------
  client.on('login', (res) => {
    renderMe(res);
    renderLobby(res.lobby);
    if (res.nameError === 'taken') toast('その名前は他の人が使っています。別の名前にしてください', 4000);
    if (res.nameError === 'reserved') toast('その名前は使えません', 3000);
    if (res.resume && st.mode !== 'human') { toast('対局に復帰しました'); enterOnline(res.resume, 'human'); }
  });
  client.on('disconnect', () => { $('online').textContent = '再接続中…'; });
  client.on('kicked', () => toast('別の画面でログインしたため、この画面は切断されました', 6000));
  client.on('lobby', renderLobby);

  function renderMe(res) {
    $('meDan').textContent = danOf(res.rating);
    $('meName').textContent = res.name;
    $('name').value = res.name;
    $('recDan').textContent = danOf(res.rating);
    $('recRating').textContent = 'R' + res.rating;
    const n = res.wins + res.losses + res.draws;
    $('recWL').textContent = `${n}局 ${res.wins}勝 ${res.losses}敗` + (res.draws ? ` ${res.draws}分` : '');
    $('recStreak').textContent = res.streak >= 2 ? `${res.streak}連勝中（最高 ${res.bestStreak}連勝）` : (res.bestStreak ? `最高 ${res.bestStreak}連勝` : '');
    drawRatingGraph(res.history || []);
    const list = $('myGames');
    list.innerHTML = '';
    if (!res.recent || !res.recent.length) { list.appendChild(el('li', 'empty', '対局すると、ここに棋譜が残ります。')); return; }
    res.recent.forEach((g) => {
      const li = el('li');
      const r = g.winner === -1 ? '分' : g.winner === g.my_side ? '勝' : '負';
      const s = el('span');
      s.append(el('b', r === '勝' ? 'win' : r === '負' ? 'lose' : 'draw', r + ' '), document.createTextNode(`☗${g.sente_name} 対 ☖${g.gote_name}`));
      li.append(s, el('small', null, `${g.ply}手 ${REASON[g.reason] || ''}${g.rated ? '' : '・練習'}`));
      li.title = '棋譜を再生・AI感想戦';
      li.onclick = () => openSavedGame(g.id);
      list.appendChild(li);
    });
  }
  function drawRatingGraph(hist) {
    const svg = $('ratingGraph');
    const note = $('ratingNote');
    if (hist.length < 2) { svg.setAttribute('hidden', ''); note.hidden = false; return; }
    svg.removeAttribute('hidden'); note.hidden = true;
    const rs = hist.map((h) => h.rating);
    const lo = Math.min(...rs, 1500) - 20, hi = Math.max(...rs, 1500) + 20;
    const y = (r) => 66 - ((r - lo) / (hi - lo)) * 62;
    const pts = rs.map((r, i) => `${(i / (rs.length - 1)) * 300},${y(r).toFixed(1)}`).join(' ');
    svg.innerHTML = `<line class="base" x1="0" x2="300" y1="${y(1500)}" y2="${y(1500)}"/><polyline points="${pts}"/>`;
  }

  function renderLobby(l) {
    if (!l) return;
    $('online').textContent = `オンライン ${l.online}人 ・ 対局中 ${l.games.length}局`;
    st.tcs = l.timeControls;
    const grid = $('tcGrid');
    if (!grid.children.length) {
      Object.entries(l.timeControls).forEach(([k, v]) => {
        const b = el('button', 'tc');
        b.type = 'button'; b.dataset.tc = k; b.setAttribute('role', 'radio');
        b.append(el('b', null, v.label), el('small', null, TC_HINT[k] || ''), el('span', 'wait'));
        b.onclick = () => selectTc(k);
        grid.appendChild(b);
      });
      if (!l.timeControls[st.tcSel]) st.tcSel = 'm10b30';
      selectTc(st.tcSel);
      const fs = $('friendTc');
      Object.entries(l.timeControls).forEach(([k, v]) => fs.add(new Option(v.label, k)));
      fs.value = 'm15b60';
    }
    grid.querySelectorAll('.tc').forEach((b) => { const n = l.seeks[b.dataset.tc] || 0; b.querySelector('.wait').textContent = n ? `${n}人待ち` : ''; });
    // 順位
    const rk = $('ranking');
    rk.innerHTML = '';
    if (!l.ranking.length) rk.appendChild(el('li', 'empty', 'まだ順位はありません。'));
    l.ranking.forEach((p) => {
      const li = el('li');
      li.append(el('span', 'dan', danOf(p.rating)), document.createTextNode(`${p.name}　${p.wins}勝${p.losses}敗` + (p.streak >= 3 ? `・${p.streak}連勝中` : '')), el('span', 'r', 'R' + p.rating));
      rk.appendChild(li);
    });
    // 対局中
    const list = $('gameList');
    list.innerHTML = '';
    if (!l.games.length) list.appendChild(el('li', 'empty', 'いまは対局がありません。最初の一局をどうぞ。'));
    l.games.forEach((g) => {
      const li = el('li');
      li.append(el('span', null, `☗${g.sente}（${danOf(g.ratings[0])}） 対 ☖${g.gote}（${danOf(g.ratings[1])}）`),
        el('small', null, `${(st.tcs[g.tc] || {}).label || ''} ${g.ply}手`));
      li.onclick = () => watchGame(g.id);
      list.appendChild(li);
    });
  }
  function selectTc(k) {
    st.tcSel = k; DojoStore.set('dojo_tc', k);
    $('tcGrid').querySelectorAll('.tc').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tc === k)));
  }
  document.querySelectorAll('.seg-b').forEach((b) => b.addEventListener('click', () => {
    st.ratedSel = b.dataset.rated === '1'; DojoStore.set('dojo_rated', st.ratedSel ? '1' : '0');
    document.querySelectorAll('.seg-b').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
  }));
  if (!st.ratedSel) document.querySelector('.seg-b[data-rated="0"]').click();
  $('homeBtn').onclick = () => { if (st.mode === 'human' && !st.game.result) return toast('対局中です。終わってからロビーへ戻れます'); goLobby(); };

  // ---------- 対局待ち（AIバトンタッチ付き） ----------
  $('seekBtn').onclick = () => { S.unlock(); client.seek(st.tcSel, st.ratedSel); };
  $('cancelSeek').onclick = () => { client.cancelSeek(); setSeeking(false); };
  client.on('seeking', () => {
    setSeeking(true);
    if ($('baton').checked) {
      st.batonTimer = setTimeout(() => {
        if (st.seeking && st.mode === 'lobby') { toast('相手を待つ間、AIと練習します。見つかったら自動で切り替えます', 4000); startAI({ fromBaton: true }); }
      }, 8000);
    }
  });
  function setSeeking(on) {
    st.seeking = on;
    $('waiting').hidden = !on; $('seekBtn').disabled = on;
    $('waitText').textContent = `${(st.tcs[st.tcSel] || {}).label || ''}・${st.ratedSel ? 'レート' : '練習'}で、近い棋力の相手を探しています…`;
    clearTimeout(st.batonTimer);
    updateInfo();
  }

  // ---------- 友達と（合言葉） ----------
  $('createRoom').onclick = async () => {
    const r = await client.createPrivate($('friendTc').value);
    if (r.error) return toast('いまは部屋を作れません（対局中か、接続が切れています）');
    $('roomCode').textContent = r.code; $('codeBox').hidden = false;
  };
  $('joinRoom').onclick = async () => {
    const r = await client.joinPrivate($('joinCode').value.trim());
    if (r.error === 'not_found') return toast('その合言葉の部屋は見つかりません。数字を確かめてください');
    if (r.error === 'self') return toast('自分で作った部屋です。相手に合言葉を伝えてください');
    if (r.error) return toast('入れませんでした');
    $('friendDlg').close();
  };

  // ---------- 人間との対局・観戦 ----------
  client.on('gameStart', (d) => {
    setSeeking(false);
    ['friendDlg', 'aiDlg'].forEach((id) => $(id).open && $(id).close());
    $('codeBox').hidden = true;
    if (st.mode === 'ai') { ai.stop(); toast('対戦相手が見つかりました！ 対局を開始します', 4000); }
    $('result').hidden = true;
    enterOnline(d, 'human');
    S.start();
  });

  function enterOnline(d, mode) {
    st.mode = mode;
    st.game = new C.Game(d.startSfen);
    d.moves.forEach((m) => st.game.play(m.usi));
    st.gameId = d.id; st.mySide = d.you; st.rated = d.rated;
    st.names = d.names; st.ratings = d.ratings;
    st.replay = null; st.tsume = null;
    setClock(d.clock);
    $('gameChat').innerHTML = '';
    addChat('gameChat', '', mode === 'watch' ? '観戦を始めました。' : `対局開始：あなたは${d.you === 0 ? '先手☗' : '後手☖'}です。${d.rated ? 'レート対局' : '練習対局'}・${(st.tcs[d.tc] || {}).label || ''}。よろしくお願いします。`, true);
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
    if (d.ply !== st.game.moves.length + 1) return;
    if (!st.game.play(d.usi)) return;
    st.pending = false;
    setClock(d.clock);
    S.koma(d.check);
    ui.setInteractive(st.mode === 'human');
    refresh();
  });

  client.on('gameEnd', (d) => {
    if (d.id !== st.gameId || (st.mode !== 'human' && st.mode !== 'watch')) return;
    st.game.result = d.result;
    setClock(d.clock);
    ui.setInteractive(false);
    rememberEnded();
    refresh();
    showResult(d.result);
    client.login();
  });

  client.on('rematchOffer', (d) => {
    toast(`${d.name} さんがもう一局を希望しています。「もう一局」で始まります`, 6000);
    $('resultText').textContent += `　${d.name} さんがもう一局を希望しています。`;
  });

  client.on('opponentStatus', (d) => {
    if (d.connected) toast('相手が再接続しました');
    else toast(`相手の接続が切れました。${Math.round(d.limit / 1000)}秒以内に戻らなければあなたの勝ちです`, 5000);
  });

  client.on('chat', (d) => {
    if (d.room === 'lobby') addChat('lobbyChat', d.name, d.text, d.system, 'lobby');
    else if (String(d.room) === String(st.gameId)) addChat('gameChat', d.name, d.text, d.system, d.room);
  });
  document.querySelectorAll('.chat-form').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = f.querySelector('input'), text = inp.value.trim();
    if (!text) return;
    const room = f.dataset.room === 'lobby' ? 'lobby' : st.gameId;
    if (room) client.chat(room, text);
    inp.value = '';
  }));

  // ---------- AI 練習 ----------
  ai.ready.then((name) => { $('aiEngine').textContent = `AIはあなたの端末の中で動きます（エンジン：${name}）。`; });
  $('aiStart').onclick = () => setTimeout(() => startAI({}), 0);

  function startAI({ fromBaton = false, startSfen = null, mySide = null } = {}) {
    st.mode = 'ai';
    st.aiLevel = +$('aiLevel').value;
    const sv = $('aiSide').value;
    st.mySide = mySide != null ? mySide : sv === 'r' ? (Math.random() < 0.5 ? 0 : 1) : +sv;
    st.game = new C.Game(startSfen || undefined);
    st.gameId = null; st.clock = null; st.replay = null; st.tsume = null; st.rated = false;
    const lv = ShogiAI.LEVELS[st.aiLevel].label;
    st.names = st.mySide === 0 ? [meName(), 'AI・' + lv] : ['AI・' + lv, meName()];
    st.ratings = [null, null];
    $('gameChat').innerHTML = '';
    addChat('gameChat', '', fromBaton ? '対戦相手を待つ間のAI練習です。相手が見つかると自動で切り替わります。' : 'AIとの練習です（持ち時間なし・待ったOK）。', true);
    ui.setGame(st.game, { perspective: st.mySide, mySide: st.mySide, interactive: true });
    showRoom(true);
    refresh();
    if (st.game.pos.turn !== st.mySide) aiTurn();
  }
  const meName = () => (client.me ? client.me.name : 'あなた');

  async function aiTurn() {
    const g = st.game;
    st.aiThinking = true; updateInfo();
    const mv = await ai.getMove(g, st.aiLevel);
    st.aiThinking = false;
    if (st.mode !== 'ai' || st.game !== g || g.result) return;
    if (mv === 'resign') g.result = { winner: st.mySide, reason: 'resign' };
    else { const r = g.play(mv); S.koma(r && r.check); }
    refresh();
    if (g.result) { rememberEnded(); showResult(g.result); }
  }

  // ---------- 自分の指し手 ----------
  async function onLocalMove(usi) {
    if ($('confirmMove').checked && st.mode !== 'tsume') {
      const m = C.moveFromUsi(st.game.pos, usi);
      const prev = st.game.moves.length ? st.game.moves[st.game.moves.length - 1].to : -1;
      if (m && !window.confirm(C.moveToKif(st.game.pos, m, prev) + ' と指しますか？')) return;
    }
    if (st.mode === 'ai') {
      if (st.aiThinking) return;
      const r = st.game.play(usi); S.koma(r && r.check);
      refresh();
      if (st.game.result) { rememberEnded(); return showResult(st.game.result); }
      aiTurn();
    } else if (st.mode === 'human') {
      if (st.pending) return;
      st.pending = true;
      ui.setInteractive(false);
      const r = await client.move(st.gameId, usi, st.game.moves.length);
      if (!r.ok) {
        st.pending = false;
        if (r.error !== 'timeout') ui.setInteractive(true);
        toast(r.error === 'illegal' ? 'その手は指せません' : r.error === 'not_your_turn' ? '相手の手番です' : r.error === 'stale' ? '盤面を更新しました。もう一度指してください' : '送信できませんでした');
      }
    } else if (st.mode === 'tsume') tsumeMove(usi);
  }

  // ---------- 時計 ----------
  function setClock(c) { st.clock = c || null; if (c) st.clockOffset = c.serverNow - Date.now(); }
  function fmt(ms) { ms = Math.max(0, ms); const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  function clockText(side) {
    const c = st.clock;
    if (!c) return { text: st.mode === 'ai' ? '練習' : '', cls: '' };
    let main = c.main[side], byo = c.byoyomi;
    if (c.running && c.turn === side) {
      const e = Date.now() + st.clockOffset - c.turnStart;
      if (e <= main) main -= e; else { byo -= e - main; main = 0; }
    }
    if (main > 0 || !c.byoyomi) return { text: fmt(main), cls: main < 10e3 ? 'low' : '' };
    return { text: '秒読み ' + Math.max(0, Math.ceil(byo / 1000)), cls: byo < 10e3 ? 'byo low' : 'byo' };
  }
  let lastTickSec = -1;
  setInterval(() => {
    if (st.mode === 'lobby') return;
    renderBars();
    // 自分の秒読み残り10秒から毎秒カウント音
    const c = st.clock;
    if (st.mode === 'human' && c && c.running && c.turn === st.mySide) {
      const ck = clockText(st.mySide);
      const m = /(\d+)$/.exec(ck.text.replace(/^\d+:/, ''));
      const left = ck.text.startsWith('秒読み') ? +m[1] : null;
      if (left != null && left <= 10 && left !== lastTickSec) { lastTickSec = left; S.tick(); }
    }
  }, 200);

  // ---------- 表示更新 ----------
  function renderBars() {
    const persp = ui.perspective;
    [['pBottom', persp], ['pTop', 1 - persp]].forEach(([id, side]) => {
      const box = $(id), nm = box.querySelector('.pname');
      const r = st.ratings[side];
      nm.innerHTML = '';
      if (r) nm.append(el('span', 'dan', danOf(r)));
      nm.append(document.createTextNode((side === 0 ? '☗' : '☖') + st.names[side] + (r ? ` R${r}` : '')));
      const ck = clockText(side), ce = box.querySelector('.clock');
      ce.textContent = ck.text; ce.className = 'clock ' + ck.cls;
      box.classList.toggle('turn', !!st.game && !st.game.result && st.game.pos.turn === side && st.mode !== 'replay');
    });
  }

  function updateInfo() {
    if (st.mode === 'lobby' || !st.game) return;
    const g = st.game, info = $('info');
    let t;
    if (st.mode === 'replay') t = (st.replay.title || '棋譜') + (g.result ? '：' + resultText(g.result) : '');
    else if (st.mode === 'tsume') t = '';
    else if (g.result) t = '終局：' + resultText(g.result);
    else if (st.mode === 'watch') t = `観戦中 ・ ${g.moves.length + 1}手目`;
    else if (st.mode === 'ai' && st.aiThinking) t = 'AIが考えています…';
    else t = (g.pos.turn === st.mySide ? 'あなたの番です' : '相手の番です') + ` ・ ${g.moves.length + 1}手目` + (C.inCheck(g.pos) ? ' ・ 王手！' : '');
    if (st.seeking && st.mode === 'ai') t += '（相手を探しています…）';
    info.textContent = t;
  }

  function refresh() {
    ui.render(); renderBars(); updateInfo(); renderKifu();
    const g = st.game, m = st.mode;
    const playing = (m === 'human' || m === 'ai') && !g.result;
    const myTurn = playing && g.pos.turn === st.mySide;
    $('resignBtn').hidden = !playing;
    $('declareBtn').hidden = !(playing && myTurn && C.declareInfo(g.pos).kingIn);
    $('undoBtn').hidden = !(m === 'ai' && !g.result && g.moves.length > 0);
    $('hintBtn').hidden = !(m === 'ai' && !g.result);
    $('analyzeBtn').hidden = !(g.result && (m === 'human' || m === 'ai' || m === 'watch')) && !(m === 'replay' && !st.replay.review);
    $('rematchBtn').hidden = !(m === 'human' && g.result && st.lastEnded && st.lastEnded.gameId);
    $('kifBtn').hidden = m === 'tsume';
    $('backBtn').hidden = playing && m === 'human';
    $('flipBtn').hidden = false;
    $('gameChatBox').hidden = !(m === 'human' || m === 'watch');
    $('replayNav').hidden = m !== 'replay';
    $('analysis').hidden = !(m === 'replay' && st.replay.analysisShown);
    $('tsumePanel').hidden = m !== 'tsume';
    $('kifu').hidden = m === 'tsume';
  }

  function renderKifu() {
    const k = $('kifu');
    k.innerHTML = '';
    if (st.mode === 'replay') {
      const rv = st.replay.review;
      st.replay.kifs.forEach((kif, i) => {
        const li = el('li', 'clickable' + (i === st.replay.idx - 1 ? ' cur' : ''), kif);
        const it = rv && rv.moves[i];
        if (it && it.label && it.label !== 'best') li.append(el('span', 'm ' + it.label, A.LABELS[it.label].mark));
        li.onclick = () => replayTo(i + 1);
        k.appendChild(li);
      });
      const cur = k.querySelector('.cur'); if (cur) cur.scrollIntoView({ block: 'nearest' });
    } else {
      st.game.moves.forEach((m) => k.appendChild(el('li', null, m.kif)));
      k.scrollTop = k.scrollHeight;
    }
  }

  function resultText(r) {
    const reason = REASON[r.reason] || r.reason;
    if (r.winner === -1) return `引き分け（${reason}）`;
    return `${r.winner === 0 ? '先手' : '後手'}の勝ち（${reason}）`;
  }
  function showResult(r) {
    let title;
    if (st.mySide < 0) title = '終局';
    else if (r.winner === -1) title = '引分';
    else title = r.winner === st.mySide ? '勝ち' : '負け';
    if (st.mySide >= 0 && r.winner >= 0) S.end(r.winner === st.mySide);
    $('resultTitle').textContent = title;
    let txt = resultText(r) + ` ・ ${st.game.moves.length}手`;
    if (r.ratingChange && st.mySide >= 0) { const d = r.ratingChange[st.mySide]; txt += ` ・ レーティング ${d >= 0 ? '+' : ''}${d}`; }
    $('resultText').textContent = txt;
    $('resultRematch').hidden = !(st.mode === 'human' && st.lastEnded && st.lastEnded.gameId);
    $('resultAnalyze').hidden = !ai.canAnalyze && false;
    $('result').hidden = false;
    refresh();
  }
  $('resultClose').onclick = () => { $('result').hidden = true; };
  $('resultAnalyze').onclick = () => { $('result').hidden = true; analyzeEnded(); };
  $('resultRematch').onclick = () => { $('result').hidden = true; requestRematch(); };
  $('rematchBtn').onclick = requestRematch;
  async function requestRematch() {
    const r = await client.rematch(st.lastEnded.gameId);
    if (r.error === 'expired') toast('再戦の受付時間（1分）が過ぎました');
    else if (r.error) toast('相手がいないため再戦できません');
    else if (r.waiting) toast('相手の返事を待っています…', 5000);
  }

  function rememberEnded() {
    const g = st.game;
    st.lastEnded = { gameId: st.mode === 'human' ? st.gameId : null, startSfen: g.startSfen, moves: g.moves.map((m) => m.usi), result: g.result, names: [...st.names], perspective: ui.perspective };
  }

  // ---------- ボタン ----------
  $('resignBtn').onclick = () => {
    if (!confirm('投了しますか？')) return;
    if (st.mode === 'human') client.resign(st.gameId);
    else if (st.mode === 'ai') { ai.stop(); st.game.result = { winner: 1 - st.mySide, reason: 'resign' }; rememberEnded(); showResult(st.game.result); }
  };
  $('declareBtn').onclick = async () => {
    const info = C.declareInfo(st.game.pos);
    const msg = `入玉宣言をしますか？\n敵陣の駒 ${info.pieces}枚（10枚以上）・点数 ${info.points}点（${info.need}点以上）・王手${info.check ? 'されている' : 'されていない'}\n条件を満たしていないと負けになります。`;
    if (!confirm(msg)) return;
    if (st.mode === 'human') await client.declare(st.gameId);
    else { st.game.declare(); rememberEnded(); showResult(st.game.result); }
  };
  $('undoBtn').onclick = () => {
    if (st.mode !== 'ai' || st.aiThinking) return;
    const n = st.game.pos.turn === st.mySide ? 2 : 1;
    st.game.undo(Math.min(n, st.game.moves.length));
    ui.setGame(st.game, { perspective: ui.perspective, mySide: st.mySide, interactive: true });
    refresh();
    if (st.game.pos.turn !== st.mySide) aiTurn();
  };
  $('hintBtn').onclick = async () => {
    if (st.mode !== 'ai' || st.aiThinking || st.game.pos.turn !== st.mySide) return;
    const g = st.game;
    $('hintBtn').disabled = true;
    const mv = await ai.getMove(g, 5);
    $('hintBtn').disabled = false;
    if (st.game !== g) return;
    const m = C.moveFromUsi(g.pos, mv);
    if (!m) return toast('ヒントが見つかりません');
    ui.setMarks({ from: m.from, to: m.to, kind: 'best' });
    const prev = g.moves.length ? g.moves[g.moves.length - 1].to : -1;
    toast('ヒント：' + C.moveToKif(g.pos, m, prev), 5000);
  };
  $('flipBtn').onclick = () => { ui.flip(); renderBars(); };
  $('kifBtn').onclick = () => {
    const src = st.mode === 'replay' ? { start: st.replay.start, moves: st.replay.moves, result: st.replay.result, names: st.names } :
      { start: st.game.startSfen, moves: st.game.moves.map((m) => m.usi), result: st.game.result, names: st.names };
    let text;
    try { text = C.toKifFile(src.start, src.moves, { sente: src.names[0], gote: src.names[1], result: src.result, date: new Date().toLocaleString('ja-JP') }); }
    catch (e) { text = 'USI: position sfen ' + src.start + ' moves ' + src.moves.join(' '); }
    $('kifText').value = text;
    $('kifDlg').showModal();
  };
  $('kifCopy').onclick = async () => { try { await navigator.clipboard.writeText($('kifText').value); toast('棋譜をコピーしました'); } catch (e) { $('kifText').select(); } };
  $('kifSave').onclick = () => {
    const blob = new Blob([$('kifText').value], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `shogi-${new Date().toISOString().slice(0, 10)}.kif`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('backBtn').onclick = goLobby;
  function goLobby() {
    if (st.mode === 'watch') client.unwatch(st.gameId);
    if (st.mode === 'ai') ai.stop();
    st.analysisRun++;
    st.mode = 'lobby'; st.game = null; st.gameId = null; st.replay = null; st.tsume = null;
    $('result').hidden = true;
    showRoom(false);
    client.login();
  }

  // ---------- 棋譜再生・AI感想戦 ----------
  async function openSavedGame(id) {
    let d;
    try { const r = await fetch('/api/games/' + id); if (!r.ok) throw 0; d = await r.json(); }
    catch (e) { return toast('棋譜を読み込めませんでした'); }
    const mine = client.me && d.gote_name === client.me.name ? 1 : 0;
    openReplay({
      start: d.start_sfen, moves: d.moves ? d.moves.split(' ') : [], result: d.winner === null ? null : { winner: d.winner, reason: d.reason },
      names: [d.sente_name, d.gote_name], ratings: [d.sente_rating, d.gote_rating], title: '棋譜再生', perspective: mine,
    });
  }
  function openReplay(o) {
    st.mode = 'replay';
    st.analysisRun++;
    const t = new C.Game(o.start);
    const kifs = o.moves.map((u) => (t.play(u) || {}).kif).filter(Boolean);
    st.replay = { start: o.start, moves: o.moves.slice(0, kifs.length), result: o.result, kifs, idx: kifs.length, title: o.title, review: null, evals: null, analysisShown: false };
    st.names = o.names; st.ratings = o.ratings || [null, null];
    st.clock = null; st.gameId = null; st.mySide = -1; st.tsume = null;
    showRoom(true);
    ui.setGame(new C.Game(o.start), { perspective: o.perspective || 0, mySide: -1 });
    replayTo(st.replay.idx);
  }
  function replayTo(n) {
    const rp = st.replay;
    n = Math.max(0, Math.min(rp.moves.length, n));
    const g = new C.Game(rp.start);
    for (let i = 0; i < n; i++) g.play(rp.moves[i]);
    rp.idx = n;
    if (n === rp.moves.length && rp.result) g.result = rp.result;
    st.game = g;
    ui.setGame(g, { perspective: ui.perspective, mySide: -1, interactive: false });
    $('replayPos').textContent = `${n} / ${rp.moves.length}手`;
    if (rp.review) showReviewAt(n);
    refresh();
  }
  $('replayNav').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || st.mode !== 'replay') return;
    const i = st.replay.idx;
    replayTo({ first: 0, prev: i - 1, next: i + 1, last: st.replay.moves.length }[b.dataset.r]);
  });
  document.addEventListener('keydown', (e) => {
    if (st.mode !== 'replay' || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') replayTo(st.replay.idx - 1);
    if (e.key === 'ArrowRight') replayTo(st.replay.idx + 1);
  });

  function analyzeEnded() {
    const e = st.lastEnded;
    if (!e) return;
    openReplay({ start: e.startSfen, moves: e.moves, result: e.result, names: e.names, ratings: st.ratings, title: '感想戦', perspective: e.perspective });
    runAnalysis();
  }
  $('analyzeBtn').onclick = () => { if (st.mode === 'replay') runAnalysis(); else { rememberEnded(); analyzeEnded(); } };

  async function runAnalysis() {
    const rp = st.replay;
    if (!rp) return;
    await ai.ready;
    rp.analysisShown = true;
    refresh();
    if (!ai.canAnalyze) {
      $('anStatus').textContent = '';
      $('anText').textContent = 'この端末・ブラウザでは強いAIが動かないため、感想戦を利用できません。パソコンの最新版 Chrome / Edge / Safari でお試しください。';
      return;
    }
    const run = ++st.analysisRun;
    $('anSummary').innerHTML = ''; $('evGraph').innerHTML = '';
    $('anText').innerHTML = '<div class="progress"><i id="anBar"></i></div><p class="note">AIが全ての手を調べています（1手あたり約0.3秒）。</p>';
    $('analyzeBtn').hidden = true;
    try {
      const evals = await ai.analyze(rp.start, rp.moves, {
        movetime: 300,
        isCancelled: () => run !== st.analysisRun,
        onProgress: (i, n) => { const b = $('anBar'); if (b) b.style.width = (100 * i / n) + '%'; $('anStatus').textContent = `${i} / ${n}`; },
      });
      if (run !== st.analysisRun) return;
      rp.evals = evals;
      rp.review = A.review(rp.start, rp.moves, evals, rp.result);
      $('anStatus').textContent = '解析完了';
      drawEvalGraph();
      drawSummary();
      const d = rp.review.decisive;
      replayTo(d >= 0 ? d + 1 : rp.idx);
    } catch (e) {
      if (e.message !== 'cancelled') { $('anText').textContent = '解析に失敗しました。もう一度お試しください。'; console.error(e); }
    }
  }
  function drawSummary() {
    const s = st.replay.review.summary;
    $('anSummary').innerHTML = '';
    [0, 1].forEach((side) => {
      const d = el('div');
      d.append(el('b', null, (side === 0 ? '☗' : '☖') + st.names[side]), el('br'),
        document.createTextNode(`AI一致率 ${s[side].match}%・好手 ${s[side].good}・悪手 ${s[side].blunder}・疑問手 ${s[side].mistake}`));
      $('anSummary').appendChild(d);
    });
  }
  function drawEvalGraph() {
    const rp = st.replay, ev = rp.evals, n = ev.length;
    const W = 600, H = 160, x = (i) => (n <= 1 ? 0 : (i / (n - 1)) * W);
    const y = (cp) => H / 2 - (A.winRate(cp) - 0.5) * (H - 8);
    let d = `M0,${H} `;
    ev.forEach((e, i) => { d += `L${x(i).toFixed(1)},${y(e.score).toFixed(1)} `; });
    d += `L${W},${H} Z`;
    let marks = '';
    rp.review.moves.forEach((it, i) => {
      if (it.label === 'blunder' || it.label === 'mistake') marks += `<circle class="bad" cx="${x(i + 1)}" cy="${y(ev[i + 1].score)}" r="4"/>`;
      if (it.label === 'good') marks += `<circle class="goodpt" cx="${x(i + 1)}" cy="${y(ev[i + 1].score)}" r="4"/>`;
    });
    $('evGraph').innerHTML = `<path class="sente" d="${d}"/><line class="mid" x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}"/>${marks}<line class="cur" id="evCur" x1="0" x2="0" y1="0" y2="${H}"/>`;
    $('evGraph').onclick = (e) => {
      const r = $('evGraph').getBoundingClientRect();
      replayTo(Math.round(((e.clientX - r.left) / r.width) * (n - 1)));
    };
  }
  function showReviewAt(n) {
    const rp = st.replay, rv = rp.review;
    const cur = $('evCur');
    if (cur) { const xx = rp.evals.length > 1 ? (n / (rp.evals.length - 1)) * 600 : 0; cur.setAttribute('x1', xx); cur.setAttribute('x2', xx); }
    const box = $('anText');
    box.innerHTML = '';
    if (n === 0) { box.textContent = '▶で1手ずつ進めるか、グラフ・棋譜をタップしてください。'; ui.setMarks(null); return; }
    const it = rv.moves[n - 1];
    if (!it) return;
    if (it.label) box.append(el('span', 'tag ' + it.label, A.LABELS[it.label].name));
    if (n - 1 === rv.decisive) box.append(el('span', 'tag blunder', '勝敗を分けた一手'));
    box.append(document.createTextNode(it.text));
    // この手の代わりの最善手を矢印で（1手前の局面に重ねて見せる）
    if (it.best && it.best !== it.usi && it.label && it.label !== 'best' && it.label !== 'good') {
      const pg = new C.Game(rp.start); rp.moves.slice(0, n - 1).forEach((u) => pg.play(u));
      const bm = C.moveFromUsi(pg.pos, it.best);
      ui.setMarks(bm ? { from: bm.from, to: bm.to, kind: 'best' } : null);
    } else ui.setMarks(null);
  }
  const badIdx = () => st.replay.review.moves.map((it, i) => (it.label === 'blunder' || it.label === 'mistake' ? i + 1 : -1)).filter((i) => i > 0);
  $('anNextBad').onclick = () => { if (!st.replay || !st.replay.review) return; const nx = badIdx().find((i) => i > st.replay.idx); if (nx) replayTo(nx); else toast('この先に悪手・疑問手はありません'); };
  $('anPrevBad').onclick = () => { if (!st.replay || !st.replay.review) return; const pv = badIdx().reverse().find((i) => i < st.replay.idx); if (pv) replayTo(pv); else toast('ここより前に悪手・疑問手はありません'); };
  $('anFromHere').onclick = () => {
    const rp = st.replay;
    const g = new C.Game(rp.start); rp.moves.slice(0, Math.max(0, rp.idx - 1)).forEach((u) => g.play(u));
    if (!C.hasLegalMove(g.pos)) return toast('この局面からは指せません');
    startAI({ startSfen: C.toSfen(g.pos), mySide: g.pos.turn });
    toast('悪手の直前の局面から、AIと指し直します');
  };

  // ---------- 棋譜の取り込み ----------
  $('importFile').onchange = async () => {
    const f = $('importFile').files[0]; if (!f) return;
    const buf = await f.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (/�/.test(text)) { try { text = new TextDecoder('shift_jis').decode(buf); } catch (e) { /* そのまま */ } }
    $('importText').value = text;
  };
  $('importGo').onclick = () => {
    $('importErr').hidden = true;
    try {
      const k = C.parseKifu($('importText').value);
      if (!k.moves.length) throw new Error('指し手が見つかりません');
      $('importDlg').close();
      openReplay({ start: k.startSfen, moves: k.moves, result: null, names: [k.sente || '先手', k.gote || '後手'], title: '取り込んだ棋譜' });
      runAnalysis();
    } catch (e) { $('importErr').textContent = e.message; $('importErr').hidden = false; }
  };

  // ---------- 詰将棋 ----------
  let tsumeData = null;
  const tsumeSolved = () => JSON.parse(DojoStore.get('dojo_tsume') || '{"one":[],"three":[]}');
  function updateTsumeProgress() {
    if (!tsumeData) return;
    const s = tsumeSolved();
    $('tsumeProgress').textContent = `（解いた数 ${s.one.length + s.three.length} / ${tsumeData.one.length + tsumeData.three.length}）`;
  }
  async function loadTsume() {
    if (!tsumeData) { const r = await fetch('/data/tsume.json'); tsumeData = await r.json(); updateTsumeProgress(); }
    return tsumeData;
  }
  loadTsume().catch(() => {});
  $('tsumeBtn').onclick = async () => { await loadTsume(); openTsume(DojoStore.get('dojo_tsume_mode') || 'one'); };
  function openTsume(kind, index) {
    const list = tsumeData[kind];
    const solved = new Set(tsumeSolved()[kind]);
    if (index == null) { index = list.findIndex((_, i) => !solved.has(i)); if (index < 0) index = Math.floor(Math.random() * list.length); }
    DojoStore.set('dojo_tsume_mode', kind);
    const p = list[index];
    st.mode = 'tsume'; st.analysisRun++;
    st.tsume = { kind, index, p, step: 0, failed: false };
    st.game = new C.Game(p.sfen);
    st.mySide = 0; st.names = ['あなた（攻め方）', '玉方']; st.ratings = [null, null]; st.clock = null; st.replay = null;
    $('tsTitle').textContent = `${kind === 'one' ? '1手詰' : '3手詰'} 第${index + 1}問`;
    $('tsScore').textContent = `解いた数 ${solved.size} / ${list.length}`;
    $('tsMsg').textContent = kind === 'one' ? '先手の番です。1手で玉を詰ませてください。' : '先手の番です。王手の連続で、3手で玉を詰ませてください。';
    $('tsMode').textContent = kind === 'one' ? '3手詰へ' : '1手詰へ';
    showRoom(true);
    ui.setGame(st.game, { perspective: 0, mySide: 0, interactive: true });
    refresh();
  }
  function tsumeMove(usi) {
    const t = st.tsume, g = st.game;
    const r = g.play(usi);
    S.koma(r && r.check);
    const mated = C.inCheck(g.pos) && !C.hasLegalMove(g.pos);
    const isLast = t.kind === 'one' || t.step === 2;
    if (isLast && mated) return tsumeSolvedNow();
    if (!r.check || (t.kind === 'three' && t.step === 0 && usi !== t.p.answer[0])) {
      $('tsMsg').textContent = r.check ? 'その王手では詰みません。もう一度考えてみましょう。' : '詰将棋は王手の連続で詰ませます。もう一度。';
      t.failed = true;
      refresh(); ui.setInteractive(false);
      return setTimeout(() => { if (st.tsume === t) openTsume(t.kind, t.index); }, 1400);
    }
    if (isLast) { $('tsMsg').textContent = '王手ですが、まだ逃げられます。もう一度。'; t.failed = true; refresh(); ui.setInteractive(false); return setTimeout(() => { if (st.tsume === t) openTsume(t.kind, t.index); }, 1400); }
    // 3手詰の2手目：玉方の応手（正解手順の応手）
    t.step = 1; refresh(); ui.setInteractive(false);
    setTimeout(() => {
      if (st.tsume !== t) return;
      const rr = g.play(t.p.answer[1]); S.koma(rr && rr.check);
      t.step = 2;
      $('tsMsg').textContent = `${rr.kif}と応じました。あと1手で詰ませてください。`;
      ui.setInteractive(true); refresh();
    }, 500);
  }
  function tsumeSolvedNow() {
    const t = st.tsume;
    const s = tsumeSolved();
    if (!t.failed && !s[t.kind].includes(t.index)) s[t.kind].push(t.index);
    DojoStore.set('dojo_tsume', JSON.stringify(s));
    updateTsumeProgress();
    $('tsMsg').textContent = t.failed ? '詰みました！（やり直しで正解）' : '正解です！ 詰みました。';
    $('tsScore').textContent = `解いた数 ${s[t.kind].length} / ${tsumeData[t.kind].length}`;
    S.end(true);
    ui.setInteractive(false); refresh();
  }
  $('tsRetry').onclick = () => openTsume(st.tsume.kind, st.tsume.index);
  $('tsNext').onclick = () => { const t = st.tsume; const n = (t.index + 1) % tsumeData[t.kind].length; openTsume(t.kind, n); };
  $('tsMode').onclick = () => openTsume(st.tsume.kind === 'one' ? 'three' : 'one');
  $('tsAnswer').onclick = () => {
    const t = st.tsume;
    const g = new C.Game(t.p.sfen);
    const kifs = t.p.answer.map((u) => (g.play(u) || {}).kif);
    t.failed = true;
    $('tsMsg').textContent = '正解：' + kifs.join(' ') + '　まで';
    const m = C.moveFromUsi(new C.Game(t.p.sfen).pos, t.p.answer[0]);
    if (m) ui.setMarks({ from: m.from, to: m.to, kind: 'best' });
  };

  // ---------- 名前と設定・引き継ぎ ----------
  $('meBtn').onclick = () => { $('soundOn').checked = S.enabled; $('myCode').value = ''; $('meErr').hidden = true; $('meDlg').showModal(); };
  $('soundOn').onchange = () => { S.enabled = $('soundOn').checked; if (S.enabled) { S.unlock(); S.koma(); } };
  $('confirmMove').checked = DojoStore.get('dojo_confirm') === '1';
  $('confirmMove').onchange = () => DojoStore.set('dojo_confirm', $('confirmMove').checked ? '1' : '0');
  $('saveName').onclick = async () => {
    const n = $('name').value.trim(); if (!n) return;
    const r = await client.login(n);
    if (r && r.nameError) { $('meErr').textContent = r.nameError === 'taken' ? 'その名前は他の人が使っています。' : 'その名前は使えません。'; $('meErr').hidden = false; }
    else { $('meErr').hidden = true; toast('名前を変更しました'); }
  };
  $('showCode').onclick = () => { $('myCode').value = client.token(); };
  $('copyCode').onclick = async () => { try { await navigator.clipboard.writeText(client.token()); toast('引き継ぎコードをコピーしました。他人に見せないでください'); } catch (e) { $('myCode').value = client.token(); $('myCode').select(); } };
  $('doTransfer').onclick = async () => {
    const code = $('transferCode').value.trim();
    if (!code) return;
    if (!confirm('この端末のアカウントを、引き継ぎコードのアカウントに切り替えます。よろしいですか？\n（今のアカウントに戻すには、今のコードを控えておいてください）')) return;
    const r = await client.transfer(code);
    if (r.error) { $('meErr').textContent = '引き継ぎコードが見つかりません。もう一度確かめてください。'; $('meErr').hidden = false; return; }
    $('meDlg').close(); toast(`${r.name} さんとして続けます`);
  };
})();
