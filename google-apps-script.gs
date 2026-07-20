const HEALTH_FOLDER_ID = '1kIMgXnimiRiVTqPmuP6hQ2KQq64zlsYy';
const FITNESS_FOLDER_ID = '1tuxq3zOz9pBQDk9b5H-N78LUWkUQ6w0l';
const STRENGTH_FOLDER_ID = '1-Qfa2hYLBCiq6TW2IemLQ31AtUpFdWAR';
const TIME_ZONE = 'Asia/Seoul';
const INITIAL_LOOKBACK_DAYS = 28;
const OVERLAP_DAYS = 1;
const ANALYSIS_FOLDER_NAME = 'Analysis';
const BASELINE_FOLDER_NAME = 'Baseline';

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error('전송된 데이터가 없습니다.');
    const data = JSON.parse(e.postData.contents);
    if (data && data.action === 'analyze') return jsonResponse(runAiAnalysis_(data.additional_request || '', data.force === true));
    if (!data || !Array.isArray(data.exercises)) throw new Error('올바른 운동 기록 형식이 아닙니다.');
    return jsonResponse(saveStrengthSession_(data));
  } catch (error) {
    return jsonResponse({ok:false,error:String(error && error.message ? error.message : error)});
  }
}

function doGet(e) {
  try {
    const action = e && e.parameter && e.parameter.action ? String(e.parameter.action) : '';
    if (action === 'list') return jsonResponse(listStrengthSessions_());
    if (action === 'latest_analysis') return jsonResponse(getLatestAnalysisResponse_());
    if (action === 'status') return jsonResponse({ok:true,message:'Workout Logger AI API is running.',openai_configured:!!getOpenAiKey_()});
    return jsonResponse({ok:true,message:'Workout Logger AI API is running.'});
  } catch (error) {
    return jsonResponse({ok:false,error:String(error && error.message ? error.message : error)});
  }
}

function saveStrengthSession_(data) {
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
  monthFolder.createFile(fileName,JSON.stringify(data,null,2),MimeType.PLAIN_TEXT);
  return {ok:true,fileName:fileName};
}

function listStrengthSessions_() {
  const sessions=[];
  collectStrengthRecords_(DriveApp.getFolderById(STRENGTH_FOLDER_ID),sessions);
  sessions.sort((a,b)=>getSessionTimestamp_(a)-getSessionTimestamp_(b));
  return {ok:true,count:sessions.length,sessions:sessions.slice(-300)};
}

function runAiAnalysis_(additionalRequest, force) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('다른 AI 분석이 진행 중입니다. 잠시 후 다시 시도하세요.');
  try {
    const now = new Date();
    const latest = findLatestAnalysis_();
    const analysisFrom = latest ? addDays_(parseDate_(latest.period && latest.period.to || latest.created_at),-OVERLAP_DAYS) : addDays_(now,-INITIAL_LOOKBACK_DAYS);
    const periodFrom = latest ? parseDate_(latest.period && latest.period.to || latest.created_at) : analysisFrom;

    const health = collectJsonFiles_(DriveApp.getFolderById(HEALTH_FOLDER_ID), analysisFrom, now, 'health');
    const fitness = collectJsonFiles_(DriveApp.getFolderById(FITNESS_FOLDER_ID), analysisFrom, now, 'fitness');
    const strength = collectJsonFiles_(DriveApp.getFolderById(STRENGTH_FOLDER_ID), analysisFrom, now, 'strength');

    const newestDataTime = newestTimestamp_(health.concat(fitness).concat(strength));
    if (!force && latest && newestDataTime && newestDataTime <= parseDate_(latest.period && latest.period.to || latest.created_at).getTime() && !String(additionalRequest||'').trim()) {
      return {ok:true,unchanged:true,message:'마지막 분석 이후 새로운 기록이 없습니다.',analysis:latest};
    }

    const stats = buildStatistics_(health,fitness,strength,periodFrom,now);
    const previousPlan = latest ? (latest.next_plan || null) : null;
    const baseline = getBaselineSummary_();
    const ai = callOpenAI_(stats,latest,previousPlan,String(additionalRequest||'').trim(),baseline);

    const createdAt = formatIso_(now);
    const analysis = {
      schema_version:1,
      analysis_id:'analysis-' + Utilities.formatDate(now,TIME_ZONE,'yyyy-MM-dd_HHmmss'),
      created_at:createdAt,
      analysis_mode:latest?'incremental':'initial',
      previous_analysis_id:latest ? latest.analysis_id || null : null,
      user_goal:'weight_loss',
      additional_request:String(additionalRequest||'').trim(),
      period:{from:formatIso_(periodFrom),to:createdAt,data_read_from:formatIso_(analysisFrom)},
      data_sources:{health_files:health.length,fitness_files:fitness.length,strength_files:strength.length},
      statistics:stats,
      baseline:baseline,
      previous_plan_review:ai.previous_plan_review,
      ai_analysis:ai.ai_analysis,
      weight_loss_analysis:ai.weight_loss_analysis,
      next_plan:ai.next_plan,
      warnings:ai.warnings,
      model:getOpenAiModel_(),
      prompt_version:'2.0'
    };
    saveAnalysis_(analysis);
    return {ok:true,unchanged:false,analysis:analysis};
  } finally {
    lock.releaseLock();
  }
}

