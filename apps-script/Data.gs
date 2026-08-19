/** Workout Logger - Drive persistence, collection, and strength index. */

function saveStrengthSession_(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const folder = DriveApp.getFolderById(STRENGTH_FOLDER_ID);
    const now = new Date();
    const workoutDate = parseDate_(data.finished_at || data.started_at || data.workout_date || now);
    const safeDate = workoutDate.getTime() > 0 ? workoutDate : now;
    const yearMonth = Utilities.formatDate(safeDate,TIME_ZONE,'yyyy-MM');
    const timestamp = Utilities.formatDate(safeDate,TIME_ZONE,'yyyy-MM-dd_HHmmss');
    const monthFolder = getOrCreateFolder_(folder,yearMonth);

    let suffix = '';
    if (data.session_id) {
      const safe = String(data.session_id).replace(/[^a-zA-Z0-9_-]/g,'').substring(0,12);
      if (safe) suffix = '-' + safe;
    }

    const fileName = `strength-${timestamp}${suffix}.json`;

    // 인증/요청 제어용 필드는 운동 원본 JSON에 저장하지 않습니다.
    const persistedData = JSON.parse(JSON.stringify(data || {}));
    delete persistedData.auth_token;
    delete persistedData.action;
    delete persistedData.password;

    const file = monthFolder.createFile(
      fileName,
      JSON.stringify(persistedData,null,2),
      MimeType.PLAIN_TEXT
    );

    // 원본 파일 저장이 성공한 뒤에만 조회용 인덱스를 갱신합니다.
    const indexedSession = attachStrengthDriveMeta_(persistedData, file);
    upsertStrengthIndexByFileId_(folder, indexedSession);

    return {
      ok:true,
      fileName:fileName,
      file_id:file.getId()
    };
  } finally {
    lock.releaseLock();
  }
}

function listStrengthSessions_() {
  const root = DriveApp.getFolderById(STRENGTH_FOLDER_ID);
  let index = readStrengthIndex_(root);

  // 최초 적용, 인덱스 유실/손상 시에만 원본 JSON 전체를 읽어 복구합니다.
  if (!index) {
    index = rebuildStrengthIndexInternal_(root);
  }

  const sessions = Array.isArray(index.sessions)
    ? index.sessions.slice()
    : [];

  sessions.sort((a,b)=>getSessionTimestamp_(a)-getSessionTimestamp_(b));

  // 기존 PWA 응답 형식을 그대로 유지합니다.
  return {
    ok:true,
    count:sessions.length,
    sessions:sessions.slice(-300),
    source:'strength_index',
    index_updated_at:index.updated_at || null
  };
}

function rebuildStrengthIndex_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const root = DriveApp.getFolderById(STRENGTH_FOLDER_ID);
    const index = rebuildStrengthIndexInternal_(root);
    console.log(
      'Strength index 재생성 완료: ' +
      String(index.session_count || 0) +
      ' sessions'
    );
    return index;
  } finally {
    lock.releaseLock();
  }
}

function rebuildStrengthIndexInternal_(root) {
  const sessions = [];
  collectStrengthRecords_(root, sessions);
  sessions.sort((a,b)=>getSessionTimestamp_(a)-getSessionTimestamp_(b));

  const index = {
    schema_version: STRENGTH_INDEX_SCHEMA_VERSION_,
    type: 'strength_recent_index',
    generated_from: 'individual_strength_json_files',
    updated_at: formatIso_(new Date()),
    session_count: sessions.length,
    sessions: sessions
  };

  writeStrengthIndex_(root, index);
  return index;
}

function readStrengthIndex_(root) {
  const files = root.getFilesByName(STRENGTH_INDEX_FILE_NAME_);
  if (!files.hasNext()) return null;

  const file = files.next();

  try {
    const index = JSON.parse(file.getBlob().getDataAsString('UTF-8'));

    if (
      !index ||
      Number(index.schema_version) !== STRENGTH_INDEX_SCHEMA_VERSION_ ||
      !Array.isArray(index.sessions)
    ) {
      console.log('Strength index 형식이 올바르지 않아 재생성이 필요합니다.');
      return null;
    }

    return index;
  } catch (e) {
    console.log('Strength index 읽기 실패: ' + e);
    return null;
  }
}

