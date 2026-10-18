// 毎日のバックアップ（setup.sh が /etc/cron.daily に登録）。14日分を残す。
// node deploy/backup.js [保存先フォルダ]
process.emitWarning = () => {};
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const src = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'dojo.db');
const dir = process.argv[2] || path.join(__dirname, '..', 'backup');
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, `dojo-${new Date().toISOString().slice(0, 10)}.db`);
if (fs.existsSync(dest)) fs.unlinkSync(dest);
const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
db.close();
const files = fs.readdirSync(dir).filter((f) => /^dojo-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
files.slice(0, Math.max(0, files.length - 14)).forEach((f) => fs.unlinkSync(path.join(dir, f)));
console.log('backup ok:', dest, `(${files.length > 14 ? 14 : files.length}世代)`);
