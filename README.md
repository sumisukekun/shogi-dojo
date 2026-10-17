# 将棋オンライン道場 v04

将棋倶楽部24の「本格派・落ち着いたデザイン」を受け継いだオンライン対局サービス（BusinessMaker）。

## できること
- 人間同士のオンライン対局（4種の持ち時間：早指・早指2・15分・長考）
- **反則判定はサーバーでも実施**（王手放置・二歩・打ち歩詰め・行き所のない駒・千日手・連続王手の千日手・詰み）
- 対局時計（持ち時間＋秒読み、時間切れ負け）※時計はサーバーが管理
- 投了・切断60秒で負け・再接続で対局に復帰
- レーティング（Elo方式、初期1500）
- AI対局（5段階）とヒント。**AIは利用者のブラウザ内で動作**（Fairy-Stockfish WASM、使えない端末は内蔵AIへ自動切替）
- 対局待ちの間はAIと練習 → 相手が見つかると自動で人間対局へ切替
- 観戦・対局室チャット・ロビーチャット・棋譜コピー（日本語表記＋USI）
- **【v04】会員・レーティング・戦績・棋譜を SQLite に保存**（サーバーを再起動しても消えない）
- **【v04】自分の戦績・最近の対局・レーティング順位をロビーに表示、過去の対局を棋譜再生（◀▶・矢印キー）**

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
public/js/app.js        画面の流れ
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

## バックアップ（任意・おすすめ）
```bash
crontab -e   # 開いたファイルの最後に次の1行を追加（毎日4時にコピー、曜日ごと7日分）
0 4 * * * cp /opt/shogi-dojo/data/dojo.db /opt/backup-$(date +\%a).db
```

## 注意
- Fairy-Stockfish は GPL-3.0。改変せず配布しており、ソースは https://github.com/fairy-stockfish/fairy-stockfish.wasm で公開されている旨をサイトの「このサイトについて」等に記載すること。
- 2GBメモリで十分動く設計（サーバーはAI計算をしない）。

## 次の候補
1. 毎晩の定時大会
2. 研究ノートの公開・共有
3. 入玉宣言（27点法）、棋譜の KIF ファイル出力
