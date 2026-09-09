/**
 * 株主向け日報システム — 素材収集ロジック
 *
 * 流れ:
 *   1. 対象日のカレンダー予定を集める（複数カレンダー対応・重複排除）
 *   2. 各予定に紐づく議事録（Meet の文字起こし / メモ、予定の添付 Doc）を探して本文を取り込む
 *   3. Claude への指示文 + 素材をまとめて、自分宛に Gmail で送る
 *   4. 届いたメールを Claude アプリに貼り付けて日報を生成 → 確認して LINE へ手動転送
 *
 * 設定は Config.gs を参照。
 */

// ── エントリポイント ────────────────────────────────

/** 毎日のトリガーから呼ばれる本体。 */
function sendDailyDigest() {
  var date = offsetDate_(new Date(), -CONFIG.DAY_OFFSET);
  sendDigestForDate_(date);
}

/** 特定の日を指定して送り直す。例: sendDigestFor('2026-09-08') */
function sendDigestFor(dateStr) {
  var parts = String(dateStr).split('-');
  if (parts.length !== 3) {
    throw new Error('日付は yyyy-MM-dd 形式で指定してください。例: sendDigestFor("2026-09-08")');
  }
  var date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  sendDigestForDate_(date);
}

/** メールを送らずに、生成される素材をログで確認する。 */
function previewDigest() {
  var date = offsetDate_(new Date(), -CONFIG.DAY_OFFSET);
  var digest = buildDigest_(date);
  Logger.log('予定 ' + digest.eventCount + ' 件 / 議事録 ' + digest.docCount + ' 本' +
    ' / 送信メール ' + digest.mailCount + ' 通');
  Logger.log(digest.body);
}

// ── 素材の組み立て ──────────────────────────────────

function sendDigestForDate_(date) {
  var digest = buildDigest_(date);

  if (digest.eventCount === 0 && digest.mailCount === 0 && !CONFIG.SEND_WHEN_EMPTY) {
    Logger.log(digest.dateLabel + ' は対象の予定が無かったため、メールを送信しませんでした。');
    return;
  }

  var to = CONFIG.RECIPIENT || Session.getActiveUser().getEmail();
  GmailApp.sendEmail(to, '【日報素材】' + digest.dateLabel, digest.body);
  Logger.log(
    digest.dateLabel + ' の素材を ' + to + ' に送信しました' +
    '（予定 ' + digest.eventCount + ' 件 / 議事録 ' + digest.docCount + ' 本' +
    ' / 送信メール ' + digest.mailCount + ' 通）。'
  );
}

/**
 * 指定日の素材メール本文を組み立てる。
 * @return {{dateLabel: string, body: string, eventCount: number, docCount: number}}
 */
function buildDigest_(date) {
  var dateLabel = formatDateLabel_(date);
  var dayStart = startOfDay_(date);
  var dayEnd = offsetDate_(dayStart, 1);

  var events = collectEvents_(dayStart, dayEnd);
  var usedFileIds = {};
  var docCount = 0;
  var lines = [];

  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    var docs = findMinutesDocs_(event, dayStart, usedFileIds);
    docCount += docs.length;
    lines.push(formatEventBlock_(i + 1, event, docs));
  }

  // どの予定にも紐づかなかった議事録（会議名を変更した場合などに拾える）
  var orphans = findOrphanMinutesDocs_(dayStart, usedFileIds);
  if (orphans.length > 0) {
    docCount += orphans.length;
    lines.push('## 予定に紐づかなかった議事録');
    for (var j = 0; j < orphans.length; j++) {
      lines.push(formatDocBlock_(orphans[j]));
    }
    lines.push('');
  }

  var mails = CONFIG.INCLUDE_SENT_MAIL ? collectSentMail_(dayStart, dayEnd) : [];
  if (mails.length > 0) {
    lines.push('## 送信メール（デスクワークの記録）');
    lines.push('この日 ' + mails.length + ' 通を送信。');
    for (var m = 0; m < mails.length; m++) {
      lines.push(formatMailLine_(mails[m]));
    }
    lines.push('');
  }

  if (events.length === 0 && orphans.length === 0 && mails.length === 0) {
    lines.push('（この日は対象となる予定・議事録・送信メールがありませんでした）');
    lines.push('');
  }

  var material = truncate_(lines.join('\n'), CONFIG.MAX_TOTAL_CHARS, '\n\n（※素材が長いため、以降は省略しました）');

  var body = buildPrompt_(dateLabel) + material + [
    '',
    '────────────',
    '素材ここまで。上記のフォーマットとルールに従って日報を作成してください。'
  ].join('\n');

  return {
    dateLabel: dateLabel,
    body: body,
    eventCount: events.length,
    docCount: docCount,
    mailCount: mails.length
  };
}

