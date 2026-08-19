/** Workout Logger - integrated AI orchestration, OpenAI call/schema/prompt, and analysis persistence. */

function runAiAnalysis_(additionalRequest, force, analysisFromInput, analysisFromManual) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('다른 AI 분석이 진행 중입니다. 잠시 후 다시 시도하세요.');
  try {
    const now = new Date();
    const latest = findLatestAnalysis_();
    const recentSevenDayFrom = startOfDay_(addDays_(now,-6));
    const previousAnalysisTime = latest
      ? parseDate_(latest.period && latest.period.to || latest.created_at)
      : recentSevenDayFrom;
    const incrementalReadFrom = latest
      ? addDays_(previousAnalysisTime,-OVERLAP_DAYS)
      : addDays_(now,-INITIAL_LOOKBACK_DAYS);
    const defaultPeriodFrom = latest ? startOfDay_(addDays_(previousAnalysisTime,-OVERLAP_DAYS)) : recentSevenDayFrom;
    const requestedPeriodFrom = normalizeAnalysisFrom_(analysisFromInput, defaultPeriodFrom, now);
    const periodFrom = requestedPeriodFrom;
    const analysisFrom = requestedPeriodFrom < incrementalReadFrom ? requestedPeriodFrom : incrementalReadFrom;

    // 회복 baseline(최근 3/7일 + 이전 7일)을 계산할 수 있도록 Health는 최대 28일 회고 구간을 확보합니다.
    const healthReadFrom = addDays_(periodFrom,-27);
    const effectiveHealthReadFrom = healthReadFrom < analysisFrom ? healthReadFrom : analysisFrom;
    const health = dedupeCollectedFiles_(collectJsonFiles_(DriveApp.getFolderById(HEALTH_FOLDER_ID), effectiveHealthReadFrom, now, 'health'));
    const fitness = dedupeCollectedFiles_(collectJsonFiles_(DriveApp.getFolderById(FITNESS_FOLDER_ID), analysisFrom, now, 'fitness'));
    const strength = dedupeCollectedFiles_(collectJsonFiles_(DriveApp.getFolderById(STRENGTH_FOLDER_ID), analysisFrom, now, 'strength'));

    // 불완전 식단의 누락 끼니 추정을 위해 분석 시작일보다 최대 14일 앞까지 읽습니다.
    // 이 추가 구간은 추정 후보로만 쓰고, nutrition.daily_series에는 분석기간 데이터만 남깁니다.
    const nutritionReadFrom = addDays_(periodFrom,-14);
    const nutrition = NUTRITION_FOLDER_ID
      ? dedupeCollectedFiles_(collectJsonFiles_(DriveApp.getFolderById(NUTRITION_FOLDER_ID), nutritionReadFrom, now, 'nutrition'))
      : [];

    const newestDataTime = newestTimestamp_(health.concat(fitness).concat(strength).concat(nutrition));
    if (!force && !analysisFromManual && latest && newestDataTime && newestDataTime <= parseDate_(latest.period && latest.period.to || latest.created_at).getTime() && !String(additionalRequest||'').trim()) {
      return {ok:true,unchanged:true,message:'마지막 분석 이후 새로운 기록이 없습니다.',analysis:latest};
    }

    const stats = buildStatistics_(health,fitness,strength,nutrition,periodFrom,now);
    const activityComparison = buildActivityComparison_(stats, latest);
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
      period:{from:formatIso_(periodFrom),to:createdAt,data_read_from:formatIso_(analysisFrom),requested_from:String(analysisFromInput||'').trim()||null},
      data_sources:{health_files:health.length,fitness_files:fitness.length,strength_files:strength.length,nutrition_files:nutrition.length},
      statistics:stats,
      activity_comparison:activityComparison,
      baseline:baseline,
      previous_plan_review:ai.previous_plan_review,
      overall_assessment:ai.overall_assessment,
      recovery_analysis:ai.recovery_analysis,
      nutrition_analysis:ai.nutrition_analysis,
      ai_analysis:ai.ai_analysis,
      weight_loss_analysis:ai.weight_loss_analysis,
      next_plan:ai.next_plan,
      warnings:ai.warnings,
      model:getOpenAiModel_(),
      prompt_version:'3.2'
    };
    saveAnalysis_(analysis);
    return {ok:true,unchanged:false,analysis:analysis};
  } finally {
    lock.releaseLock();
  }
}

