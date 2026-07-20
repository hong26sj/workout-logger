
const $ = (id) => document.getElementById(id);
const DEFAULT_GAS_URL = "https://script.google.com/macros/s/AKfycbxsQLOyMwtGe2lM8oTl6ABjH_WKM1ko2OUKPy0NjCtdLmYVE4ly9NKIq2C7QI58WhZELA/exec";

function getGasUrl(){
  return (localStorage.getItem("gasUrl") || DEFAULT_GAS_URL).trim();
}
const state = {
  current: [],
  sessions: [],
  pendingSync: [],
  editingIndex: null
};

// 최근 기록은 Google Drive를 단일 원본으로 사용합니다.
// 이전 버전에서 아이폰 localStorage에 남긴 기록은 화면 중복을 막기 위해 제거합니다.
localStorage.removeItem("workoutSessions");
localStorage.removeItem("pendingSync");

const DEFAULT_EXERCISES = [
  "체스트프레스","벤치프레스","인클라인 체스트프레스","푸쉬업",
  "랫풀다운","시티드로우","원암로우","풀업",
  "숄더프레스","사이드레터럴레이즈","리어델트플라이",
  "스쿼트","레그프레스","레그익스텐션","레그컬","런지",
  "힙쓰러스트","플랭크","크런치","레그레이즈",
  "트레드밀 걷기","실내자전거","일립티컬"
];