// ── カレンダー ──────────────────────────────────────

/** 対象日の予定を、設定した全カレンダーから集めて時刻順に並べる。 */
function collectEvents_(dayStart, dayEnd) {
  var seen = {};
  var events = [];

  for (var c = 0; c < CONFIG.CALENDAR_IDS.length; c++) {
    var calendarId = CONFIG.CALENDAR_IDS[c];
    var response;
    try {
      response = Calendar.Events.list(calendarId, {
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 100
      });
    } catch (e) {
      Logger.log('カレンダー ' + calendarId + ' を読めませんでした: ' + e.message);
      continue;
    }

    var items = response.items || [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.status === 'cancelled') continue;

      var isAllDay = !!(item.start && item.start.date);
      if (isAllDay && !CONFIG.INCLUDE_ALL_DAY) continue;
      if (CONFIG.SKIP_DECLINED && isDeclinedBySelf_(item)) continue;

      var key = item.iCalUID || item.id;
      if (seen[key]) continue;
      seen[key] = true;

      events.push({
        raw: item,
        title: item.summary || '(タイトルなし)',
        isAllDay: isAllDay,
        start: isAllDay ? dayStart : new Date(item.start.dateTime)
      });
    }
  }

  events.sort(function (a, b) { return a.start - b.start; });
  return events;
}

/** 自分が「欠席」で回答している予定かどうか。 */
function isDeclinedBySelf_(item) {
  var attendees = item.attendees || [];
  for (var i = 0; i < attendees.length; i++) {
    if (attendees[i].self && attendees[i].responseStatus === 'declined') return true;
  }
  return false;
}

// ── 議事録の探索 ────────────────────────────────────

/**
 * 1 つの予定に紐づく議事録を集める。
 *   A. 予定に添付された Google ドキュメント（Meet が付ける文字起こし・メモを含む）
 *   B. 会議名で Drive を検索して見つかったドキュメント
 * @return {Array<{name: string, url: string, text: string, source: string}>}
 */
function findMinutesDocs_(event, dayStart, usedFileIds) {
  var docs = [];
  var attachments = event.raw.attachments || [];

  for (var i = 0; i < attachments.length; i++) {
    var attachment = attachments[i];
    if (!attachment.fileId || usedFileIds[attachment.fileId]) continue;
    usedFileIds[attachment.fileId] = true;

    var text = isGoogleDoc_(attachment.mimeType) ? fetchDocText_(attachment.fileId) : null;
    docs.push({
      name: attachment.title || '(名称不明の添付)',
      url: attachment.fileUrl || '',
      text: text,
      source: '予定の添付'
    });
  }

  var candidates = searchMinutesFiles_(dayStart);
  var needle = normalize_(event.title);
  for (var j = 0; j < candidates.length; j++) {
    var file = candidates[j];
    if (usedFileIds[file.id]) continue;
    if (!needle || normalize_(file.name).indexOf(needle) === -1) continue;
    usedFileIds[file.id] = true;

    docs.push({
      name: file.name,
      url: file.url,
      text: fetchDocText_(file.id),
      source: 'Drive（会議名で一致）'
    });
  }

  return docs;
}

/** どの予定にも紐づかなかった、当日更新の議事録を拾う。 */
function findOrphanMinutesDocs_(dayStart, usedFileIds) {
  if (CONFIG.MINUTES_FOLDER_IDS.length === 0) return []; // 全ドライブ検索時は誤検出が多いので拾わない

  var docs = [];
  var candidates = searchMinutesFiles_(dayStart);
  for (var i = 0; i < candidates.length; i++) {
    var file = candidates[i];
    if (usedFileIds[file.id]) continue;
    usedFileIds[file.id] = true;

    docs.push({
      name: file.name,
      url: file.url,
      text: fetchDocText_(file.id),
      source: '議事録フォルダ'
    });
  }
  return docs;
}

/**
 * 対象日以降に更新された Google ドキュメントの候補一覧。
 * 1 回の実行内でキャッシュして、予定ごとの再検索を避ける。
 */