function buildStatistics_(healthFiles,fitnessFiles,strengthFiles,periodFrom,periodTo) {
  const metrics={};
  healthFiles.forEach(x=>{
    const arr=x.data && x.data.data && x.data.data.metrics || [];
    arr.forEach(m=>{
      const name=m.name; if(!name)return;
      if(!metrics[name]) metrics[name]=[];
      (m.data||[]).forEach(v=>{
        const t=parseDate_(v.date); if(t>=periodFrom&&t<=periodTo&&isFinite(Number(v.qty))) metrics[name].push({t:t.getTime(),qty:Number(v.qty),units:m.units||''});
      });
    });
  });

  const daily = {};
  Object.keys(metrics).forEach(name=>metrics[name].forEach(v=>{
    const day=Utilities.formatDate(new Date(v.t),TIME_ZONE,'yyyy-MM-dd');
    if(!daily[day])daily[day]={};
    if(!daily[day][name])daily[day][name]=[];
    daily[day][name].push(v.qty);
  }));
  const days=Object.keys(daily).sort();
  const sumMetric=(name)=>round_(days.reduce((s,d)=>s+sum_(daily[d][name]||[]),0),2);
  const dailySums=(name)=>days.map(d=>sum_(daily[d][name]||[]));
  const dailyAvgs=(name)=>days.map(d=>avg_(daily[d][name]||[])).filter(v=>v!==null);
  const latestMetric=(name)=>{
    const a=(metrics[name]||[]).slice().sort((a,b)=>a.t-b.t); return a.length?round_(a[a.length-1].qty,2):null;
  };
  const firstMetric=(name)=>{
    const a=(metrics[name]||[]).slice().sort((a,b)=>a.t-b.t); return a.length?round_(a[0].qty,2):null;
  };

  const workouts=[];
  const workoutIds={};
  fitnessFiles.forEach(x=>((x.data&&x.data.data&&x.data.data.workouts)||[]).forEach(w=>{
    const start=parseDate_(w.start); if(start<periodFrom||start>periodTo)return;
    const key=w.id||[w.start,w.end,w.name].join('|'); if(workoutIds[key])return; workoutIds[key]=true;
    const durationMin=Number(w.duration||0)/60;
    const activeKj=Number(w.activeEnergyBurned&&w.activeEnergyBurned.qty||0);
    workouts.push({name:w.name||'운동',start:formatIso_(start),duration_min:round_(durationMin,1),active_kcal:round_(activeKj/4.184,1),avg_hr:num_(w.avgHeartRate&&w.avgHeartRate.qty||w.heartRate&&w.heartRate.avg&&w.heartRate.avg.qty),max_hr:num_(w.maxHeartRate&&w.maxHeartRate.qty||w.heartRate&&w.heartRate.max&&w.heartRate.max.qty)});
  }));

  const strengthSessions=[];
  const strengthSeen={};
  strengthFiles.forEach(x=>{
    const s=x.data; if(!s||!Array.isArray(s.exercises))return;
    const t=parseDate_(s.finished_at||s.started_at||x.modified_at); if(t<periodFrom||t>periodTo)return;
    const key=s.session_id||[s.started_at,s.finished_at,JSON.stringify(s.exercises)].join('|'); if(strengthSeen[key])return; strengthSeen[key]=true;
    strengthSessions.push(s);
  });
  const byExercise={}; const pain=[]; let totalSets=0,totalReps=0,totalVolume=0,totalTimedSeconds=0;
  strengthSessions.forEach(s=>(s.exercises||[]).forEach(ex=>{
    const name=String(ex.exercise||'미지정');
    if(!byExercise[name])byExercise[name]={sessions:0,sets:0,reps:0,volume_kg:0,timed_seconds:0,last_weight_kg:null,last_recorded_at:null,rpe_values:[]};
    const a=byExercise[name]; a.sessions++; a.sets+=Number(ex.sets||0); a.reps+=Number(ex.reps||0)*Number(ex.sets||0); a.volume_kg+=Number(ex.weight_kg||0)*Number(ex.reps||0)*Number(ex.sets||0); a.timed_seconds+=Number(ex.seconds||0)*Number(ex.sets||0);
    if(Number(ex.weight_kg||0)>0)a.last_weight_kg=Number(ex.weight_kg); a.last_recorded_at=ex.recorded_at||s.finished_at||s.started_at;
    if(ex.rpe!==null&&ex.rpe!==undefined&&isFinite(Number(ex.rpe)))a.rpe_values.push(Number(ex.rpe));
    totalSets+=Number(ex.sets||0); totalReps+=Number(ex.reps||0)*Number(ex.sets||0); totalVolume+=Number(ex.weight_kg||0)*Number(ex.reps||0)*Number(ex.sets||0); totalTimedSeconds+=Number(ex.seconds||0)*Number(ex.sets||0);
    if(Number(ex.pain_level||0)>0)pain.push({date:ex.recorded_at||s.finished_at||s.started_at,exercise:name,level:Number(ex.pain_level),area:ex.pain_area||'미지정',memo:ex.memo||''});
  }));
  Object.keys(byExercise).forEach(k=>{const a=byExercise[k];a.volume_kg=round_(a.volume_kg,1);a.avg_rpe=a.rpe_values.length?round_(avg_(a.rpe_values),1):null;delete a.rpe_values;});

  const weightLatest=latestMetric('weight_body_mass');
  const weightFirst=firstMetric('weight_body_mass');
  return {
    coverage:{from:formatIso_(periodFrom),to:formatIso_(periodTo),days_with_health_data:days.length},
    body:{weight_latest_kg:weightLatest,weight_first_kg:weightFirst,weight_change_kg:weightLatest!==null&&weightFirst!==null?round_(weightLatest-weightFirst,2):null,body_fat_latest_pct:latestMetric('body_fat_percentage'),lean_mass_latest_kg:latestMetric('lean_body_mass'),bmi_latest:latestMetric('body_mass_index'),weight_measurements:(metrics.weight_body_mass||[]).length},
    activity:{steps_total:round_(sumMetric('step_count'),0),steps_daily_average:round_(avg_(dailySums('step_count')),0),distance_total_km:sumMetric('walking_running_distance'),active_energy_total_kcal:round_(sumMetric('active_energy')/4.184,1),exercise_minutes_total:sumMetric('apple_exercise_time'),stand_minutes_total:sumMetric('apple_stand_time')},
    heart_rate:{resting_hr_average:round_(avg_(dailyAvgs('resting_heart_rate')),1),resting_hr_latest:latestMetric('resting_heart_rate'),walking_hr_average:round_(avg_(dailyAvgs('walking_heart_rate_average')),1),heart_rate_average:round_(avg_(dailyAvgs('heart_rate')),1),oxygen_saturation_latest:latestMetric('oxygen_saturation')},
    fitness:{session_count:workouts.length,total_minutes:round_(workouts.reduce((s,w)=>s+w.duration_min,0),1),active_kcal:round_(workouts.reduce((s,w)=>s+w.active_kcal,0),1),sessions:workouts.slice(-50)},
    strength:{session_count:strengthSessions.length,total_sets:totalSets,total_reps:totalReps,total_volume_kg:round_(totalVolume,1),timed_seconds:totalTimedSeconds,by_exercise:byExercise},
    pain:{event_count:pain.length,max_level:pain.length?Math.max.apply(null,pain.map(x=>x.level)):0,events:pain.slice(-30)},
    weight_loss_context:{goal:'체중감량',available_energy_expenditure_kcal:round_(sumMetric('active_energy')/4.184,1),food_intake_data_available:false,note:'식사·섭취 열량 데이터가 없으므로 칼로리 적자량을 직접 계산하지 않고 체중 추세와 활동량을 중심으로 평가합니다.'}
  };
}