function isoLocal() {
  const d = new Date();
  const p = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function localDateValue(d = new Date()) {
  const p=n=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}
function selectedWorkoutDate(){
  return $("workoutDate").value || localDateValue();
}
function isoForWorkoutDate(){
  const now=new Date();
  const p=n=>String(n).padStart(2,"0");
  return `${selectedWorkoutDate()}T${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}
function updateWorkoutDateUi(){
  const date=selectedWorkoutDate();
  $("todayLabel").textContent=dateLabel(`${date}T12:00:00`);
  $("saveSessionBtn").textContent=`${date} 기록 저장`;
}

function dateLabel(iso = new Date().toISOString()) {
  return new Intl.DateTimeFormat("ko-KR",{year:"numeric",month:"long",day:"numeric",weekday:"short"}).format(new Date(iso));
}
function toast(msg) {
  const el=$("toast"); el.textContent=msg; el.classList.add("show");
  setTimeout(()=>el.classList.remove("show"),2200);
}
function valNum(id){ const v=$(id).value; return v===""?null:Number(v); }
function cleanText(id){ return $(id).value.trim(); }


function getExerciseHistory(name){
  const key=name.trim().toLowerCase();
  const found=[];
  for(const s of state.sessions){
    for(const ex of (s.exercises||[])){
      if((ex.exercise||"").trim().toLowerCase()===key) {
        found.push({...ex,session_at:s.finished_at||s.started_at});
      }
    }
  }
  return found.sort((a,b)=>new Date(b.session_at)-new Date(a.session_at));
}

function renderExerciseOptions(){
  const names=new Set(DEFAULT_EXERCISES);
  state.sessions.forEach(s=>(s.exercises||[]).forEach(ex=>names.add(ex.exercise)));
  $("exerciseOptions").innerHTML=[...names].filter(Boolean).sort((a,b)=>a.localeCompare(b,"ko"))
    .map(n=>`<option value="${escapeHtml(n)}"></option>`).join("");
}

function showPreviousRecord(){
  const name=cleanText("exerciseName");
  const box=$("previousRecord");
  if(!name){box.classList.add("hidden");box.innerHTML="";return;}
  const hist=getExerciseHistory(name);
  if(!hist.length){
    box.classList.remove("hidden");
    box.innerHTML="이 운동의 이전 기록이 없습니다.";
    return;
  }
  const prev=hist[0];
  box.classList.remove("hidden");
  box.innerHTML=`<strong>최근 기록</strong><br>${dateLabel(prev.session_at)} · ${summary(prev)}${prev.rpe?` · RPE ${prev.rpe}`:""}`;
}

function updateSyncStatus(){
  const el=$("syncStatus");
  if(!getGasUrl()){
    el.className="sync-status status-warn";
    el.textContent="Google Drive URL이 설정되지 않았습니다.";
  }else{
    el.className="sync-status status-ok";
    el.textContent="Google Drive 연동 설정됨";
  }
}

function updateFields(){
  const type=$("recordType").value;
  $("weightedFields").classList.toggle("hidden",type!=="weighted");
  $("bodyweightFields").classList.toggle("hidden",type!=="bodyweight");
  $("timedFields").classList.toggle("hidden",type!=="timed");
}

function buildExercise(){
  const exercise=cleanText("exerciseName");
  const record_type=$("recordType").value;
  if(!exercise) throw new Error("운동명을 입력하세요.");
  const base={
    exercise, record_type,
    weight_kg:0, reps:0, sets:0, seconds:0,
    rpe:valNum("rpe"),
    pain_level:valNum("painLevel") ?? 0,
    pain_area:cleanText("painArea") || "없음",
    memo:cleanText("memo"),
    recorded_at:isoForWorkoutDate()
  };
  if(record_type==="weighted"){
    base.weight_kg=valNum("weightKg");
    base.reps=valNum("repsWeighted");
    base.sets=valNum("setsWeighted");
    if(base.weight_kg===null || !base.reps || !base.sets) throw new Error("무게·횟수·세트를 입력하세요.");
  }else if(record_type==="bodyweight"){
    base.reps=valNum("repsBodyweight");
    base.sets=valNum("setsBodyweight");
    if(!base.reps || !base.sets) throw new Error("횟수·세트를 입력하세요.");
  }else{
    base.seconds=valNum("secondsTimed");
    base.sets=valNum("setsTimed");
    if(!base.seconds || !base.sets) throw new Error("시간·세트를 입력하세요.");
  }
  return base;
}

function summary(ex){
  if(ex.record_type==="weighted") return `${ex.weight_kg}kg × ${ex.reps}회 × ${ex.sets}세트`;
  if(ex.record_type==="bodyweight") return `${ex.reps}회 × ${ex.sets}세트`;
  return `${ex.seconds}초 × ${ex.sets}세트`;
}

function resetEntry(){
  ["exerciseName","weightKg","repsWeighted","repsBodyweight","secondsTimed","rpe","painArea","memo"].forEach(id=>$(id).value="");
  $("painLevel").value=0;
  $("setsWeighted").value=3;$("setsBodyweight").value=3;$("setsTimed").value=3;
  $("exerciseName").focus();
}


function fillFormFromExercise(ex){
  $("exerciseName").value=ex.exercise||"";
  $("recordType").value=ex.record_type||"weighted";
  updateFields();

  $("weightKg").value=ex.weight_kg||0;
  $("repsWeighted").value=ex.reps||"";
  $("setsWeighted").value=ex.sets||3;

  $("repsBodyweight").value=ex.reps||"";
  $("setsBodyweight").value=ex.sets||3;

  $("secondsTimed").value=ex.seconds||"";
  $("setsTimed").value=ex.sets||3;

  $("rpe").value=ex.rpe ?? "";
  $("painLevel").value=ex.pain_level ?? 0;
  $("painArea").value=(ex.pain_area && ex.pain_area!=="없음") ? ex.pain_area : "";
  $("memo").value=ex.memo||"";

  showPreviousRecord();
  window.scrollTo({top:0,behavior:"smooth"});
}

function startEditExercise(index){
  state.editingIndex=index;
  fillFormFromExercise(state.current[index]);
  $("addExerciseBtn").textContent="수정 완료";
  $("cancelEditBtn").classList.remove("hidden");
}

function cancelEdit(){
  state.editingIndex=null;
  $("addExerciseBtn").textContent="운동 추가";
  $("cancelEditBtn").classList.add("hidden");
  resetEntry();
}

function loadSessionToSelectedDate(sessionIndex){
  const session=state.sessions[sessionIndex];
  if(!session || !(session.exercises||[]).length) return;

  if(state.current.length && !confirm("현재 입력 목록이 있습니다. 최근 기록으로 교체할까요?")) return;

  const now=isoForWorkoutDate();
  state.current=(session.exercises||[]).map(ex=>({
    ...ex,
    recorded_at:now,
    rpe:null,
    pain_level:0,
    pain_area:"없음",
    memo:""
  }));
  cancelEdit();
  renderCurrent();
  toast("최근 기록을 선택한 날짜로 불러왔습니다.");
  window.scrollTo({top:0,behavior:"smooth"});
}

function renderCurrent(){
  $("exerciseCount").textContent=`${state.current.length}개`;
  $("emptyState").style.display=state.current.length?"none":"block";
  $("saveSessionBtn").disabled=!state.current.length;
  $("clearBtn").disabled=!state.current.length;
  $("exerciseList").innerHTML=state.current.map((ex,i)=>`
    <article class="exercise-item">
      <div class="item-head">
        <div>
          <div class="item-title">${escapeHtml(ex.exercise)}</div>
          <div class="item-meta">${summary(ex)}${ex.rpe?` · RPE ${ex.rpe}`:""}${ex.pain_level?` · 통증 ${ex.pain_level}/10`:""}</div>
        </div>
        <div class="item-buttons">
          <button class="edit-btn" data-edit="${i}">수정</button>
          <button class="delete-btn" data-index="${i}">삭제</button>
        </div>
      </div>
    </article>`).join("");

  document.querySelectorAll(".edit-btn").forEach(btn=>{
    btn.onclick=()=>startEditExercise(Number(btn.dataset.edit));
  });

  document.querySelectorAll(".delete-btn").forEach(btn=>btn.onclick=()=>{
    const idx=Number(btn.dataset.index);
    state.current.splice(idx,1);
    if(state.editingIndex===idx) cancelEdit();
    else if(state.editingIndex!==null && state.editingIndex>idx) state.editingIndex--;
    renderCurrent();
  });
}

function renderHistory(){
  if(!state.sessions.length){
    $("historyList").innerHTML='<div class="empty">저장된 기록이 없습니다.</div>';
    return;
  }

  $("historyList").innerHTML=state.sessions.slice().reverse().map((s,ri)=>{
    const i=state.sessions.length-1-ri;
    return `<article class="history-item">
      <div class="item-head">
        <div>
          <div class="item-title">${dateLabel(s.started_at)}</div>
          <div class="item-meta">${s.exercises.length}종목 · ${s.exercises.map(e=>escapeHtml(e.exercise)).join(", ")}</div>
        </div>
      </div>
      <div class="history-button-row">
        <button data-load="${i}" class="load-btn">오늘로 불러오기</button>
        <button data-export="${i}" class="secondary">내보내기</button>
        <button data-delete-session="${i}" class="delete-btn">Drive 삭제</button>
      </div>
    </article>`;
  }).join("");

  document.querySelectorAll("[data-load]").forEach(btn=>{
    btn.onclick=()=>loadSessionToSelectedDate(Number(btn.dataset.load));
  });

  document.querySelectorAll("[data-export]").forEach(btn=>{
    btn.onclick=()=>downloadJSON(state.sessions[Number(btn.dataset.export)]);
  });

  document.querySelectorAll("[data-delete-session]").forEach(btn=>{
    btn.onclick=()=>deleteDriveSession(Number(btn.dataset.deleteSession));
  });
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));}

function downloadJSON(obj, filename){
  const stamp=(obj.started_at||isoLocal()).replace(/[:T]/g,"-").slice(0,19);
  const blob=new Blob([JSON.stringify(obj,null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=filename||`strength-${stamp}.json`;a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
async function syncToDrive(session){
  const url=getGasUrl();
  if(!url) return false;
  try{
    const response=await fetch(url,{
      method:"POST",
      headers:{"Content-Type":"text/plain;charset=UTF-8"},
      body:JSON.stringify(session),
      redirect:"follow"
    });
    const result=await response.json();
    if(!result.ok) throw new Error(result.error||"Drive 저장 실패");
    return result;
  }catch(e){
    return false;
  }
}


function sessionKey(session){
  if(session.session_id) return `id:${session.session_id}`;
  return `fallback:${session.started_at||""}|${session.finished_at||""}|${JSON.stringify(session.exercises||[])}`;
}

function setDriveSessions(incoming){
  const map=new Map();
  (incoming||[]).forEach(session=>{
    if(session && Array.isArray(session.exercises)){
      map.set(sessionKey(session), session);
    }
  });
  state.sessions=[...map.values()].sort((a,b)=>
    new Date(a.finished_at||a.started_at||0)-new Date(b.finished_at||b.started_at||0)
  );
  renderHistory();
  renderExerciseOptions();
}

async function loadDriveSessions(showMessage=true){
  const url=getGasUrl();
  if(!url) return false;

  const status=$("syncStatus");
  status.className="sync-status status-loading";
  status.textContent="Google Drive 기록을 불러오는 중...";

  try{
    const separator=url.includes("?")?"&":"?";
    const response=await fetch(`${url}${separator}action=list&t=${Date.now()}`,{
      method:"GET",
      cache:"no-store",
      redirect:"follow"
    });
    if(!response.ok) throw new Error(`HTTP ${response.status}`);

    const result=await response.json();
    if(!result.ok) throw new Error(result.error||"Drive 조회 실패");

    setDriveSessions(result.sessions||[]);
    updateSyncStatus();
    if(showMessage) toast(`Drive 기록 ${result.sessions?.length||0}건을 확인했습니다.`);
    return true;
  }catch(error){
    status.className="sync-status status-warn";
    status.textContent="Drive 기록을 불러오지 못했습니다. Apps Script 배포를 확인하세요.";
    if(showMessage) toast("Drive 기록 불러오기 실패");
    return false;
  }
}

async function retryPendingSync(){
  updateSyncStatus();
}

async function deleteDriveSession(sessionIndex){
  const session=state.sessions[sessionIndex];
  if(!session) return;

  const fileId=session.drive_file_id || session._drive_file_id || session.file_id;
  if(!fileId){
    toast("Drive 파일 ID가 없어 삭제할 수 없습니다. Drive 새로고침 후 다시 시도하세요.");
    return;
  }

  if(!confirm(`${dateLabel(session.started_at)} 기록을 Google Drive에서도 삭제할까요?`)) return;

  try{
    const response=await fetch(getGasUrl(),{
      method:"POST",
      headers:{"Content-Type":"text/plain;charset=UTF-8"},
      body:JSON.stringify({action:"delete_strength",file_id:fileId}),
      redirect:"follow"
    });
    const result=await response.json();
    if(!result.ok) throw new Error(result.error||"삭제 실패");

    toast("Google Drive에서 삭제했습니다.");
    await loadDriveSessions(false);
  }catch(error){
    toast(`삭제 실패: ${error.message}`);
  }
}

$("recordType").addEventListener("change",updateFields);
$("exerciseName").addEventListener("input",showPreviousRecord);
$("exerciseName").addEventListener("change",showPreviousRecord);
$("addExerciseBtn").onclick=()=>{
  try{
    const ex=buildExercise();
    if(state.editingIndex===null){
      state.current.push(ex);
      toast("운동을 추가했습니다.");
    }else{
      state.current[state.editingIndex]=ex;
      toast("운동 기록을 수정했습니다.");
    }
    renderCurrent();
    cancelEdit();
  }catch(e){
    toast(e.message);
  }
};
$("clearBtn").onclick=()=>{
  if(confirm("입력 목록을 모두 비울까요?")){
    state.current=[];
    cancelEdit();
    renderCurrent();
  }
};
$("cancelEditBtn").onclick=cancelEdit;
$("saveSessionBtn").onclick=async()=>{
  if(!state.current.length)return;
  const finishedAt=isoForWorkoutDate();
  const session={
    schema_version:3,
    session_id:crypto.randomUUID(),
    source:"workout_logger_pwa",
    workout_date:selectedWorkoutDate(),
    entered_at:isoLocal(),
    started_at:state.current[0].recorded_at || finishedAt,
    finished_at:finishedAt,
    exercises:state.current.map(ex=>({...ex,recorded_at:ex.recorded_at||finishedAt}))
  };
  const synced=await syncToDrive(session);
  if(!synced){
    toast("Drive 저장에 실패했습니다. 입력 목록은 유지됩니다.");
    updateSyncStatus();
    return;
  }
  state.current=[];
  renderCurrent();
  await loadDriveSessions(false);
  updateSyncStatus();
  toast("Google Drive에 저장했습니다.");
};
$("exportAllBtn").onclick=()=>downloadJSON({schema_version:1,exported_at:isoLocal(),sessions:state.sessions},"workout-history.json");
$("settingsBtn").onclick=()=>{$("gasUrl").value=getGasUrl();$("settingsDialog").showModal();};
$("saveSettingsBtn").onclick=()=>{
  const value=$("gasUrl").value.trim();
  if(value && value!==DEFAULT_GAS_URL) localStorage.setItem("gasUrl",value);
  else localStorage.removeItem("gasUrl");
  updateSyncStatus();
  toast("설정을 저장했습니다.");
};
const refreshDriveBtn = $("refreshDriveBtn");
if (refreshDriveBtn) {
  refreshDriveBtn.onclick = () => loadDriveSessions(true);
}
$("workoutDate").value=localDateValue();
$("workoutDate").max=localDateValue();
$("workoutDate").addEventListener("change",()=>{ updateWorkoutDateUi(); if(state.current.length){ const stamp=isoForWorkoutDate(); state.current=state.current.map(ex=>({...ex,recorded_at:stamp})); } });
updateWorkoutDateUi();
updateFields();renderCurrent();renderHistory();renderExerciseOptions();updateSyncStatus();
loadDriveSessions(false).finally(()=>retryPendingSync());

if ("serviceWorker" in navigator) {
  let reloadingForUpdate = false;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    window.location.reload();
  });

  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("service-worker.js", {
        updateViaCache: "none"
      });

      // 앱을 열 때마다 새 서비스워커가 있는지 확인합니다.
      await registration.update();

      // 백그라운드에서 오래 열어둔 경우에도 주기적으로 업데이트를 확인합니다.
      window.setInterval(() => registration.update(), 60 * 60 * 1000);

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") registration.update();
      });
    } catch (error) {
      console.warn("서비스워커 등록 또는 업데이트 확인 실패:", error);
    }
  });
}

const analysisState={latest:null,running:false};
function formatMetric(v,suffix=''){return v===null||v===undefined?'자료 없음':`${v}${suffix}`;}
function listHtml(items){return (items&&items.length)?`<ul class="analysis-list">${items.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul>`:'<p>특이사항 없음</p>';}
function analysisSection(title, content, open=false){
  return `<details class="analysis-block"${open?' open':''}><summary>${escapeHtml(title)}</summary><div class="analysis-body">${content}</div></details>`;
}
function renderLatestAnalysis(analysis){
  analysisState.latest=analysis||null;
  if(!analysis){$("analysisBadge").textContent='분석 없음';$("analysisResult").innerHTML='<div class="empty">저장된 AI 분석이 없습니다.</div>';return;}
  const a=analysis.ai_analysis||{},w=analysis.weight_loss_analysis||{},p=analysis.next_plan||{},stats=analysis.statistics||{},body=stats.body||{},activity=stats.activity||{},strength=stats.strength||{};
  $("analysisBadge").textContent=new Date(analysis.created_at).toLocaleDateString('ko-KR');
  const sessions=(p.sessions||[]).map(s=>`<div class="plan-session"><strong>${escapeHtml(s.day_label)} · ${escapeHtml(s.focus)}</strong>${(s.exercises||[]).map(ex=>`<div class="plan-exercise">${escapeHtml(ex.exercise)} · ${ex.sets}세트${ex.reps?` × ${ex.reps}회`:''}${ex.seconds?` × ${ex.seconds}초`:''}${ex.suggested_weight_kg!==null&&ex.suggested_weight_kg!==undefined?` · ${ex.suggested_weight_kg}kg`:''}${ex.target_rpe?` · RPE ${ex.target_rpe}`:''}<br>${escapeHtml(ex.reason||'')}</div>`).join('')}</div>`).join('');
  $("analysisResult").innerHTML=`
    <div class="analysis-meta">분석기간: ${escapeHtml(analysis.period?.from||'')} ~ ${escapeHtml(analysis.period?.to||'')}<br>추가 요청: ${escapeHtml(analysis.additional_request||'없음')}</div>
    ${analysisSection('현재 수치', `<p>체중 ${formatMetric(body.weight_latest_kg,'kg')} · 변화 ${formatMetric(body.weight_change_kg,'kg')}<br>일평균 걸음 ${formatMetric(activity.steps_daily_average,'걸음')} · 운동 ${formatMetric(stats.fitness?.total_minutes,'분')}<br>근력 ${formatMetric(strength.session_count,'회')} · 볼륨 ${formatMetric(strength.total_volume_kg,'kg')}</p>`, true)}
    ${analysisSection('운동 현황', `<p>${escapeHtml(a.summary||'')}</p>${listHtml(a.progress)}${listHtml(a.concerns)}<p><strong>회복:</strong> ${escapeHtml(a.recovery_status||'')}</p><p><strong>균형:</strong> ${escapeHtml(a.training_balance||'')}</p>`)}
    ${analysisSection('체중감량 분석', `<p>${escapeHtml(w.summary||'')}</p><p><strong>체중 추세:</strong> ${escapeHtml(w.weight_trend||'')}</p><p><strong>활동량:</strong> ${escapeHtml(w.activity_assessment||'')}</p>${listHtml(w.weekly_targets)}${listHtml(w.limitations)}`)}
    ${analysisSection('다음 7일 계획', `<p>${escapeHtml(p.weekly_goal||'')}</p>${sessions||'<p>생성된 세션이 없습니다.</p>'}${listHtml(p.progression_rules)}${listHtml(p.pain_rules)}`)}
    ${analysis.warnings?.length?analysisSection('주의사항', listHtml(analysis.warnings)):''}`;
}
async function loadLatestAnalysis(showMessage=true){
  const url=getGasUrl(); if(!url)return;
  $("analysisStatus").className='sync-status status-loading';$("analysisStatus").textContent='마지막 분석을 불러오는 중...';
  try{const sep=url.includes('?')?'&':'?';const r=await fetch(`${url}${sep}action=latest_analysis&t=${Date.now()}`,{cache:'no-store'});const j=await r.json();if(!j.ok)throw new Error(j.error||'조회 실패');renderLatestAnalysis(j.analysis);$("analysisStatus").className='sync-status status-ok';$("analysisStatus").textContent=j.analysis?`마지막 분석: ${new Date(j.analysis.created_at).toLocaleString('ko-KR')}`:'아직 분석 기록이 없습니다.';if(showMessage)toast('마지막 분석을 불러왔습니다.');}catch(e){$("analysisStatus").className='sync-status status-warn';$("analysisStatus").textContent='분석 기록을 불러오지 못했습니다.';if(showMessage)toast('분석 불러오기 실패');}
}
async function executeAiAnalysis(){
  if(analysisState.running)return;
  analysisState.running=true;$("runAnalysisBtn").disabled=true;$("confirmAnalysisBtn").disabled=true;$("analysisStatus").className='sync-status status-loading';$("analysisStatus").textContent='Health·Fitness·근력운동을 집계하고 OpenAI가 분석 중입니다. 최대 1~2분 걸릴 수 있습니다.';
  const payload={action:'analyze',additional_request:$("analysisRequest").value.trim(),force:$("forceAnalysis").checked};
  try{const r=await fetch(getGasUrl(),{method:'POST',headers:{'Content-Type':'text/plain;charset=UTF-8'},body:JSON.stringify(payload),redirect:'follow'});const j=await r.json();if(!j.ok)throw new Error(j.error||'분석 실패');renderLatestAnalysis(j.analysis);$("analysisStatus").className='sync-status status-ok';$("analysisStatus").textContent=j.unchanged?(j.message||'새 기록이 없습니다.'):`분석 완료: ${new Date(j.analysis.created_at).toLocaleString('ko-KR')}`;toast(j.unchanged?'기존 분석을 표시합니다.':'AI 분석을 저장했습니다.');}catch(e){$("analysisStatus").className='sync-status status-warn';$("analysisStatus").textContent=`AI 분석 실패: ${e.message}`;toast('AI 분석에 실패했습니다.');}finally{analysisState.running=false;$("runAnalysisBtn").disabled=false;$("confirmAnalysisBtn").disabled=false;}
}
$("runAnalysisBtn").onclick=()=>{$("analysisRequest").value='';$("forceAnalysis").checked=false;$("analysisDialog").showModal();};
$("confirmAnalysisBtn").onclick=(e)=>{e.preventDefault();$("analysisDialog").close();executeAiAnalysis();};
$("refreshAnalysisBtn").onclick=()=>loadLatestAnalysis(true);
loadLatestAnalysis(false);