function searchMinutesFiles_(dayStart) {
  var cacheKey = String(dayStart.getTime());
  if (searchMinutesFiles_.cacheKey === cacheKey) return searchMinutesFiles_.cache;

  // 会議直後に生成される文字起こしを取りこぼさないよう、翌日いっぱいまでを対象にする
  var since = Utilities.formatDate(dayStart, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
  var until = Utilities.formatDate(offsetDate_(dayStart, 2), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
  var query = "mimeType = 'application/vnd.google-apps.document'" +
    " and trashed = false" +
    " and modifiedDate >= '" + since + "'" +
    " and modifiedDate < '" + until + "'";

  var iterators = [];
  if (CONFIG.MINUTES_FOLDER_IDS.length > 0) {
    for (var i = 0; i < CONFIG.MINUTES_FOLDER_IDS.length; i++) {
      try {
        iterators.push(DriveApp.getFolderById(CONFIG.MINUTES_FOLDER_IDS[i]).searchFiles(query));
      } catch (e) {
        Logger.log('議事録フォルダ ' + CONFIG.MINUTES_FOLDER_IDS[i] + ' を開けませんでした: ' + e.message);
      }
    }
  } else {
    iterators.push(DriveApp.searchFiles(query));
  }

  var files = [];
  for (var k = 0; k < iterators.length; k++) {
    var it = iterators[k];
    while (it.hasNext() && files.length < 100) {
      var file = it.next();
      files.push({ id: file.getId(), name: file.getName(), url: file.getUrl() });
    }
  }

  searchMinutesFiles_.cacheKey = cacheKey;
  searchMinutesFiles_.cache = files;
  return files;
}

/** Google ドキュメントの本文をプレーンテキストで取得する。 */
function fetchDocText_(fileId) {
  var url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) +
    '/export?mimeType=text%2Fplain';
  try {
    var response = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
      Logger.log('ドキュメント ' + fileId + ' を読めませんでした (HTTP ' +
        response.getResponseCode() + ')');
      return null;
    }
    return response.getContentText();
  } catch (e) {
    Logger.log('ドキュメント ' + fileId + ' の取得に失敗しました: ' + e.message);
    return null;
  }
}

function isGoogleDoc_(mimeType) {
  return mimeType === 'application/vnd.google-apps.document';
}

// ── 送信メール ──────────────────────────────────────

/**
 * その日に自分が送信したメールを集める。
 * 「何時に誰へ、どんな用件を送ったか」を、会議に現れないデスクワークの記録として使う。
 * @return {Array<{sentAt: Date, to: string, cc: number, subject: string, body: string}>}
 */
function collectSentMail_(dayStart, dayEnd) {
  var myEmail = (Session.getActiveUser().getEmail() || '').toLowerCase();

  // Gmail の after:/before: は秒単位の epoch を受け付ける。日付表記と違いタイムゾーンがずれない。
  var query = 'in:sent after:' + Math.floor(dayStart.getTime() / 1000) +
    ' before:' + Math.floor(dayEnd.getTime() / 1000);
  if (CONFIG.MAIL_EXCLUDE_QUERY) query += ' ' + CONFIG.MAIL_EXCLUDE_QUERY;

  var threads;
  try {
    threads = GmailApp.search(query, 0, CONFIG.MAIL_MAX_COUNT);
  } catch (e) {
    Logger.log('送信メールを読めませんでした: ' + e.message);
    return [];
  }

  var mails = [];
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var i = 0; i < messages.length; i++) {
      var message = messages[i];
      var sentAt = message.getDate();
      if (sentAt < dayStart || sentAt >= dayEnd) continue;            // 同一スレッドの別日分を除く
      if (message.getFrom().toLowerCase().indexOf(myEmail) === -1) continue; // 相手の返信を除く

      mails.push({
        sentAt: sentAt,
        to: message.getTo(),
        cc: countAddresses_(message.getCc()),
        subject: message.getSubject() || '(件名なし)',
        body: CONFIG.MAIL_BODY_CHARS > 0
          ? truncate_(message.getPlainBody().replace(/\r\n/g, '\n').trim(), CONFIG.MAIL_BODY_CHARS, '…')
          : ''
      });
    }
  }

  mails.sort(function (a, b) { return a.sentAt - b.sentAt; });
  return mails.slice(0, CONFIG.MAIL_MAX_COUNT);
}

function countAddresses_(headerValue) {
  if (!headerValue) return 0;
  return headerValue.split(',').filter(function (part) { return part.trim() !== ''; }).length;
}

// ── 整形 ────────────────────────────────────────────

