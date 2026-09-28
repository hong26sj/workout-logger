/** Resumable, browser-driven AI analysis. No installable trigger or extra OAuth scope. */
const AI_JOB_PROPERTY_='WL_ACTIVE_AI_JOB_V1';
const AI_JOB_FOLDER_='AnalysisJobs';
const AI_JOB_BATCH_SIZE_=2; // Keep individual Drive operations small even for dense Health exports.
const AI_JOB_TYPES_=['health','fitness','strength','nutrition'];

function readAiJob_(){
  const raw=PropertiesService.getScriptProperties().getProperty(AI_JOB_PROPERTY_);
  if(!raw)return null;
  try{return JSON.parse(raw);}catch(e){console.error('ai_job_state_corrupt');return null;}
}
function writeAiJob_(job){
  job.updated_at=new Date().toISOString();
  PropertiesService.getScriptProperties().setProperty(AI_JOB_PROPERTY_,JSON.stringify(job));
}
function publicAiJob_(job){
  if(!job)return {ok:true,job:null};
  return {ok:true,job:{
    job_id:job.job_id,status:job.status,stage:job.stage,started_at:job.started_at,
    updated_at:job.updated_at,progress:job.progress||null,error_code:job.error_code||null,
    message:job.message||null,analysis_id:job.analysis_id||null
  }};
}
function startAiJob_(additionalRequest,force,analysisFromInput,analysisFromManual){
  const existing=readAiJob_();
  if(existing&&existing.status==='running')return publicAiJob_(existing);
  const quota=consumeAnalysisQuota_(); // Policy: accepted attempts count even if later processing fails.
  if(!quota.ok)return quota;
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(5000))return {ok:false,error_code:'JOB_BUSY',error:'분석 작업 준비 중입니다.'};
  try{
    const active=readAiJob_();
    if(active&&active.status==='running')return publicAiJob_(active);
    const now=new Date(),latest=findLatestAnalysis_();
    const recent=startOfDay_(addDays_(now,-6));
    const previous=latest?parseDate_(latest.period&&latest.period.to||latest.created_at):recent;
    const incremental=latest?addDays_(previous,-OVERLAP_DAYS):addDays_(now,-INITIAL_LOOKBACK_DAYS);
    const defaultFrom=latest?startOfDay_(addDays_(previous,-OVERLAP_DAYS)):recent;
    const periodFrom=normalizeAnalysisFrom_(analysisFromInput,defaultFrom,now);
    const analysisFrom=periodFrom<incremental?periodFrom:incremental;
    const healthFrom=addDays_(periodFrom,-27);
    const healthReadFrom=healthFrom<analysisFrom?healthFrom:analysisFrom;
    const id=Utilities.getUuid().replace(/-/g,'');
    const root=DriveApp.getFolderById(STRENGTH_FOLDER_ID);
    const folder=getOrCreateFolder_(root,AI_JOB_FOLDER_).createFolder('job-'+id);
    const job={
      job_id:id,folder_id:folder.getId(),status:'running',stage:'collect_health',
      started_at:formatIso_(now),updated_at:formatIso_(now),analysis_id:null,
      period_from:formatIso_(periodFrom),period_to:formatIso_(now),
      analysis_from:formatIso_(analysisFrom),requested_from:String(analysisFromInput||'').trim(),
      analysis_from_manual:analysisFromManual===true,force:force===true,
      additional_request:String(additionalRequest||'').trim().slice(0,4000),
      read_from:{health:formatIso_(healthReadFrom),fitness:formatIso_(analysisFrom),
        strength:formatIso_(analysisFrom),nutrition:formatIso_(addDays_(periodFrom,-14))},
      parts:{health:[],fitness:[],strength:[],nutrition:[]},
      counts:{health:0,fitness:0,strength:0,nutrition:0},
      manifest_id:null,cursor:0,progress:{step:'collect_health',done:0,total:null}
    };
    writeAiJob_(job);
    console.log(JSON.stringify({event:'ai_job_started',job_id:id,period_from:job.period_from}));
    return publicAiJob_(job);
  }finally{lock.releaseLock();}
}
function listAiJobStatus_(id){
  const job=readAiJob_();
  if(!job||id&&job.job_id!==String(id))return {ok:false,error_code:'JOB_NOT_FOUND',error:'분석 작업을 찾지 못했습니다.'};
  if(job.status==='running'&&job.stage==='openai_inflight'&&Date.now()-parseDate_(job.updated_at).getTime()>7*60*1000){
    // After a killed execution the API response might already have been charged.
    // Reuse a completed result if persisted; otherwise require an explicit new job.
    const saved=DriveApp.getFolderById(job.folder_id).getFilesByName('ai-result.json');
    if(saved.hasNext()){
      job.ai_file_id=saved.next().getId();
      job.stage='save';job.progress={step:'save',done:0,total:1};
    }else{
      job.status='failed';job.error_code='AI_RESULT_UNKNOWN';
      job.message='OpenAI 요청의 종료 결과를 확인할 수 없습니다. 자동 재호출을 차단했습니다.';
    }
    writeAiJob_(job);
  }
  return publicAiJob_(job);
}
function aiJobCandidates_(folder,from,to,type,results){
  const files=folder.getFiles();
  while(files.hasNext()){
    const f=files.next(),name=f.getName();
    if(!/\.json$/i.test(name))continue;
    if(type==='strength'&&!/^strength-.*\.json$/i.test(name))continue;
    if(type==='nutrition'&&!/^nutrition-.*\.json$/i.test(name))continue;
    if(!isJsonDateCandidate_(name,from,to,type))continue;
    results.push({id:f.getId(),name:name});
  }
  const folders=folder.getFolders();
  while(folders.hasNext()){
    const sub=folders.next(),name=sub.getName();
    if(type==='strength'&&(name===ANALYSIS_FOLDER_NAME||name===BASELINE_FOLDER_NAME||name===AI_JOB_FOLDER_))continue;
    aiJobCandidates_(sub,from,to,type,results);
  }
}
function aiJobFolderId_(type){
  return type==='health'?HEALTH_FOLDER_ID:type==='fitness'?FITNESS_FOLDER_ID:
    type==='strength'?STRENGTH_FOLDER_ID:NUTRITION_FOLDER_ID;
}
function aiJobAdvance_(job){
  const current=AI_JOB_TYPES_.indexOf(job.stage.replace('collect_',''));
  job.stage=current>=0&&current<AI_JOB_TYPES_.length-1?'collect_'+AI_JOB_TYPES_[current+1]:'compute';
  job.cursor=0;job.manifest_id=null;
  job.progress={step:job.stage,done:0,total:null};
}
function collectAiJobBatch_(job){
  const type=job.stage.slice('collect_'.length);
  const folderId=aiJobFolderId_(type);
  if(!folderId){aiJobAdvance_(job);writeAiJob_(job);return;}
  const folder=DriveApp.getFolderById(job.folder_id);
  if(!job.manifest_id){
    const candidates=[];
    aiJobCandidates_(DriveApp.getFolderById(folderId),parseDate_(job.read_from[type]),parseDate_(job.period_to),type,candidates);
    candidates.sort((a,b)=>a.name.localeCompare(b.name));
    job.manifest_id=folder.createFile('manifest-'+type+'.json',JSON.stringify(candidates),MimeType.PLAIN_TEXT).getId();
    job.progress={step:job.stage,done:0,total:candidates.length};
    writeAiJob_(job);
    console.log(JSON.stringify({event:'ai_collect_candidates',job_id:job.job_id,type:type,count:candidates.length}));
    return;
  }
  const candidates=JSON.parse(DriveApp.getFileById(job.manifest_id).getBlob().getDataAsString('UTF-8'));
  if(job.cursor>=candidates.length){aiJobAdvance_(job);writeAiJob_(job);return;}
  const until=Math.min(candidates.length,job.cursor+AI_JOB_BATCH_SIZE_);
  const records=[],started=Date.now();
  for(let i=job.cursor;i<until;i++){
    const candidate=candidates[i];
    try{
      const f=DriveApp.getFileById(candidate.id);
      const raw=f.getBlob().getDataAsString('UTF-8');
      const data=JSON.parse(raw);
      const stamp=inferJsonTimestamp_(data,f);
      if(stamp>=parseDate_(job.read_from[type])&&stamp<=parseDate_(job.period_to)){
        records.push({file_id:f.getId(),name:f.getName(),size_bytes:raw.length,
          modified_at:formatIso_(f.getLastUpdated()),timestamp:stamp.getTime(),data:data});
      }
    }catch(e){
      const reason=String(e&&e.message||e);
      if(/(?:서비스 오류|Service error|Drive|rate limit|invoked too many times|Internal error)/i.test(reason))throw e;
      console.error(JSON.stringify({event:'ai_collect_skip',job_id:job.job_id,type:type,file:candidate.name,error:reason.slice(0,120)}));
    }
  }
  if(records.length){
    const partName='part-'+type+'-'+job.cursor+'.json.gz';
    const compressed=Utilities.gzip(Utilities.newBlob(JSON.stringify(records),'application/json',partName.slice(0,-3)));
    compressed.setName(partName);
    const part=folder.createFile(compressed);
    console.log(JSON.stringify({event:'ai_part_saved',job_id:job.job_id,type:type,records:records.length,compressed_bytes:part.getSize()}));
    job.parts[type].push(part.getId());
    job.counts[type]+=records.length;
  }
  job.cursor=until;
  job.error_code=null;job.stage_error_attempts=0;job.message=null;
  job.progress={step:job.stage,done:until,total:candidates.length};
  console.log(JSON.stringify({event:'ai_collect_batch',job_id:job.job_id,type:type,cursor:until,total:candidates.length,accepted:records.length,elapsed_ms:Date.now()-started}));
  if(until>=candidates.length)aiJobAdvance_(job);
  writeAiJob_(job);
}
function readAiJobParts_(job,type){
  const all=[];
  (job.parts[type]||[]).forEach(id=>{
    const file=DriveApp.getFileById(id);
    const blob=file.getBlob();
    const raw=file.getName().endsWith('.gz')?Utilities.ungzip(blob).getDataAsString('UTF-8'):blob.getDataAsString('UTF-8');
    const part=JSON.parse(raw);
    Array.prototype.push.apply(all,part);
  });
  return dedupeCollectedFiles_(all);
}
function aiJobCompute_(job){
  const started=Date.now();
  const health=readAiJobParts_(job,'health'),fitness=readAiJobParts_(job,'fitness');
  const strength=readAiJobParts_(job,'strength'),nutrition=readAiJobParts_(job,'nutrition');
  console.log(JSON.stringify({event:'ai_compute_start',job_id:job.job_id,counts:job.counts}));
  const latest=findLatestAnalysis_();
  const newest=newestTimestamp_(health.concat(fitness,strength,nutrition));
  if(!job.force&&!job.analysis_from_manual&&latest&&newest&&newest<=parseDate_(latest.period&&latest.period.to||latest.created_at).getTime()&&!job.additional_request){
    job.status='done';job.stage='done';job.analysis_id=latest.analysis_id||null;
    job.message='마지막 분석 이후 새로운 기록이 없습니다.';
    writeAiJob_(job);return;
  }
  const stats=buildStatistics_(health,fitness,strength,nutrition,parseDate_(job.period_from),parseDate_(job.period_to));
  const comparison=buildActivityComparison_(stats,latest);
  const folder=DriveApp.getFolderById(job.folder_id);
  job.stats_file_id=folder.createFile('statistics.json',JSON.stringify({
    statistics:stats,activity_comparison:comparison,previous_analysis_id:latest&&latest.analysis_id||null,
    baseline:getBaselineSummary_(),data_sources:{health_files:health.length,fitness_files:fitness.length,strength_files:strength.length,nutrition_files:nutrition.length}
  }),MimeType.PLAIN_TEXT).getId();
  job.stage='openai';job.progress={step:'openai',done:0,total:1};
  writeAiJob_(job);
  console.log(JSON.stringify({event:'ai_compute_done',job_id:job.job_id,elapsed_ms:Date.now()-started}));
}
function aiJobOpenAi_(job){
  // An interrupted remote call is not retried automatically: its charge/outcome may be unknown.
  job.stage='openai_inflight';writeAiJob_(job);
  const started=Date.now();
  console.log(JSON.stringify({event:'ai_openai_start',job_id:job.job_id}));
  const saved=JSON.parse(DriveApp.getFileById(job.stats_file_id).getBlob().getDataAsString('UTF-8'));
  const latest=findLatestAnalysis_();
  const ai=callOpenAI_(saved.statistics,latest,latest&&latest.next_plan||null,job.additional_request,saved.baseline);
  const folder=DriveApp.getFolderById(job.folder_id);
  job.ai_file_id=folder.createFile('ai-result.json',JSON.stringify(ai),MimeType.PLAIN_TEXT).getId();
  job.stage='save';job.progress={step:'save',done:0,total:1};writeAiJob_(job);
  console.log(JSON.stringify({event:'ai_openai_done',job_id:job.job_id,elapsed_ms:Date.now()-started}));
}
function aiJobSave_(job){
  const saveStarted=Date.now();
  console.log(JSON.stringify({event:'ai_save_start',job_id:job.job_id}));
  const stats=JSON.parse(DriveApp.getFileById(job.stats_file_id).getBlob().getDataAsString('UTF-8'));
  const ai=JSON.parse(DriveApp.getFileById(job.ai_file_id).getBlob().getDataAsString('UTF-8'));
  const createdAt=formatIso_(new Date());
  const analysis={
    schema_version:1,
    analysis_id:'analysis-'+Utilities.formatDate(parseDate_(job.started_at),TIME_ZONE,'yyyy-MM-dd_HHmmss')+'-'+job.job_id.slice(0,8),
    created_at:createdAt,
    analysis_mode:stats.previous_analysis_id?'incremental':'initial',
    previous_analysis_id:stats.previous_analysis_id,user_goal:'weight_loss',
    additional_request:job.additional_request,
    period:{from:job.period_from,to:job.period_to,data_read_from:job.analysis_from,requested_from:job.requested_from||null},
    data_sources:stats.data_sources,statistics:stats.statistics,activity_comparison:stats.activity_comparison,
    baseline:stats.baseline,previous_plan_review:ai.previous_plan_review,overall_assessment:ai.overall_assessment,
    recovery_analysis:ai.recovery_analysis,nutrition_analysis:ai.nutrition_analysis,ai_analysis:ai.ai_analysis,
    weight_loss_analysis:ai.weight_loss_analysis,next_plan:ai.next_plan,warnings:ai.warnings,
    model:getOpenAiModel_(),prompt_version:'3.2'
  };
  const root=DriveApp.getFolderById(STRENGTH_FOLDER_ID);
  const month=getOrCreateFolder_(getOrCreateFolder_(root,ANALYSIS_FOLDER_NAME),Utilities.formatDate(parseDate_(job.started_at),TIME_ZONE,'yyyy-MM'));
  const found=month.getFilesByName(analysis.analysis_id+'.json');
  if(!found.hasNext())month.createFile(analysis.analysis_id+'.json',JSON.stringify(analysis,null,2),MimeType.PLAIN_TEXT);
  job.analysis_id=analysis.analysis_id;job.status='done';job.stage='done';
  job.progress={step:'done',done:1,total:1};job.message='AI 분석이 저장됐습니다.';
  writeAiJob_(job);
  console.log(JSON.stringify({event:'ai_job_done',job_id:job.job_id,analysis_id:job.analysis_id,save_elapsed_ms:Date.now()-saveStarted}));
  try{DriveApp.getFolderById(job.folder_id).setTrashed(true);}catch(e){console.warn('ai_job_cleanup_failed');}
}
function stepAiJob_(jobId){
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(1000))return {ok:false,error_code:'JOB_BUSY',error:'분석 단계가 실행 중입니다.'};
  try{
    const job=readAiJob_();
    if(!job||job.job_id!==String(jobId))return {ok:false,error_code:'JOB_NOT_FOUND',error:'분석 작업을 찾지 못했습니다.'};
    if(job.status!=='running')return publicAiJob_(job);
    const started=Date.now(),stage=job.stage;
    try{
      if(/^collect_/.test(stage))collectAiJobBatch_(job);
      else if(stage==='compute')aiJobCompute_(job);
      else if(stage==='openai')aiJobOpenAi_(job);
      else if(stage==='save')aiJobSave_(job);
      else if(stage==='openai_inflight')return publicAiJob_(job);
      else throw new Error('UNKNOWN_STAGE: '+stage);
    }catch(e){
      const message=String(e&&e.message||e).slice(0,220);
      const retryable=stage!=='openai'&&stage!=='openai_inflight'&&
        /(?:서비스 오류|Service error|Drive|rate limit|invoked too many times|Internal error)/i.test(message);
      job.stage_error_attempts=(job.stage_error_attempts||0)+1;
      if(retryable&&job.stage_error_attempts<=3){
        job.message='Drive 연결 오류로 현재 단계를 다시 시도합니다 ('+job.stage_error_attempts+'/3).';
        job.error_code='DRIVE_RETRY';
        writeAiJob_(job);
        console.warn(JSON.stringify({event:'ai_job_retry',job_id:job.job_id,stage:stage,attempt:job.stage_error_attempts,error:message}));
      }else{
        job.status='failed';job.error_code=stage==='openai'||stage==='openai_inflight'?'AI_STAGE_FAILED':'JOB_STAGE_FAILED';
        job.message=message;
        writeAiJob_(job);
        console.error(JSON.stringify({event:'ai_job_failed',job_id:job.job_id,stage:stage,error_code:job.error_code,message:job.message}));
      }
    }
    if(job.status==='running'&&!job.error_code)job.stage_error_attempts=0;
    if(job.status==='running'&&job.error_code!=='DRIVE_RETRY'){job.stage_error_attempts=0;job.message=null;writeAiJob_(job);}
    console.log(JSON.stringify({event:'ai_job_step',job_id:job.job_id,stage:stage,elapsed_ms:Date.now()-started}));
    return publicAiJob_(job);
  }finally{lock.releaseLock();}
}
