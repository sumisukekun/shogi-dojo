# 将棋オンライン道場 v05

将棋倶楽部24の「本格派・落ち着いた道場」を受け継ぎ、人気将棋アプリの便利な機能を取り入れたオンライン対局サービス（BusinessMaker）。
**対局は無料・回数無制限。** AIはすべて利用者のブラウザ内で動くので、サーバーは軽いままです。

## できること

**対局**
- 持ち時間7種：3分切れ負け／5分＋1手5秒（フィッシャー）／10分切れ負け／10分＋秒読み30秒／秒読み30秒／15分＋秒読み60秒／長考30分＋60秒
- レート対局・練習対局（レートなし）を選べる
- 棋力の近い相手を優先するマッチング（待つほど範囲を広げる）。待つ間はAIと練習し、相手が見つかると自動で切り替え
- 友達と合言葉（6桁）で対局、終局後の「もう一局」（先後入れ替え）
- 反則判定はサーバーでも実施：王手放置・二歩・打ち歩詰め・行き所のない駒・千日手・連続王手の千日手・詰み・**入玉宣言（27点法）**・**持将棋（512手）**
- 二重送信の防止、切断60秒で負け・再接続で復帰、**サーバー再起動後も進行中の対局を復元**
- 駒はタップでもドラッグでも操作、成・不成を駒の絵で選ぶ、指す前の確認（任意）、駒音・秒読み音（ON/OFF）

**上達**
- **AI感想戦**：全手をAIが解析し、評価値グラフ、悪手・疑問手・緩手・好手、勝敗を分けた一手、最善手（盤に矢印）、AIの読み筋に基づく解説、AI一致率。悪手の直前からAIと指し直し
- 棋譜の取り込み（KIF・CSA・位置省略形式）→ そのまま感想戦。KIF形式で保存・コピー
- AI練習（5段階・待った・ヒント）
- **詰将棋 250問**（1手詰150・3手詰100。自動生成し、全問をルールエンジンで検証済み）

**記録・交流**
- 段級位の目安表示（レーティングから換算）、レーティング推移グラフ、連勝記録、順位
- 観戦、ロビー・対局室チャット（ミュート・通報）、名前の重複禁止
- 引き継ぎコードで別の端末・アプリ版でも同じアカウント

## ファイル構成
```
server/server.js        マッチング・指し手検証・時計・チャット・部屋管理
server/db.js            保存（SQLite、Node内蔵なので追加インストール不要）
data/dojo.db            保存データ（自動作成。これだけバックアップすればOK）
public/index.html       画面
public/css/style.css    ダークテーマ
public/js/shogi-core.js ルールエンジン（サーバーとブラウザで共通）
public/js/shogi-ai.js   AIマネージャー（Fairy-Stockfish → 内蔵AI）
public/js/ai-worker.js  内蔵AI（Web Worker）
public/js/shogi-ui.js   盤・持ち駒・成り選択
public/js/client-ws.js  Socket.io クライアント
public/js/app.js        画面の流れ（ロビー・対局・観戦・AI練習・感想戦・詰将棋）
public/js/analysis.js   感想戦の判定と解説文
public/js/sound.js      効果音（その場で合成）
public/data/tsume.json  詰将棋
tools/gen-tsume.js      詰将棋の自動生成
tools/loadtest.js       負荷試験
deploy/backup.js        毎日のバックアップ（14日分）
test/                   自動テスト（npm test）
```

## 手元で動かす
```bash
npm install
npm test        # ルール・サーバーのテスト
npm start       # http://localhost:3000
```

## ConoHa VPS への設置（かんたん）

サーバーのコンソールに root でログインして、次の **1行** を貼り付けて Enter するだけ。
Node.js・nginx・自動起動・ファイアウォールまで全部自動で設定します。

```bash
curl -fsSL https://raw.githubusercontent.com/sumisukekun/shogi-dojo/main/deploy/setup.sh | bash
```

最後に「設置完了！」と `http://IPアドレス/` が表示されれば完了。

**ドメインを使う場合（HTTPS も自動）**：ドメインの DNS に A レコード（サーバーのIP）を登録してから
```bash
curl -fsSL https://raw.githubusercontent.com/sumisukekun/shogi-dojo/main/deploy/setup.sh | DOMAIN=shogi.example.com bash
```
※ 強いAI（Fairy-Stockfish）は HTTPS のときだけ動きます（HTTP では内蔵AIに自動で切り替わります）。

**ConoHa 側の設定**：コントロールパネル → サーバー → ネットワーク情報 → セキュリティグループに「IPv4v6-Web」を追加（80/443番を開ける）。

## 更新するとき
同じ1行をもう一度実行するだけ（保存データ `data/` は消えません）。

## 動作確認・トラブル時
```bash
systemctl status shogi-dojo        # 動いているか
journalctl -u shogi-dojo -n 50     # ログ
```

## バックアップ
設置スクリプトが毎日のバックアップ（`/opt/shogi-dojo/backup/`、14日分）を自動で登録します。

## 注意
- Fairy-Stockfish は GPL-3.0。改変せず配布しており、ソースは https://github.com/fairy-stockfish/fairy-stockfish.wasm で公開されている旨をサイトの「このサイトについて」等に記載すること。
- 2GBメモリで十分動く設計（サーバーはAI計算をしない）。

## 次の候補
1. 定時大会・棋力別イベント
2. 自分の悪手から作る「次の一手」問題、成長レポート
3. 棋友登録・プロフィール
4. Capacitor でのアプリ化