function writeStrengthIndex_(root, index) {
  const payload = Object.assign({}, index, {
    schema_version: STRENGTH_INDEX_SCHEMA_VERSION_,
    type: 'strength_recent_index',
    updated_at: formatIso_(new Date()),
    session_count: Array.isArray(index.sessions) ? index.sessions.length : 0
  });

  const content = JSON.stringify(payload, null, 2);
  const files = root.getFilesByName(STRENGTH_INDEX_FILE_NAME_);

  if (files.hasNext()) {
    const file = files.next();
    file.setContent(content);

    // 같은 이름의 중복 인덱스가 생겼다면 첫 파일만 유지합니다.
    while (files.hasNext()) {
      try {
        files.next().setTrashed(true);
      } catch (_) {}
    }
  } else {
    root.createFile(
      STRENGTH_INDEX_FILE_NAME_,
      content,
      MimeType.PLAIN_TEXT
    );
  }

  return payload;
}

function attachStrengthDriveMeta_(data, file) {
  const session = JSON.parse(JSON.stringify(data || {}));
  session.drive_file_id = file.getId();
  session.drive_file_name = file.getName();
  session.drive_file_updated_at = formatIso_(file.getLastUpdated());
  return session;
}

function upsertStrengthIndexByFileId_(root, session) {
  let index = readStrengthIndex_(root);

  // 인덱스가 없거나 손상된 상태에서 저장이 들어오면 원본에서 먼저 복구합니다.
  if (!index) {
    index = rebuildStrengthIndexInternal_(root);
    return index;
  }

  const sessions = index.sessions.slice();
  const fileId = String(session && session.drive_file_id || '');

  if (!fileId) {
    throw new Error('Strength index 갱신에 필요한 Drive 파일 ID가 없습니다.');
  }

  const pos = sessions.findIndex(function(item) {
    return String(item && item.drive_file_id || '') === fileId;
  });

  if (pos >= 0) {
    sessions[pos] = session;
  } else {
    sessions.push(session);
  }

  sessions.sort((a,b)=>getSessionTimestamp_(a)-getSessionTimestamp_(b));

  index.sessions = sessions;
  return writeStrengthIndex_(root, index);
}

function removeStrengthIndexByFileId_(root, fileId) {
  let index = readStrengthIndex_(root);

  // 삭제 대상 원본은 이미 휴지통으로 이동된 뒤이므로,
  // 인덱스가 없으면 현재 남아 있는 원본 파일 기준으로 재생성하면 됩니다.
  if (!index) {
    return rebuildStrengthIndexInternal_(root);
  }

  const target = String(fileId || '');
  index.sessions = index.sessions.filter(function(item) {
    return String(item && item.drive_file_id || '') !== target;
  });

  return writeStrengthIndex_(root, index);
}

function collectAnalysis_(folder,arr){const files=folder.getFiles();while(files.hasNext()){const f=files.next();if(!/^analysis-.*\.json$/i.test(f.getName()))continue;try{arr.push(JSON.parse(f.getBlob().getDataAsString('UTF-8')));}catch(e){}}const subs=folder.getFolders();while(subs.hasNext())collectAnalysis_(subs.next(),arr);}

function collectJsonFiles_(folder,from,to,type){const arr=[];collectJsonFilesRecursive_(folder,from,to,type,arr);return arr;}

function collectJsonFilesRecursive_(folder,from,to,type,arr){const files=folder.getFiles();while(files.hasNext()){const f=files.next();if(!/\.json$/i.test(f.getName()))continue;if(type==='strength'&&!/^strength-.*\.json$/i.test(f.getName()))continue;if(type==='nutrition'&&!/^nutrition-.*\.json$/i.test(f.getName()))continue;try{const blob=f.getBlob();const data=JSON.parse(blob.getDataAsString('UTF-8'));const t=inferJsonTimestamp_(data,f);if(t>=from&&t<=to)arr.push({file_id:f.getId(),name:f.getName(),size_bytes:blob.getBytes().length,modified_at:formatIso_(f.getLastUpdated()),timestamp:t.getTime(),data:data});}catch(e){console.log('JSON 읽기 실패 '+f.getName()+': '+e);}}const subs=folder.getFolders();while(subs.hasNext()){const sf=subs.next();if(type==='strength'&&(sf.getName()===ANALYSIS_FOLDER_NAME||sf.getName()===BASELINE_FOLDER_NAME))continue;collectJsonFilesRecursive_(sf,from,to,type,arr);}}

