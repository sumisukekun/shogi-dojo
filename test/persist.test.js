// node test/persist.test.js — サーバーを再起動してもレーティングが残るか
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-')), 'test.db');
const run = (code) => execFileSync(process.execPath, ['-e', code], { env: { ...process.env, DB_PATH: file }, encoding: 'utf8' }).trim();
const dbPath = JSON.stringify(path.join(__dirname, '..', 'server', 'db.js'));

run(`const db = require(${dbPath});
  const a = db.loginPlayer('tokA', '太郎'), b = db.loginPlayer('tokB', '花子');
  a.rating = 1516; b.rating = 1484;
  db.saveResult({ id: 1, tc: 'm15', names: ['太郎', '花子'], ratings: [1500, 1500], startedAt: Date.now(),
    game: { startSfen: 'x', moves: [{ usi: '7g7f', kif: '▲７六歩' }] } }, [a, b], { winner: 0, reason: 'resign', ratingChange: [16, -16] });
  db.close();`);
const out = run(`const db = require(${dbPath});
  console.log(JSON.stringify({ a: db.loginPlayer('tokA', '太郎'), next: db.nextGameId(), g: db.getGame(1).kif }));`);
const r = JSON.parse(out.split('\n').pop());
const ok = r.a.rating === 1516 && r.a.wins === 1 && r.next === 2 && r.g === '▲７六歩';
console.log((ok ? '  OK  ' : '  NG  ') + '再起動後もレーティング・戦績・棋譜が残る ' + out);
fs.rmSync(path.dirname(file), { recursive: true, force: true });
console.log(ok ? '\nすべて成功' : '\n1 件失敗');
process.exit(ok ? 0 : 1);
