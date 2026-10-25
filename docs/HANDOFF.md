# 将棋オンライン道場 — 開発引き継ぎ書（AI・開発者向け）

最終更新：2026-10-25 ／ 本番：v05（独自ドメイン shogi.businessmaker.net に移行）

この1ファイルを読めば、続きの開発を始められるようにまとめています。
関連資料：
- `docs/REVIEW_REQUEST.md` … 設計・弱点・レビュー観点（他AIへのレビュー依頼書）
- `docs/PLAN_v2_from_chatgpt.md` … ChatGPT から受け取った改善計画（v2.0）
- `README.md` … 機能一覧・設置手順

---

## 1. 概要

- **何を作っているか**：2025年末に終了した「将棋倶楽部24」の後継となる、ブラウザで遊べるオンライン将棋対局サービス。
- **運営**：BusinessMaker（個人・1人運営）。GitHub アカウントは `sumisukekun`。
- **最重要の設計条件**：1人で運営できること。サーバー（メモリ2GB）に重い処理をさせないこと。
- **方針**：既存サービス（将棋ウォーズ・24・クエスト・ぴよ将棋など）の**機能のアイデアは参考にするが、画面デザイン・名称・素材はコピーしない**。

## 2. URL・場所

| 種類 | 場所 |
|---|---|
| 公開サイト | https://shogi.businessmaker.net/ （旧仮ドメイン shogi.163-44-143-132.sslip.io からは自動転送） |
| 稼働確認 | https://shogi.businessmaker.net/health |
| ソースコード | https://github.com/sumisukekun/shogi-dojo （公開リポジトリ、ブランチ `main`） |
| 利用者のPC | `C:\Users\kimur\Visual_Studio_Code_Shota\`（v04 の zip を保存済み） |

## 3. 本番サーバー

- **ConoHa VPS**：IP `163.44.143.132`、メモリ2GB / CPU 3コア / SSD 100GB、**Ubuntu 24.04**。
- **同じVPSで別のアプリも動いている**（壊さないこと。nginx の他サイト・別ポートのサービスあり。詳細は利用者が持つ非公開資料 `HANDOFF_PRIVATE.md` を参照）。
- **将棋道場の配置**：
  - アプリ本体：`/opt/shogi-dojo`（git clone。実行ユーザーは `shogi`）
  - 保存データ：`/opt/shogi-dojo/data/dojo.db`（SQLite。**これだけは消さない**）
  - 常駐：systemd の `shogi-dojo.service`（ポート 3000、`Restart=always`）
  - nginx：`/etc/nginx/sites-available/shogi-dojo`（`server_name shogi.businessmaker.net` と旧仮ドメインだけを担当。旧ドメインは新ドメインへ301転送）
  - HTTPS：Let's Encrypt（certbot が自動更新）
- **ConoHa のセキュリティグループ**：Web（80/443番）を開放済み。
- VPS の支払いは 2026/10/25 に利用者が実施済み。

### 更新（デプロイ）の方法（いちばん簡単：オーナーのPCの PowerShell から1行）
```
ssh root@163.44.143.132 "cd /root && curl -fsSLo s.sh https://raw.githubusercontent.com/sumisukekun/shogi-dojo/main/deploy/setup.sh && DOMAIN=shogi.businessmaker.net OLD_DOMAINS=shogi.163-44-143-132.sslip.io bash s.sh | tail -n 8"
```
パスワード入力後、1〜2分で「設置完了！」。PowerShell では `&&` が使えないため、必ず ssh の引用符の中に入れること。

### 更新（デプロイ）の方法（コンソール版）
サーバーに root でログインして次を実行します（何度実行しても安全。保存データは消えません）。
```bash
cd /root
curl -fsSLo s.sh https://raw.githubusercontent.com/sumisukekun/shogi-dojo/main/deploy/setup.sh
DOMAIN=shogi.businessmaker.net OLD_DOMAINS=shogi.163-44-143-132.sslip.io bash s.sh 2>&1 | tee l.log | tail -n 30
```

### サーバー操作の注意（重要）
- SSH の鍵は未設定。操作は **ConoHa コントロールパネルの「コンソール」（ブラウザ上の画面）** から行っている。
- コンソールの「**テキスト送信**」機能は、**長い文字列を送ると途中で切れる**。1回に送るのは**60文字程度まで**にし、変数を使って短く分けること（上の手順はその形にしてある）。
- コンソールは新しい窓（ポップアップ）で開く（直接のURLは非公開資料に記載）。
- root パスワードは利用者が入力する（AI は入力しない・知らない前提で進めること）。
- 本番への反映・費用が発生する操作・データを消す操作は、**必ず利用者に確認してから**行う。

## 4. 技術構成（v04）

- サーバー：Node.js 22 + Express + Socket.io（WebSocket）。ルール判定・時計・マッチング・チャット・保存のみ。
- 保存：Node 内蔵の `node:sqlite`（追加インストール不要）。
- 画面：素の HTML / CSS / JS（フレームワークなし）。PC・スマホのブラウザ対応。
- AI：**ブラウザ内で実行**（サーバーで計算しない）。Fairy-Stockfish（WASM・将棋モード）を `/engine/` で配信。HTTPS かつ `crossOriginIsolated` が必要なため、サーバーは COOP/COEP ヘッダーを付けている。使えない端末は内蔵の簡易AI（`ai-worker.js`）に自動で切り替わる。
- アプリ化の予定：Capacitor で Android / iOS アプリに包む（利用者の得意な技術）。Web版とアプリ版は同じサーバーにつながるので対戦可能。

### ファイルと役割
```
server/server.js         マッチング・指し手検証・時計・チャット・部屋管理・API
server/db.js             SQLite（players / games）
public/js/shogi-core.js  ルールエンジン（サーバーとブラウザで共通）
public/js/shogi-ai.js    AIマネージャー
public/js/ai-worker.js   内蔵AI
public/js/shogi-ui.js    盤・持ち駒・成り選択
public/js/client-ws.js   Socket.io クライアント
public/js/app.js         画面の流れ（ロビー / 人間対局 / AI対局 / 観戦 / 棋譜再生）
public/index.html, public/css/style.css
deploy/setup.sh          設置・更新スクリプト
test/core.test.js        ルールのテスト
test/persist.test.js     再起動後も保存が残るかのテスト
test/server.test.js      2クライアントでの対局テスト
```

### 主なデータの流れ
- 本人確認：初回にランダムなトークンを発行し、ブラウザの localStorage に保存。サーバーには SHA-256 ハッシュだけを保存。
- 指し手：`socket.emit('move', {gameId, usi})` → サーバーが合法手か・手番か・時間内かを検証 → 両者と観戦者に配信。
- 時計：サーバーが正。`clock` を毎手配信し、画面側は `serverNow` との差を補正して表示。
- 終局時：レーティング（Elo、K=32）と棋譜を SQLite に保存。

## 5. テスト

```bash
npm install
npm test     # 3種類とも「すべて成功」
```
- ルール：perft（初期局面から3手先までの全合法手数 30 / 900 / 25,470）が既知の値と一致。
- ブラウザでの確認は Playwright（Chromium）で、2画面の対局・AI対局・棋譜再生を確認していた。

## 6. 現在の開発状況（v05 本番稼働中）

v05 で実装したもの（README「できること」参照）：持ち時間7種（フィッシャー含む）、レート/練習、棋力マッチング、合言葉対局、再対局、入玉宣言・持将棋、二重着手防止、再起動復元、回数制限、名前重複禁止、通報・ミュート、引き継ぎコード、安全なトークン、CSPなどのヘッダー、ドラッグ操作、効果音、段級位・推移グラフ・連勝、AI感想戦（評価値グラフ・悪手判定・読み筋・一致率・指し直し）、KIF/CSA入出力、詰将棋250問、毎日バックアップ、負荷試験。

### テスト結果（npm test）
- 5種類・58項目すべて合格（ルール／詰将棋250問の検証／保存／サーバー27項目／再起動復元・棋力マッチング）
- 負荷試験（tools/loadtest.js、手元の環境）：400人・200局同時、毎秒約320手で応答の中央値1ms・95%で2ms、サーバーのメモリ116MB
- ブラウザ（Playwright）：PC・スマホ幅で、2人対局→投了→もう一局、AI練習（ドラッグ・待った）、詰将棋の正解、棋譜取り込み→感想戦を確認。コンソールエラーなし

### 次の候補
- 定時大会・棋力別イベント、自分の悪手から作る問題、成長レポート、棋友登録・プロフィール
- Capacitor でアプリ化（接続先URLの明示とCORS設定が必要）
- ソフト指し検出（感想戦の「AI一致率」と考慮時間を使う案）
- 管理者画面（通報 reports テーブルの確認）

## 7. 既知の問題・注意点

- アカウントはブラウザ依存（引き継ぎコードを控えないままデータを消すと失う）。メール・SNSでのログインは未実装。
- ソフト指し（AIを使った不正）の検出はない。
- Fairy-Stockfish は将棋用の NNUE 評価ファイルを読み込んでいないため、古典評価で動いている可能性が高い（未検証）。
- 本番サーバーに「System restart required」が出ている（OS更新後の再起動待ち。将棋道場は再起動後に自動で立ち上がる）。
- root パスワードが作業中に一度コンソール画面に表示された。利用者に変更（`passwd`）を推奨済み。

## 8. 利用者（オーナー）について

- 日本語で、**手順を少なく・確認は要所だけ**の進め方を好む。細かい承認待ちは不要、完成度の高い版をまとめて提示してほしい。
- ただし、本番公開・費用発生・データ削除は事前確認が必要。
- 普段の開発スタイル：Capacitor による Android / iOS アプリ、Web サービス。
