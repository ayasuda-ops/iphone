// GAS を使わずに、素材の整形ロジックだけを Node で検証する。
// 実行: node shareholder-report/test/run.js
const fs = require('fs'), vm = require('vm');

// GAS グローバルの最小スタブ
const ctx = {
  Logger: { log: () => {} },
  Session: { getScriptTimeZone: () => 'Asia/Tokyo', getActiveUser: () => ({ getEmail: () => 'me@example.com' }) },
  Utilities: {
    formatDate: (d, tz, pattern) => {
      const p = new Intl.DateTimeFormat('ja-JP', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', weekday:'short', hour12:false }).formatToParts(d);
      const g = t => p.find(x => x.type === t).value;
      return pattern
        .replace('yyyy', g('year')).replace('MM', g('month')).replace('dd', g('day'))
        .replace('HH', g('hour')).replace('mm', g('minute')).replace('(E)', '(' + g('weekday').replace('曜日','') + ')');
    }
  }
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../Config.gs','utf8'), ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../Code.gs','utf8'), ctx);

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`));
};

// normalize_ : 会議名と議事録ファイル名の突き合わせ
const n = ctx.normalize_;
eq('normalize: 記号と空白を除去', n('経営会議 / Weekly'), '経営会議weekly');
eq('normalize: Meet の命名に含まれる', n('定例MTG (2026-09-09 at 10:00 GMT+9) - Transcript').indexOf(n('定例MTG')) === 0, true);
eq('normalize: 全角スペースも吸収', n('A　B'), 'ab');
eq('normalize: 別会議は一致しない', n('営業定例 - 文字起こし').indexOf(n('開発定例')), -1);

// stripHtml_ : カレンダー説明欄の HTML
eq('stripHtml: brとタグ除去', ctx.stripHtml_('<p>一行目<br>二行目</p><div>三行目</div>'), '一行目\n二行目\n三行目');
eq('stripHtml: 実体参照', ctx.stripHtml_('A&amp;B &lt;tag&gt; &quot;q&quot; &#39;s&#39;&nbsp;end'), 'A&B <tag> "q" \'s\' end');
eq('stripHtml: 空入力', ctx.stripHtml_(null), '');

// truncate_
eq('truncate: 上限以下はそのまま', ctx.truncate_('abcde', 10, '…'), 'abcde');
eq('truncate: 超過分を切って接尾辞', ctx.truncate_('abcdefghij', 5, '(略)'), 'abcde(略)');

// formatAttendees_ : リソース除外と 12 名打ち切り
eq('attendees: リソースは除外', ctx.formatAttendees_([
  { displayName: '山田' }, { email: 'room@resource', resource: true }, { email: 'b@x.com' }
]), '山田, b@x.com');
const many = Array.from({length: 15}, (_, i) => ({ email: `p${i}@x.com` }));
eq('attendees: 13名以上は「ほか」表記', ctx.formatAttendees_(many).endsWith('ほか3名'), true);
eq('attendees: 空', ctx.formatAttendees_([]), '');

// formatEventBlock_ : 素材ブロック全体
const event = {
  title: '経営定例',
  isAllDay: false,
  raw: {
    summary: '経営定例',
    start: { dateTime: '2026-09-09T10:00:00+09:00' },
    end:   { dateTime: '2026-09-09T11:00:00+09:00' },
    attendees: [{ displayName: '安田' }, { displayName: '佐藤' }],
    hangoutLink: 'https://meet.google.com/abc',
    description: '<b>アジェンダ</b><br>売上報告'
  }
};
const block = ctx.formatEventBlock_(1, event, [
  { name: '経営定例 - 文字起こし', url: 'https://docs.google.com/d/1', text: '売上は前月比 +12%。\n\n\n\n次回は9/16。', source: 'Drive（会議名で一致）' }
]);
eq('block: 見出しに時刻とタイトル', block.split('\n')[0], '## 1. 10:00-11:00 経営定例');
eq('block: 参加者行', block.includes('参加者: 安田, 佐藤'), true);
eq('block: Meet 表記', block.includes('会議: Google Meet'), true);
eq('block: 説明のHTMLが除去済み', block.includes('アジェンダ\n売上報告'), true);
eq('block: 議事録本文が入る', block.includes('売上は前月比 +12%。'), true);
eq('block: 空行が畳まれる', block.includes('\n\n\n'), false);

// 議事録なし・説明なしの予定
const bare = ctx.formatEventBlock_(2, { title: '打合せ', isAllDay: true, raw: { attendees: [] } }, []);
eq('block: 終日表記', bare.split('\n')[0], '## 2. [終日] 打合せ');
eq('block: 議事録なしの明示', bare.includes('紐づく議事録は見つかりませんでした'), true);

// 本文が読めなかった議事録
eq('doc: 読み取り失敗時はリンク案内', ctx.formatDocBlock_({ name: 'x', url: 'https://u', text: null, source: '予定の添付' })
   .includes('本文を読み取れませんでした'), true);

// 日付ユーティリティ
eq('date: startOfDay は 00:00', ctx.startOfDay_(new Date(2026, 8, 9, 23, 30)).getHours(), 0);
eq('date: offsetDate は月をまたぐ', ctx.formatDate_(ctx.offsetDate_(new Date(2026, 8, 30), 1), 'yyyy-MM-dd'), '2026-10-01');

// プロンプト
const prompt = ctx.buildPrompt_('2026年09月09日(水)');
eq('prompt: 3ブロックを指示', ['【本日の動き】','【決定事項】','【次の一手】'].every(k => prompt.includes(k)), true);
eq('prompt: 日付が入る', prompt.includes('2026年09月09日(水)'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