function callOpenAI_(stats,latest,previousPlan,additionalRequest,baseline) {
  const key=getOpenAiKey_(); if(!key)throw new Error('스크립트 속성 OPENAI_API_KEY가 설정되지 않았습니다.');
  const schema={type:'object',additionalProperties:false,properties:{
    previous_plan_review:{type:'object',additionalProperties:false,properties:{summary:{type:'string'},completion_rate:{type:['number','null']},completed:{type:'array',items:{type:'string'}},not_completed:{type:'array',items:{type:'string'}}},required:['summary','completion_rate','completed','not_completed']},
    ai_analysis:{type:'object',additionalProperties:false,properties:{summary:{type:'string'},progress:{type:'array',items:{type:'string'}},concerns:{type:'array',items:{type:'string'}},recovery_status:{type:'string'},training_balance:{type:'string'}},required:['summary','progress','concerns','recovery_status','training_balance']},
    weight_loss_analysis:{type:'object',additionalProperties:false,properties:{summary:{type:'string'},weight_trend:{type:'string'},activity_assessment:{type:'string'},weekly_targets:{type:'array',items:{type:'string'}},limitations:{type:'array',items:{type:'string'}}},required:['summary','weight_trend','activity_assessment','weekly_targets','limitations']},
    next_plan:{type:'object',additionalProperties:false,properties:{period_days:{type:'integer'},weekly_goal:{type:'string'},daily_activity_target:{type:'object',additionalProperties:false,properties:{steps:{type:['integer','null']},cardio_minutes:{type:['integer','null']}},required:['steps','cardio_minutes']},sessions:{type:'array',items:{type:'object',additionalProperties:false,properties:{day_label:{type:'string'},focus:{type:'string'},exercises:{type:'array',items:{type:'object',additionalProperties:false,properties:{exercise:{type:'string'},record_type:{type:'string',enum:['weighted','bodyweight','timed']},sets:{type:'integer'},reps:{type:['integer','null']},seconds:{type:['integer','null']},suggested_weight_kg:{type:['number','null']},target_rpe:{type:['number','null']},reason:{type:'string'},pain_rule:{type:'string'}},required:['exercise','record_type','sets','reps','seconds','suggested_weight_kg','target_rpe','reason','pain_rule']}}},required:['day_label','focus','exercises']}},progression_rules:{type:'array',items:{type:'string'}},pain_rules:{type:'array',items:{type:'string'}}},required:['period_days','weekly_goal','daily_activity_target','sessions','progression_rules','pain_rules']},
    warnings:{type:'array',items:{type:'string'}}
  },required:['previous_plan_review','ai_analysis','weight_loss_analysis','next_plan','warnings']};

  const instructions='당신은 한국어로 답하는 운동 코치다. 목표는 체중감량과 근력 유지·향상이다. 제공된 수치만 근거로 분석하고, 식사 데이터가 없으면 칼로리 적자를 추정하지 않는다. 통증 기록을 최우선으로 반영한다. 허리 통증이 있거나 악화 신호가 있으면 허리에 부담되는 동작을 계획에서 제외하고 진료 또는 휴식을 권고한다. 의료 진단을 하지 않는다. 계획은 현실적인 7일 계획으로 작성한다.';
  const input={baseline:baseline||null,statistics:stats,previous_analysis:latest?{created_at:latest.created_at,ai_analysis:latest.ai_analysis,weight_loss_analysis:latest.weight_loss_analysis}:null,previous_plan:previousPlan||null,additional_request:additionalRequest||'',required_flow:['이전 계획 이행 평가','새 기록 분석','체중감량 분석','다음 7일 계획']};
  const payload={model:getOpenAiModel_(),store:false,instructions:instructions,input:JSON.stringify(input),text:{format:{type:'json_schema',name:'fitness_analysis',strict:true,schema:schema}}};
  const response=UrlFetchApp.fetch('https://api.openai.com/v1/responses',{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+key},payload:JSON.stringify(payload),muteHttpExceptions:true});
  const code=response.getResponseCode(); const body=response.getContentText();
  if(code<200||code>=300)throw new Error('OpenAI API 오류 '+code+': '+body.substring(0,500));
  const result=JSON.parse(body); const text=extractOutputText_(result); if(!text)throw new Error('OpenAI 응답에서 분석 JSON을 찾지 못했습니다.');
  return JSON.parse(text);
}

