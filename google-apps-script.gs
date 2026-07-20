/**
 * 근력 운동 기록용 Google Apps Script v4
 *
 * 중요:
 * - 기존에 사용 중인 DRIVE_FOLDER_ID 값은 그대로 유지하세요.
 * - 코드 수정 후: 배포 > 배포 관리 > 편집 > 새 버전 > 배포
 * - 기존 /exec URL을 유지할 수 있습니다.
 */

const DRIVE_FOLDER_ID = '1-Qfa2hYLBCiq6TW2IemLQ31AtUpFdWAR';

function jsonOutput(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const raw = e.postData && e.postData.contents ? e.postData.contents : '{}';
    const data = JSON.parse(raw);

    if (!data || !Array.isArray(data.exercises)) {
      throw new Error('올바른 운동 기록 JSON이 아닙니다.');
    }

    const root = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    const tz = Session.getScriptTimeZone() || 'Asia/Seoul';
    const now = new Date();
    const monthName = Utilities.formatDate(now, tz, 'yyyy-MM');
    const stamp = Utilities.formatDate(now, tz, 'yyyy-MM-dd_HHmmss');

    const monthFolders = root.getFoldersByName(monthName);
    const target = monthFolders.hasNext() ? monthFolders.next() : root.createFolder(monthName);

    const sessionId = data.session_id ? String(data.session_id).replace(/[^a-zA-Z0-9_-]/g, '') : '';
    const suffix = sessionId ? `-${sessionId.slice(0, 8)}` : '';
    const fileName = `strength-${stamp}${suffix}.json`;

    target.createFile(fileName, JSON.stringify(data, null, 2), MimeType.PLAIN_TEXT);

    return jsonOutput({ ok: true, file: fileName });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  try {
    const action = e && e.parameter ? e.parameter.action : '';

    if (action !== 'list') {
      return jsonOutput({
        ok: true,
        message: 'Workout Logger endpoint is running.'
      });
    }

    const root = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    const sessions = [];
    collectStrengthFiles(root, sessions);

    sessions.sort(function(a, b) {
      const da = new Date(a.finished_at || a.started_at || 0).getTime();
      const db = new Date(b.finished_at || b.started_at || 0).getTime();
      return da - db;
    });

    return jsonOutput({
      ok: true,
      count: sessions.length,
      sessions: sessions.slice(-300)
    });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err), sessions: [] });
  }
}

function collectStrengthFiles(folder, sessions) {
  const files = folder.getFiles();

  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();

    if (!/^strength-.*\.json$/i.test(name)) continue;

    try {
      const data = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
      if (data && Array.isArray(data.exercises)) {
        sessions.push(data);
      }
    } catch (ignore) {
      // 손상되었거나 다른 형식인 JSON은 건너뜁니다.
    }
  }

  const subfolders = folder.getFolders();
  while (subfolders.hasNext()) {
    collectStrengthFiles(subfolders.next(), sessions);
  }
}