function callOpenAI_(stats,latest,previousPlan,additionalRequest,baseline) {
  const key=getOpenAiKey_(); if(!key)throw new Error('스크립트 속성 OPENAI_API_KEY가 설정되지 않았습니다.');
  const schema={type:'object',additionalProperties:false,properties:{
    previous_plan_review:{type:'object',additionalProperties:false,properties:{summary:{type:'string'},completion_rate:{type:['number','null']},completed:{type:'array',items:{type:'string'}},not_completed:{type:'array',items:{type:'string'}}},required:['summary','completion_rate','completed','not_completed']},
    overall_assessment:{type:'object',additionalProperties:false,properties:{summary:{type:'string'},weight_status:{type:'string',enum:['양호','주의','부족','자료 없음']},training_status:{type:'string',enum:['양호','주의','부족','자료 없음']},recovery_status:{type:'string',enum:['양호','주의','부족','자료 없음']},nutrition_status:{type:'string',enum:['양호','주의','부족','자료 없음']},key_points:{type:'array',items:{type:'string'}}},required:['summary','weight_status','training_status','recovery_status','nutrition_status','key_points']},
    recovery_analysis:{type:'object',additionalProperties:false,properties:{status:{type:'string',enum:['양호','주의','부족','자료 없음']},summary:{type:'string'},evidence:{type:'array',items:{type:'string'}},limitations:{type:'array',items:{type:'string'}}},required:['status','summary','evidence','limitations']},
    nutrition_analysis:{type:'object',additionalProperties:false,properties:{
      status:{type:'string',enum:['양호','주의','부족','자료 없음']},
      summary:{type:'string'},
      evidence:{type:'array',items:{type:'string'}},
      limitations:{type:'array',items:{type:'string'}},
      nutrient_recommendations:{type:'array',maxItems:3,items:{type:'object',additionalProperties:false,properties:{
        nutrient:{type:'string'},
        priority:{type:'string',enum:['높음','보통','낮음']},
        reason:{type:'string'},
        foods:{type:'array',minItems:1,maxItems:4,items:{type:'string'}}
      },required:['nutrient','priority','reason','foods']}}
    },required:['status','summary','evidence','limitations','nutrient_recommendations']},
    ai_analysis:{type:'object',additionalProperties:false,properties:{summary:{type:'string'},progress:{type:'array',items:{type:'string'}},concerns:{type:'array',items:{type:'string'}},recovery_status:{type:'string',enum:['양호','주의','부족','자료 없음']},training_balance:{type:'string'}},required:['summary','progress','concerns','recovery_status','training_balance']},
    weight_loss_analysis:{type:'object',additionalProperties:false,properties:{summary:{type:'string'},weight_trend:{type:'string'},activity_assessment:{type:'string'},weekly_targets:{type:'array',items:{type:'string'}},limitations:{type:'array',items:{type:'string'}}},required:['summary','weight_trend','activity_assessment','weekly_targets','limitations']},
    next_plan:{type:'object',additionalProperties:false,properties:{period_days:{type:'integer'},weekly_goal:{type:'string'},daily_activity_target:{type:'object',additionalProperties:false,properties:{steps:{type:['integer','null']},cardio_minutes:{type:['integer','null']}},required:['steps','cardio_minutes']},sessions:{type:'array',items:{type:'object',additionalProperties:false,properties:{day_label:{type:'string'},focus:{type:'string'},exercises:{type:'array',items:{type:'object',additionalProperties:false,properties:{exercise:{type:'string'},record_type:{type:'string',enum:['weighted','bodyweight','timed']},sets:{type:'integer'},reps:{type:['integer','null']},seconds:{type:['integer','null']},suggested_weight_kg:{type:['number','null']},target_rpe:{type:['number','null']},reason:{type:'string'},pain_rule:{type:'string'}},required:['exercise','record_type','sets','reps','seconds','suggested_weight_kg','target_rpe','reason','pain_rule']}}},required:['day_label','focus','exercises']}},progression_rules:{type:'array',items:{type:'string'}},pain_rules:{type:'array',items:{type:'string'}}},required:['period_days','weekly_goal','daily_activity_target','sessions','progression_rules','pain_rules']},
    warnings:{type:'array',items:{type:'string'}}
  },required:['previous_plan_review','overall_assessment','recovery_analysis','nutrition_analysis','ai_analysis','weight_loss_analysis','next_plan','warnings']};

  const input={
    baseline:baseline||null,
    statistics:stats,
    previous_analysis:latest?{created_at:latest.created_at,overall_assessment:latest.overall_assessment||null,recovery_analysis:latest.recovery_analysis||null,nutrition_analysis:latest.nutrition_analysis||null,ai_analysis:latest.ai_analysis,weight_loss_analysis:latest.weight_loss_analysis}:null,
    previous_plan:previousPlan||null,
    additional_request:additionalRequest||'',
    required_flow:['이전 계획 이행 평가','종합 평가','현재 데이터 기반 회복 분석','영양 분석','운동 분석','체중감량 분석','다음 7일 계획']
  };
  const finalInstructions=[
    '당신은 한국어로 답하는 운동·영양·회복 통합 코치다.',
    '사용자의 목표는 체중감량을 우선하면서 근력 유지 또는 향상을 추구하는 것이다.',
    '제공된 측정값만 근거로 사용하고 의료 진단은 하지 않는다.',
    '종합 평가는 체중·운동·회복·영양을 서로 연결해서 판단하되, 근거가 부족한 영역은 제한사항을 명시한다.',
    '상태값 출력 규칙: overall_assessment의 weight_status, training_status, recovery_status, nutrition_status와 recovery_analysis.status, nutrition_analysis.status, ai_analysis.recovery_status에는 반드시 양호/주의/부족/자료 없음 중 하나만 출력한다. 상태 필드에는 이유·수치·문장·괄호 설명을 절대 넣지 말고 상세 근거는 summary, key_points, evidence, limitations에 작성한다.',
    '회복 규칙: statistics.recovery의 HRV, 안정시 심박, 수면, 수면중/일반 심박을 우선 사용하고 SpO2와 호흡수는 보조 근거로 사용한다. 단일 값보다 최근 3일·7일 및 이전 7일 비교를 우선한다. 수면 데이터가 희소하면 회복을 강하게 단정하지 않는다.',
    '영양 규칙: statistics.nutrition에서 complete 기록일의 recorded_total을 실제 하루 섭취량 근거로 최우선 사용한다. incomplete 기록일의 recorded_total은 최소 기록 섭취량(lower bound)일 뿐 실제 하루 총섭취량으로 간주하거나 complete-day 평균에 섞지 않는다.',
    '영양 추정 규칙: incomplete 기록일의 estimated_complete_total은 누락된 주식사에 대해 같은 meal_type의 근접 기록 중앙값으로 보정한 추정치다. 실제 기록과 추정치를 반드시 구분하고, 추정치를 사실처럼 표현하지 않는다. complete 실제값 > estimated_complete_total > incomplete recorded_total(lower bound) 순으로 신뢰한다.',
    '영양 화면 요약 규칙: nutrition_analysis.summary는 모바일 화면에서 읽기 쉽게 핵심 판단만 한국어 2문장 이내, 가급적 180자 이내로 작성한다. 상세 근거는 evidence와 limitations에 분리한다.',
    '추천 식단 규칙: nutrition_analysis.nutrient_recommendations는 최대 3개만 작성한다. 실제 Nutrition 기록 또는 제공된 통계로 부족/보완 필요성을 뒷받침할 수 있는 영양소·영양 목표만 선택하고, 데이터가 없는 미량영양소를 임의로 결핍이라고 추정하지 않는다. 각 항목 foods에는 한국에서 쉽게 구할 수 있는 음식 1~4개를 구체적으로 제안한다. 부족 근거가 없으면 빈 배열을 반환한다.',
    '에너지 균형 규칙: Nutrition 데이터가 불완전하거나 추정 비율이 높으면 정확한 칼로리 적자량을 단정하지 않는다. 활동에너지와 기초에너지는 측정/추정 기반 참고값이며 정확한 TDEE로 단정하지 않는다.',
    '통증 기록을 최우선으로 반영한다. 허리 통증이나 악화 신호가 있으면 허리에 부담되는 동작을 제외하고 필요하면 휴식 또는 진료를 권고한다.',
    '현실적인 7일 운동 계획을 작성한다.',
    '고정 규칙: 7월 초의 실내 걷기와 최근의 실내 달리기 또는 실내 운동은 Apple Watch 운동명 선택 차이일 수 있으므로 운동명 변화 자체를 운동 방식 전환으로 해석하지 않는다. 거리, 시간, 페이스, 심박수, 케이던스, 활동칼로리 기준으로 같은 실내 유산소 흐름으로 비교한다.',
    '고정 규칙: 근력운동 수동 기록은 2026년 7월 20일부터 시작되었으므로 그 이전 근력운동 공백은 실제 운동 부재가 아니라 기록 누락 가능성으로 본다.',
    '유산소 세부 규칙: statistics.activity.cardio_summary.quality_sessions가 있으면 선택된 분석기간 전체의 분 단위 추정 스플릿, 심박수 영역, 케이던스, 운동 후 심박수 회복을 보조 근거로 사용한다.',
    '절대 운동강도 규칙: Fitness workout의 intensity_met를 세션 대표 절대강도(MET-equivalent)로 우선 사용하고, 없으면 같은 시간대 Health physical_effort 평균을 보조값으로 사용한다. 높은 MET 자체를 체력 향상으로 해석하지 않는다.',
    '체중 추세 규칙: statistics.body.body_trend의 7일 이동평균을 단일 체중값보다 우선한다.',
    '근력 세션 규칙: statistics.strength.daily_sessions의 날짜별 종목·중량·횟수·세트·RPE·통증 흐름을 다음 계획에 반영한다.',
    '데이터 품질 규칙: statistics.data_diagnosis와 각 영역 data_quality를 확인하고, 데이터가 희소하거나 누락되면 신뢰도 제한을 설명한다.',
    '허리둘레는 측정 위치·시간·자세에 따른 오차가 있으므로 단기 변화는 과도하게 해석하지 않는다.'
  ].join(' ');
  const payload={model:getOpenAiModel_(),store:false,instructions:finalInstructions,input:JSON.stringify(input),text:{format:{type:'json_schema',name:'integrated_health_analysis',strict:true,schema:schema}}};
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

function getOpenAiKey_(){return PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY')||'';}

function getOpenAiModel_(){return PropertiesService.getScriptProperties().getProperty('OPENAI_MODEL')||'gpt-5-mini';}

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