function formatEventBlock_(index, event, docs) {
  var item = event.raw;
  var lines = ['## ' + index + '. ' + formatTimeRange_(event) + ' ' + event.title];

  var attendees = formatAttendees_(item.attendees);
  if (attendees) lines.push('参加者: ' + attendees);

  if (item.location) lines.push('場所: ' + item.location);
  if (item.hangoutLink) lines.push('会議: Google Meet');
  if (item.organizer && item.organizer.email) lines.push('主催: ' + item.organizer.email);

  var description = stripHtml_(item.description);
  if (description) {
    lines.push('');
    lines.push('### 予定の説明');
    lines.push(truncate_(description, CONFIG.MAX_DOC_CHARS, '\n（※以降省略）'));
  }

  for (var i = 0; i < docs.length; i++) {
    lines.push('');
    lines.push(formatDocBlock_(docs[i]));
  }

  if (docs.length === 0 && !description) {
    lines.push('（この予定に紐づく議事録は見つかりませんでした）');
  }

  lines.push('');
  return lines.join('\n');
}

function formatDocBlock_(doc) {
  var lines = ['### 議事録: ' + doc.name + '（' + doc.source + '）'];
  if (doc.url) lines.push(doc.url);

  if (doc.text) {
    var text = doc.text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    lines.push(truncate_(text, CONFIG.MAX_DOC_CHARS, '\n（※議事録が長いため以降省略）'));
  } else {
    lines.push('（本文を読み取れませんでした。上記リンクを直接確認してください）');
  }

  return lines.join('\n');
}

function formatMailLine_(mail) {
  var line = '- ' + formatDate_(mail.sentAt, 'HH:mm') + ' 宛先: ' + mail.to;
  if (mail.cc > 0) line += '（CC ' + mail.cc + '名）';
  line += ' / 件名: ' + mail.subject;
  if (mail.body) line += '\n  ' + mail.body.replace(/\n/g, '\n  ');
  return line;
}

function formatTimeRange_(event) {
  if (event.isAllDay) return '[終日]';
  var item = event.raw;
  var start = new Date(item.start.dateTime);
  var end = item.end && item.end.dateTime ? new Date(item.end.dateTime) : null;
  var text = formatDate_(start, 'HH:mm');
  if (end) text += '-' + formatDate_(end, 'HH:mm');
  return text;
}

function formatAttendees_(attendees) {
  if (!attendees || attendees.length === 0) return '';

  var people = [];
  for (var i = 0; i < attendees.length; i++) {
    var attendee = attendees[i];
    if (attendee.resource) continue; // 会議室などのリソースは人数に数えない
    people.push(attendee.displayName || attendee.email);
  }
  if (people.length === 0) return '';

  var names = people.slice(0, 12);
  if (people.length > names.length) names.push('ほか' + (people.length - names.length) + '名');
  return names.join(', ');
}

// ── ユーティリティ ──────────────────────────────────

function stripHtml_(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate_(text, limit, suffix) {
  if (!text || text.length <= limit) return text;
  return text.substring(0, limit) + (suffix || '…');
}

/** 会議名と議事録名を突き合わせるための正規化（記号・空白・大小文字の差を吸収）。 */
function normalize_(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s　_\-–—:：/／|｜()（）\[\]【】]/g, '');
}

function startOfDay_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function offsetDate_(date, days) {
  var result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

function formatDate_(date, pattern) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), pattern);
}

var WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * 「2026年09月09日(水)」形式の日付ラベル。
 * Utilities.formatDate の 'E' はロケール依存で英語の略称（Wed）を返すため、曜日は自前で付ける。
 */
function formatDateLabel_(date) {
  return formatDate_(date, 'yyyy年MM月dd日') + '(' + WEEKDAYS_JA[date.getDay()] + ')';
}

// ── トリガー管理 ────────────────────────────────────

/** 毎日 CONFIG.TRIGGER_HOUR 時に自動実行するトリガーを作る（既存のものは作り直す）。 */
function createDailyTrigger() {
  deleteTriggers();
  ScriptApp.newTrigger('sendDailyDigest')
    .timeBased()
    .atHour(CONFIG.TRIGGER_HOUR)
    .nearMinute(0)
    .everyDays(1)
    .create();
  Logger.log('毎日 ' + CONFIG.TRIGGER_HOUR + ' 時台に実行するトリガーを設定しました。');
}

/** このスクリプトのトリガーを全て削除する。 */
function deleteTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }
  Logger.log(triggers.length + ' 件のトリガーを削除しました。');
}