function inferJsonTimestamp_(data,file){if(data&&data.date&&Array.isArray(data.meals))return parseDate_(String(data.date).slice(0,10)+'T23:59:59+09:00');if(data&&Array.isArray(data.exercises))return parseDate_(data.finished_at||data.started_at||file.getLastUpdated());const w=data&&data.data&&data.data.workouts;if(w&&w.length)return parseDate_(w[w.length-1].end||w[w.length-1].start||file.getLastUpdated());const m=data&&data.data&&data.data.metrics;if(m){let latest=0;m.forEach(x=>(x.data||[]).forEach(v=>{const t=parseDate_(v.date).getTime();if(t>latest)latest=t;}));if(latest)return new Date(latest);}const match=file.getName().match(/(20\d{2})-(\d{2})-(\d{2})/);if(match)return new Date(match[1]+'-'+match[2]+'-'+match[3]+'T23:59:59+09:00');return file.getLastUpdated();}

function newestTimestamp_(arr){return arr.length?Math.max.apply(null,arr.map(x=>x.timestamp||0)):0;}

function collectStrengthRecords_(folder,sessions) {
  const files = folder.getFiles();

  while (files.hasNext()) {
    const f = files.next();
    if (!/^strength-.*\.json$/i.test(f.getName())) continue;

    try {
      const d = JSON.parse(f.getBlob().getDataAsString('UTF-8'));
      if (d && Array.isArray(d.exercises)) {
        d.drive_file_id = f.getId();
        d.drive_file_name = f.getName();
        d.drive_file_updated_at = formatIso_(f.getLastUpdated());
        sessions.push(d);
      }
    } catch (e) {
      console.log('근력운동 기록 읽기 실패 ' + f.getName() + ': ' + e);
    }
  }

  const subs = folder.getFolders();
  while (subs.hasNext()) {
    const sf = subs.next();
    if (
      sf.getName() !== ANALYSIS_FOLDER_NAME &&
      sf.getName() !== BASELINE_FOLDER_NAME
    ) {
      collectStrengthRecords_(sf, sessions);
    }
  }
}

function deleteStrengthFile_(fileId) {
  if (!fileId) {
    throw new Error('삭제할 Drive 파일 ID가 없습니다.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const root = DriveApp.getFolderById(STRENGTH_FOLDER_ID);
    const file = findStrengthFileById_(root, String(fileId));

    if (!file) {
      throw new Error('근력운동 폴더에서 해당 파일을 찾을 수 없습니다.');
    }

    if (!/^strength-.*\.json$/i.test(file.getName())) {
      throw new Error('근력운동 기록 JSON 파일만 삭제할 수 있습니다.');
    }

    const deletedFileName = file.getName();

    // 원본 삭제가 성공한 뒤에만 조회용 인덱스에서 해당 Drive 파일 ID를 제거합니다.
    file.setTrashed(true);
    removeStrengthIndexByFileId_(root, String(fileId));

    return {
      ok: true,
      file_id: String(fileId),
      file_name: deletedFileName
    };
  } finally {
    lock.releaseLock();
  }
}

function findStrengthFileById_(folder, targetFileId) {
  const files = folder.getFiles();

  while (files.hasNext()) {
    const file = files.next();
    if (file.getId() === targetFileId) {
      return file;
    }
  }

  const subs = folder.getFolders();
  while (subs.hasNext()) {
    const sub = subs.next();

    if (
      sub.getName() === ANALYSIS_FOLDER_NAME ||
      sub.getName() === BASELINE_FOLDER_NAME
    ) {
      continue;
    }

    const found = findStrengthFileById_(sub, targetFileId);
    if (found) return found;
  }

  return null;
}

function getSessionTimestamp_(s){return parseDate_(s.finished_at||s.started_at||s.created_at||s.date||0).getTime();}

function getOrCreateFolder_(parent,name){const f=parent.getFoldersByName(name);return f.hasNext()?f.next():parent.createFolder(name);}