function extractOutputText_(result) {
  if(result.output_text)return result.output_text;
  const out=result.output||[];
  for(let i=0;i<out.length;i++)for(let j=0;j<(out[i].content||[]).length;j++){const c=out[i].content[j];if(c.type==='output_text'&&c.text)return c.text;}
  return '';
}

function getBaselineSummary_(){
  const root=DriveApp.getFolderById(STRENGTH_FOLDER_ID);
  const folders=root.getFoldersByName(BASELINE_FOLDER_NAME);
  if(!folders.hasNext())return null;
  const folder=folders.next();
  const files=folder.getFiles();
  let latest=null;
  while(files.hasNext()){
    const file=files.next();
    if(!/^baseline-.*\.json$/i.test(file.getName()))continue;
    try{
      const data=JSON.parse(file.getBlob().getDataAsString('UTF-8'));
      if(!latest || file.getLastUpdated().getTime()>latest.modified){latest={modified:file.getLastUpdated().getTime(),data:data};}
    }catch(e){console.log('Baseline 읽기 실패: '+file.getName());}
  }
  return latest?latest.data:null;
}

function getLatestAnalysisResponse_(){const a=findLatestAnalysis_();return {ok:true,analysis:a||null};}
function saveAnalysis_(analysis){const root=DriveApp.getFolderById(STRENGTH_FOLDER_ID);const af=getOrCreateFolder_(root,ANALYSIS_FOLDER_NAME);const mf=getOrCreateFolder_(af,Utilities.formatDate(new Date(),TIME_ZONE,'yyyy-MM'));af.getName();mf.createFile(analysis.analysis_id+'.json',JSON.stringify(analysis,null,2),MimeType.PLAIN_TEXT);}
function findLatestAnalysis_(){const root=DriveApp.getFolderById(STRENGTH_FOLDER_ID);const fs=root.getFoldersByName(ANALYSIS_FOLDER_NAME);if(!fs.hasNext())return null;const arr=[];collectAnalysis_(fs.next(),arr);arr.sort((a,b)=>parseDate_(a.created_at).getTime()-parseDate_(b.created_at).getTime());return arr.length?arr[arr.length-1]:null;}
function collectAnalysis_(folder,arr){const files=folder.getFiles();while(files.hasNext()){const f=files.next();if(!/^analysis-.*\.json$/i.test(f.getName()))continue;try{arr.push(JSON.parse(f.getBlob().getDataAsString('UTF-8')));}catch(e){}}const subs=folder.getFolders();while(subs.hasNext())collectAnalysis_(subs.next(),arr);}

