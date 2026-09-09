// GAS を使わずに、素材の整形ロジックだけを Node で検証する。
// 実行: node shareholder-report/test/run.js
// GAS はスクリプトのタイムゾーン（Asia/Tokyo）で Date を解釈する。テストも同じ前提に揃える。
process.env.TZ = 'Asia/Tokyo';

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

// formatMailLine_ : 送信メール1行
const mailAt = new Date(2026, 8, 8, 9, 12);
eq('mail: 時刻・宛先・件名', ctx.formatMailLine_({ sentAt: mailAt, to: 'a@x.com', cc: 0, subject: '見積の件' }),
   '- 09:12 宛先: a@x.com / 件名: 見積の件');
eq('mail: CC件数を添える', ctx.formatMailLine_({ sentAt: mailAt, to: 'a@x.com', cc: 2, subject: '件名' }).includes('（CC 2名）'), true);
eq('mail: 本文はインデントして続ける', ctx.formatMailLine_({ sentAt: mailAt, to: 'a@x.com', cc: 0, subject: 's', body: '一行目\n二行目' }),
   '- 09:12 宛先: a@x.com / 件名: s\n  一行目\n  二行目');

// countAddresses_ : CC の人数
eq('cc: 3件', ctx.countAddresses_('a@x.com, b@x.com, c@x.com'), 3);
eq('cc: 空文字', ctx.countAddresses_(''), 0);
eq('cc: 末尾カンマを数えない', ctx.countAddresses_('a@x.com, '), 1);

// formatDateLabel_ : 曜日は日本語（Utilities.formatDate の 'E' は英語を返す）
eq('dateLabel: 水曜', ctx.formatDateLabel_(new Date(2026, 8, 9)), '2026年09月09日(水)');
eq('dateLabel: 日曜', ctx.formatDateLabel_(new Date(2026, 8, 13)), '2026年09月13日(日)');
eq('dateLabel: 月をまたいだ土曜', ctx.formatDateLabel_(new Date(2026, 9, 3)), '2026年10月03日(土)');

// 日付ユーティリティ
eq('date: startOfDay は 00:00', ctx.startOfDay_(new Date(2026, 8, 9, 23, 30)).getHours(), 0);
eq('date: offsetDate は月をまたぐ', ctx.formatDate_(ctx.offsetDate_(new Date(2026, 8, 30), 1), 'yyyy-MM-dd'), '2026-10-01');

// プロンプト
const prompt = ctx.buildPrompt_('2026年09月09日(水)');
eq('prompt: 時系列の見出し形式を指示', prompt.includes('■ HH:MM-HH:MM'), true);
eq('prompt: 要点ブロックを指示', prompt.includes('【本日の要点】'), true);
eq('prompt: 機微情報は※要確認へ回す指示', prompt.includes('※要確認'), true);
eq('prompt: 議事録が無い予定の書き方を指示', prompt.includes('記録がなく'), true);
eq('prompt: 打ち合わせ先は実名で開示と指示', prompt.includes('カレンダーの予定に書かれているとおりに開示'), true);
eq('prompt: 丸めを禁じる', prompt.includes('丸めてはいけない'), true);
eq('prompt: 社員の氏名は開示してよい', prompt.includes('社員の氏名が入っていればそのまま書いてよい'), true);
eq('prompt: 処遇の中身は要確認へ', prompt.includes('処遇・評価・給与などの内容は本文に書かず'), true);
eq('prompt: 採用候補者だけは役割で書く', prompt.includes('採用候補者との面接'), true);
eq('prompt: デスクワーク欄を指示', prompt.includes('■ デスクワーク'), true);
eq('prompt: 宛先は社名粒度と指示', prompt.includes('社名・部署の粒度'), true);
eq('prompt: 件名の羅列を禁じる', prompt.includes('件名をそのまま並べる'), true);
eq('prompt: 日付が入る', prompt.includes('2026年09月09日(水)'), true);
eq('prompt: 日本語以外の紛れ込みが無い', /[\u0400-\u04FF]/.test(prompt), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