function collectJsonFiles_(folder,from,to,type){const arr=[];collectJsonFilesRecursive_(folder,from,to,type,arr);return arr;}
function collectJsonFilesRecursive_(folder,from,to,type,arr){const files=folder.getFiles();while(files.hasNext()){const f=files.next();if(!/\.json$/i.test(f.getName()))continue;if(type==='strength'&&!/^strength-.*\.json$/i.test(f.getName()))continue;try{const data=JSON.parse(f.getBlob().getDataAsString('UTF-8'));const t=inferJsonTimestamp_(data,f);if(t>=from&&t<=to)arr.push({name:f.getName(),modified_at:formatIso_(f.getLastUpdated()),timestamp:t.getTime(),data:data});}catch(e){console.log('JSON 읽기 실패 '+f.getName()+': '+e);}}const subs=folder.getFolders();while(subs.hasNext()){const sf=subs.next();if(type==='strength'&&(sf.getName()===ANALYSIS_FOLDER_NAME||sf.getName()===BASELINE_FOLDER_NAME))continue;collectJsonFilesRecursive_(sf,from,to,type,arr);}}
function inferJsonTimestamp_(data,file){if(data&&Array.isArray(data.exercises))return parseDate_(data.finished_at||data.started_at||file.getLastUpdated());const w=data&&data.data&&data.data.workouts;if(w&&w.length)return parseDate_(w[w.length-1].end||w[w.length-1].start||file.getLastUpdated());const m=data&&data.data&&data.data.metrics;if(m){let latest=0;m.forEach(x=>(x.data||[]).forEach(v=>{const t=parseDate_(v.date).getTime();if(t>latest)latest=t;}));if(latest)return new Date(latest);}const match=file.getName().match(/(20\d{2})-(\d{2})-(\d{2})/);if(match)return new Date(match[1]+'-'+match[2]+'-'+match[3]+'T23:59:59+09:00');return file.getLastUpdated();}
function newestTimestamp_(arr){return arr.length?Math.max.apply(null,arr.map(x=>x.timestamp||0)):0;}
function collectStrengthRecords_(folder,sessions){const files=folder.getFiles();while(files.hasNext()){const f=files.next();if(!/^strength-.*\.json$/i.test(f.getName()))continue;try{const d=JSON.parse(f.getBlob().getDataAsString('UTF-8'));if(d&&Array.isArray(d.exercises))sessions.push(d);}catch(e){}}const subs=folder.getFolders();while(subs.hasNext()){const sf=subs.next();if(sf.getName()!==ANALYSIS_FOLDER_NAME&&sf.getName()!==BASELINE_FOLDER_NAME)collectStrengthRecords_(sf,sessions);}}
function getSessionTimestamp_(s){return parseDate_(s.finished_at||s.started_at||s.created_at||s.date||0).getTime();}
function getOrCreateFolder_(parent,name){const f=parent.getFoldersByName(name);return f.hasNext()?f.next():parent.createFolder(name);}
function getOpenAiKey_(){return PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY')||'';}
function getOpenAiModel_(){return PropertiesService.getScriptProperties().getProperty('OPENAI_MODEL')||'gpt-5-mini';}
function parseDate_(v){if(v instanceof Date)return v;let s=String(v||'');if(!s)return new Date(0);s=s.replace(/ (\+\d{4})$/,' $1').replace(/ ([+-]\d{2})(\d{2})$/,' $1:$2');const d=new Date(s);return isNaN(d.getTime())?new Date(0):d;}
function formatIso_(d){return Utilities.formatDate(parseDate_(d),TIME_ZONE,"yyyy-MM-dd'T'HH:mm:ssXXX");}
function addDays_(d,n){const x=new Date(parseDate_(d).getTime());x.setDate(x.getDate()+n);return x;}
function sum_(a){return (a||[]).reduce((s,v)=>s+(isFinite(Number(v))?Number(v):0),0);}
function avg_(a){const b=(a||[]).filter(v=>isFinite(Number(v))).map(Number);return b.length?sum_(b)/b.length:null;}
function round_(v,n){if(v===null||v===undefined||!isFinite(Number(v)))return null;const p=Math.pow(10,n||0);return Math.round(Number(v)*p)/p;}
function num_(v){return isFinite(Number(v))?round_(Number(v),1):null;}

/**
 * 최초 1회 Apps Script 편집기에서 직접 실행해 외부 API 호출 권한을 승인합니다.
 * 실행 후 권한 승인 창에서 허용하고 웹 앱을 새 버전으로 재배포하세요.
 */
function authorizeOpenAIConnection() {
  const response = UrlFetchApp.fetch('https://api.openai.com/v1/models', {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + (getOpenAiKey_() || 'missing-key')
    },
    muteHttpExceptions: true
  });

  console.log('OpenAI authorization check HTTP ' + response.getResponseCode());
  return response.getResponseCode();
}
