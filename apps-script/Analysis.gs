/** Workout Logger - statistics, recovery/nutrition/activity calculations, and analysis helpers. */

function buildStatistics_(healthFiles,fitnessFiles,strengthFiles,nutritionFiles,periodFrom,periodTo) {
  healthFiles=dedupeCollectedFiles_(healthFiles||[]);
  fitnessFiles=dedupeCollectedFiles_(fitnessFiles||[]);
  strengthFiles=dedupeCollectedFiles_(strengthFiles||[]);
  nutritionFiles=dedupeCollectedFiles_(nutritionFiles||[]);

  const metrics={};
  const recoveryMetrics={};
  const heartRateSamples=[];
  const sleepRecords=[];
  const recoveryHistoryFrom=addDays_(periodTo,-27);
  const recoveryQtyNames={
    heart_rate_variability:true,
    resting_heart_rate:true,
    blood_oxygen_saturation:true,
    respiratory_rate:true,
    walking_heart_rate_average:true,
    vo2_max:true
  };

  healthFiles.forEach(x=>{
    const arr=x.data && x.data.data && x.data.data.metrics || [];
    arr.forEach(m=>{
      const name=m.name; if(!name)return;
      if(!metrics[name]) metrics[name]=[];
      if(recoveryQtyNames[name]&&!recoveryMetrics[name])recoveryMetrics[name]=[];

      (m.data||[]).forEach(v=>{
        const t=parseDate_(v.date);
        if(!(t<=periodTo))return;

        // 일반 심박은 qty가 아니라 Avg/Min/Max 구조입니다.
        if(name==='heart_rate'){
          if(t>=recoveryHistoryFrom){
            const avg=isFinite(Number(v.Avg))?Number(v.Avg):null;
            const min=isFinite(Number(v.Min))?Number(v.Min):avg;
            const max=isFinite(Number(v.Max))?Number(v.Max):avg;
            if(avg!==null)heartRateSamples.push({t:t.getTime(),avg:avg,min:min,max:max,units:m.units||''});
          }
          return;
        }

        // 수면은 qty가 아니라 totalSleep/deep/core/rem/awake 등의 구조입니다.
        if(name==='sleep_analysis'){
          if(t>=recoveryHistoryFrom){
            const totalSleep=isFinite(Number(v.totalSleep))?Number(v.totalSleep):null;
            if(totalSleep!==null){
              sleepRecords.push({
                t:t.getTime(),
                date:v.date||null,
                sleepStart:v.sleepStart||v.inBedStart||null,
                sleepEnd:v.sleepEnd||v.inBedEnd||null,
                totalSleep:totalSleep,
                deep:isFinite(Number(v.deep))?Number(v.deep):null,
                core:isFinite(Number(v.core))?Number(v.core):null,
                rem:isFinite(Number(v.rem))?Number(v.rem):null,
                awake:isFinite(Number(v.awake))?Number(v.awake):null,
                inBed:isFinite(Number(v.inBed))?Number(v.inBed):null,
                source:v.source||null
              });
            }
          }
          return;
        }

        if(isFinite(Number(v.qty))){
          const point={t:t.getTime(),qty:Number(v.qty),units:m.units||''};
          if(t>=periodFrom)metrics[name].push(point);
          if(recoveryQtyNames[name]&&t>=recoveryHistoryFrom)recoveryMetrics[name].push(point);
        }
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
  const metricDailyAvg=(day,name)=>round_(avg_(daily[day]&&daily[day][name]||[]),2);
  const metricDailySum=(day,name)=>round_(sum_(daily[day]&&daily[day][name]||[]),2);
  const normalizePercent=(v)=>v!==null&&v!==undefined&&isFinite(Number(v))&&Number(v)>0&&Number(v)<=1?round_(Number(v)*100,1):v;
  const median_=(values)=>{
    const a=(values||[]).filter(v=>v!==null&&v!==undefined&&isFinite(Number(v))).map(Number).sort((a,b)=>a-b);
    if(!a.length)return null;
    const mid=Math.floor(a.length/2);
    return a.length%2?a[mid]:(a[mid-1]+a[mid])/2;
  };
  const intensityCategory_=(met)=>{
    if(met===null||met===undefined||!isFinite(Number(met)))return null;
    const n=Number(met);
    if(n<3)return 'low';
    if(n<6)return 'moderate';
    return 'vigorous';
  };
  const summarizePhysicalEffort_=(series,startMs,endMs)=>{
    const points=(series||[])
      .filter(v=>v.t>=startMs&&v.t<=endMs&&isFinite(Number(v.qty)))
      .sort((a,b)=>a.t-b.t);
    if(!points.length){
      return {
        sample_count:0,
        avg_met:null,
        median_met:null,
        max_met:null,
        low_minutes_est:null,
        moderate_minutes_est:null,
        vigorous_minutes_est:null,
        coverage_minutes_est:null,
        granularity:'health_physical_effort_samples'
      };
    }
    const values=points.map(v=>Number(v.qty));
    const minutes={low:0,moderate:0,vigorous:0};
    let coverageSeconds=0;
    points.forEach((v,i)=>{
      const next=points[i+1];
      // Physical Effort export is sampled, not a continuous second-level stream.
      // Count at most 90 seconds per sample so long gaps are not falsely treated as continuous effort.
      let seconds=60;
      if(next){
        const gap=(next.t-v.t)/1000;
        if(gap>0)seconds=Math.min(90,gap);
      }
      if(v.t+seconds*1000>endMs)seconds=Math.max(0,(endMs-v.t)/1000);
      const category=intensityCategory_(v.qty);
      if(category)minutes[category]+=seconds/60;
      coverageSeconds+=seconds;
    });
    return {
      sample_count:points.length,
      avg_met:round_(avg_(values),2),
      median_met:round_(median_(values),2),
      max_met:round_(Math.max.apply(null,values),2),
      low_minutes_est:round_(minutes.low,1),
      moderate_minutes_est:round_(minutes.moderate,1),
      vigorous_minutes_est:round_(minutes.vigorous,1),
      coverage_minutes_est:round_(coverageSeconds/60,1),
      granularity:'health_physical_effort_samples',
      note:'Estimated from Health Auto Export physical_effort samples; durations are capped per sample to avoid filling long sampling gaps.'
    };
  };
  const physicalEffortSeries=(metrics.physical_effort||[]).slice().sort((a,b)=>a.t-b.t);
  const physicalEffortPeriod=summarizePhysicalEffort_(physicalEffortSeries,periodFrom.getTime(),periodTo.getTime());
  const periodDays=[];
  const cursor=startOfDay_(periodFrom);
  const endDay=startOfDay_(periodTo);
  while(cursor<=endDay){
    periodDays.push(Utilities.formatDate(cursor,TIME_ZONE,'yyyy-MM-dd'));
    cursor.setDate(cursor.getDate()+1);
  }
  const weeklyBodySeries=periodDays.map(d=>({
    date:d,
    weight_kg:metricDailyAvg(d,'weight_body_mass'),
    body_fat_pct:normalizePercent(metricDailyAvg(d,'body_fat_percentage')),
    bmi:metricDailyAvg(d,'body_mass_index')
  }));
  const movingAverageSeries=(series,key,outKey,windowDays)=>series.map((row,idx)=>{
    const start=Math.max(0,idx-windowDays+1);
    const values=series.slice(start,idx+1)
      .map(x=>x[key])
      .filter(v=>v!==null&&v!==undefined&&isFinite(Number(v)))
      .map(Number);
    const out={date:row.date};
    out[outKey]=values.length?round_(avg_(values),2):null;
    out[outKey+'_sample_count']=values.length;
    return out;
  });
  const firstNonNullInSeries=(series,key)=>{
    for(let i=0;i<series.length;i++){
      const v=series[i]&&series[i][key];
      if(v!==null&&v!==undefined&&isFinite(Number(v)))return Number(v);
    }
    return null;
  };
  const lastNonNullInSeries=(series,key)=>{
    for(let i=series.length-1;i>=0;i--){
      const v=series[i]&&series[i][key];
      if(v!==null&&v!==undefined&&isFinite(Number(v)))return Number(v);
    }
    return null;
  };
  const weightMa7=movingAverageSeries(weeklyBodySeries,'weight_kg','weight_kg_ma7',7);
  const bodyFatMa7=movingAverageSeries(weeklyBodySeries,'body_fat_pct','body_fat_pct_ma7',7);
  const bmiMa7=movingAverageSeries(weeklyBodySeries,'bmi','bmi_ma7',7);
  const bodyTrendSeries=weeklyBodySeries.map((row,idx)=>Object.assign({},row,weightMa7[idx],bodyFatMa7[idx],bmiMa7[idx]));
  const weightMaFirst=firstNonNullInSeries(bodyTrendSeries,'weight_kg_ma7');
  const weightMaLatest=lastNonNullInSeries(bodyTrendSeries,'weight_kg_ma7');
  const bodyFatMaLatest=lastNonNullInSeries(bodyTrendSeries,'body_fat_pct_ma7');
  const bmiMaLatest=lastNonNullInSeries(bodyTrendSeries,'bmi_ma7');
  const weeklyWaistSeries=periodDays.map(d=>({
    date:d,
    waist_cm:metricDailyAvg(d,'waist_circumference')
  }));
  const dailyActivitySeries=periodDays.map(d=>({
    date:d,
    steps:round_(metricDailySum(d,'step_count'),0),
    walking_running_distance_km:metricDailySum(d,'walking_running_distance'),
    active_kcal:round_(metricDailySum(d,'active_energy')/4.184,1),
    exercise_minutes:metricDailySum(d,'apple_exercise_time')
  }));
  const workoutDistanceKm=(w)=>{
    const distance=w.distance||w.totalDistance||w.walkingRunningDistance||w.walkingAndRunningDistance||w.total_distance;
    const qty=distance&&isFinite(Number(distance.qty))?Number(distance.qty):0;
    if(!qty)return null;
    const unit=String(distance.units||distance.unit||'').toLowerCase();
    if(unit==='m'||unit==='meter'||unit==='meters')return qty/1000;
    return qty;
  };
  const workoutCadence=(w)=>num_(w.stepCadence&&w.stepCadence.qty||w.cadence&&w.cadence.qty||w.avgCadence&&w.avgCadence.qty);
  const workoutIntensityMet=(w)=>{
    const raw=w&&w.intensity;
    const value=raw&&typeof raw==='object'?raw.qty:raw;
    const n=Number(value);
    return isFinite(n)&&n>0?round_(n,2):null;
  };
  const isWalkRunWorkout=(w,distanceKm,paceMinPerKm,cadenceSpm)=>{
    const name=String(w&&w.name||'');
    if(/\uC790\uC804\uAC70|\uC0AC\uC774\uD074|bike|cycle|cycling/i.test(name))return false;
    if(/\uAC77|\uB2EC\uB9AC|\uB7EC\uB2DD|\uB7F0\uB2DD|walk|run/i.test(name))return true;
    return Number(distanceKm)>0&&Number(paceMinPerKm)>0&&Number(cadenceSpm)>0;
  };
  const routePoints=(w)=>{
    const r=w&&((Array.isArray(w.route)&&w.route)||(Array.isArray(w.routes)&&w.routes)||(Array.isArray(w.locations)&&w.locations)||(w.route&&Array.isArray(w.route.data)&&w.route.data));
    return Array.isArray(r)?r:[];
  };
  const routeCoord=(p,key1,key2)=>{
    if(!p)return null;
    const v=p[key1]!==undefined?p[key1]:(p.coordinate&&p.coordinate[key2]);
    const n=Number(v);
    return isFinite(n)?n:null;
  };
  const routeSignature=(w,distanceKm)=>{
    const points=routePoints(w).filter(p=>routeCoord(p,'latitude','latitude')!==null&&routeCoord(p,'longitude','longitude')!==null);
    if(points.length<2)return null;
    const first=points[0],last=points[points.length-1];
    const a=[routeCoord(first,'latitude','latitude').toFixed(3),routeCoord(first,'longitude','longitude').toFixed(3)].join(',');
    const b=[routeCoord(last,'latitude','latitude').toFixed(3),routeCoord(last,'longitude','longitude').toFixed(3)].join(',');
    const endpoints=[a,b].sort().join('|');
    const distanceBucket=distanceKm?Math.round(Number(distanceKm)*2)/2:0;
    return endpoints+'|'+distanceBucket;
  };

  const cardioDisplayName=(w,distanceKm,paceMinPerKm,cadenceSpm,isWalkRun)=>{
    const name=String(w&&w.name||'');
    if(!isWalkRun)return name||'\uC6B4\uB3D9';
    const genericIndoor=/^\s*(\uC2E4\uB0B4\s*\uC6B4\uB3D9|Indoor\s+Workout)\s*$/i.test(name);
    if(!genericIndoor)return name||'\uC6B4\uB3D9';
    if(Number(distanceKm)>0&&Number(paceMinPerKm)>0&&Number(cadenceSpm)>0){
      return Number(paceMinPerKm)<=10||Number(cadenceSpm)>=120?'\uC2E4\uB0B4 \uB2EC\uB9AC\uAE30':'\uC2E4\uB0B4 \uAC77\uAE30';
    }
    return name||'\uC6B4\uB3D9';
  };

  const metricSeries=(box)=>{
    const raw=Array.isArray(box)?box:(box&&Array.isArray(box.data)?box.data:[]);
    return raw.map(v=>{
      const t=parseDate_(v.date);
      const qty=Number(v.qty);
      return {t:t.getTime(),qty:qty,units:String(v.units||v.unit||box&&box.units||box&&box.unit||'')};
    }).filter(v=>v.t>0&&isFinite(v.qty)).sort((a,b)=>a.t-b.t);
  };
  const workoutSeries=(w,keys)=>{
    for(let i=0;i<keys.length;i++){
      const s=metricSeries(w&&w[keys[i]]);
      if(s.length)return s;
    }
    return [];
  };
  const seriesQtyAsKm=(v)=>{
    if(!v||!isFinite(Number(v.qty)))return 0;
    const unit=String(v.units||'').toLowerCase();
    if(unit==='m'||unit==='meter'||unit==='meters')return Number(v.qty)/1000;
    return Number(v.qty);
  };
  const avgSeriesInWindow=(series,startMs,endMs)=>{
    const values=series.filter(v=>v.t>=startMs&&v.t<=endMs).map(v=>Number(v.qty)).filter(v=>isFinite(v));
    return values.length?round_(avg_(values),1):null;
  };
  const zoneForHr=(hr)=>{
    if(!isFinite(Number(hr)))return null;
    const n=Number(hr);
    if(n<137)return 'zone1';
    if(n<=147)return 'zone2';
    if(n<=158)return 'zone3';
    if(n<=169)return 'zone4';
    return 'zone5';
  };
  const buildHeartRateZones=(hrSeries,startMs,endMs)=>{
    const zones={zone1_seconds:0,zone2_seconds:0,zone3_seconds:0,zone4_seconds:0,zone5_seconds:0};
    if(!hrSeries.length)return zones;
    for(let i=0;i<hrSeries.length;i++){
      const current=hrSeries[i];
      if(current.t<startMs||current.t>endMs)continue;
      const next=hrSeries[i+1];
      const nextT=next?Math.min(next.t,endMs):Math.min(current.t+60000,endMs);
      const seconds=Math.max(0,(nextT-current.t)/1000);
      const zone=zoneForHr(current.qty);
      if(zone)zones[zone+'_seconds']+=seconds;
    }
    Object.keys(zones).forEach(k=>zones[k]=round_(zones[k],0));
    return zones;
  };
  const buildHeartRateRecovery=(series)=>{
    if(!series.length)return null;
    const first=series[0];
    const nearest=(targetMs)=>{
      let best=null;
      series.forEach(v=>{
        if(!best||Math.abs(v.t-targetMs)<Math.abs(best.t-targetMs))best=v;
      });
      return best&&Math.abs(best.t-targetMs)<=45000?round_(best.qty,0):null;
    };
    const one=nearest(first.t+60000);
    const two=nearest(first.t+120000);
    return {
      start_hr:round_(first.qty,0),
      one_min_hr:one,
      two_min_hr:two,
      one_min_drop:one!==null?round_(first.qty-one,0):null,
      two_min_drop:two!==null?round_(first.qty-two,0):null
    };
  };
  const buildSplitSummary=(distanceSeries,hrSeries,cadenceSeries,startMs,durationMin,totalDistanceKm)=>{
    if(!distanceSeries.length||!Number(totalDistanceKm))return [];
    const splits=[];
    let acc=0;
    let splitStartMs=startMs;
    let target=1;
    distanceSeries.forEach(v=>{
      const km=seriesQtyAsKm(v);
      if(km<=0)return;
      const before=acc;
      acc+=km;
      while(target<=acc&&splits.length<8){
        const ratio=km>0?(target-before)/km:1;
        const splitEndMs=v.t;
        const seconds=Math.max(0,(splitEndMs-splitStartMs)/1000);
        const avgHr=avgSeriesInWindow(hrSeries,splitStartMs,splitEndMs);
        const avgCadence=avgSeriesInWindow(cadenceSeries,splitStartMs,splitEndMs);
        splits.push({
          km:target,
          duration_seconds:round_(seconds,0),
          pace_min_per_km:seconds>0?round_(seconds/60,2):null,
          avg_hr:avgHr,
          avg_cadence_spm:avgCadence,
          confidence:ratio>=0&&ratio<=1?'minute_estimate':'low'
        });
        splitStartMs=splitEndMs;
        target++;
      }
    });
    const remaining=round_(Number(totalDistanceKm||0)-Math.floor(Number(totalDistanceKm||0)),2);
    if(remaining>=0.2&&splits.length<8){
      const endMs=startMs+Number(durationMin||0)*60000;
      const seconds=Math.max(0,(endMs-splitStartMs)/1000);
      splits.push({
        km:round_(Math.floor(Number(totalDistanceKm))+remaining,2),
        duration_seconds:round_(seconds,0),
        pace_min_per_km:seconds>0?round_((seconds/60)/remaining,2):null,
        avg_hr:avgSeriesInWindow(hrSeries,splitStartMs,endMs),
        avg_cadence_spm:avgSeriesInWindow(cadenceSeries,splitStartMs,endMs),
        confidence:'partial_minute_estimate'
      });
    }
    return splits;
  };
  const buildCardioQualityDetail=(w,start,durationMin,distanceKm)=>{
    const startMs=start.getTime();
    const endMs=startMs+Number(durationMin||0)*60000;
    const hrSeries=workoutSeries(w,['heartRateData','heart_rate_data','heartRate']);
    const cadenceSeries=workoutSeries(w,['stepCadence','cadence','avgCadence']);
    const distanceSeries=workoutSeries(w,['walkingAndRunningDistance','walkingRunningDistance','distance']);
    const recoverySeries=workoutSeries(w,['heartRateRecovery','heart_rate_recovery']);
    const splits=buildSplitSummary(distanceSeries,hrSeries,cadenceSeries,startMs,durationMin,distanceKm);
    const firstHr=hrSeries.length?hrSeries[0].t:null;
    return {
      granularity:'minute_level_estimate',
      note:'Derived from Health Auto Export workout metric series. Values can differ from Apple Fitness second-level calculations.',
      heart_rate_data_starts_after_seconds:firstHr?round_((firstHr-startMs)/1000,0):null,
      splits_1km:splits,
      heart_rate_zones:buildHeartRateZones(hrSeries,startMs,endMs),
      heart_rate_recovery:buildHeartRateRecovery(recoverySeries),
      physical_effort:summarizePhysicalEffort_(physicalEffortSeries,startMs,endMs),
      available_series:{
        distance_points:distanceSeries.length,
        heart_rate_points:hrSeries.length,
        cadence_points:cadenceSeries.length,
        recovery_points:recoverySeries.length,
        physical_effort_points:physicalEffortSeries.filter(v=>v.t>=startMs&&v.t<=endMs).length
      }
    };
  };

  const workouts=[];
  const workoutIds={};
  fitnessFiles.forEach(x=>((x.data&&x.data.data&&x.data.data.workouts)||[]).forEach(w=>{
    const start=parseDate_(w.start); if(start<periodFrom||start>periodTo)return;
    const key=w.id||[w.start,w.end,w.name].join('|'); if(workoutIds[key])return; workoutIds[key]=true;
    const durationMin=Number(w.duration||0)/60;
    const activeKj=Number(w.activeEnergyBurned&&w.activeEnergyBurned.qty||0);
    const distanceKm=workoutDistanceKm(w);
    const paceMinPerKm=distanceKm?round_(durationMin/distanceKm,2):null;
    const cadenceSpm=workoutCadence(w);
    const isWalkRun=isWalkRunWorkout(w,distanceKm,paceMinPerKm,cadenceSpm);
    const gpsRouteSignature=routeSignature(w,distanceKm);
    const cardioQuality=isWalkRun?buildCardioQualityDetail(w,start,durationMin,distanceKm):null;
    const fitnessIntensityMet=workoutIntensityMet(w);
    const physicalEffortSummary=summarizePhysicalEffort_(physicalEffortSeries,start.getTime(),start.getTime()+durationMin*60000);
    const representativeIntensityMet=fitnessIntensityMet!==null?fitnessIntensityMet:physicalEffortSummary.avg_met;
    workouts.push({
      name:cardioDisplayName(w,distanceKm,paceMinPerKm,cadenceSpm,isWalkRun),
      original_name:w.name||'\uC6B4\uB3D9',
      start:formatIso_(start),
      duration_min:round_(durationMin,1),
      active_kcal:round_(activeKj/4.184,1),
      avg_hr:num_(w.avgHeartRate&&w.avgHeartRate.qty||w.heartRate&&w.heartRate.avg&&w.heartRate.avg.qty),
      max_hr:num_(w.maxHeartRate&&w.maxHeartRate.qty||w.heartRate&&w.heartRate.max&&w.heartRate.max.qty),
      distance_km:round_(distanceKm,2),
      pace_min_per_km:paceMinPerKm,
      cadence_spm:cadenceSpm,
      intensity_met:representativeIntensityMet,
      intensity_category:intensityCategory_(representativeIntensityMet),
      intensity_source:fitnessIntensityMet!==null?'fitness_workout_intensity':(physicalEffortSummary.avg_met!==null?'health_physical_effort_avg':'unavailable'),
      fitness_intensity_met:fitnessIntensityMet,
      physical_effort:physicalEffortSummary,
      has_gps_route:!!gpsRouteSignature,
      route_signature:gpsRouteSignature,
      is_walk_run:isWalkRun,
      cardio_quality_detail:cardioQuality
    });
  }));
  const routeCounts={};
  workouts.forEach(w=>{if(w.is_walk_run&&w.route_signature)routeCounts[w.route_signature]=(routeCounts[w.route_signature]||0)+1;});
  workouts.forEach(w=>{
    w.is_commute_like=!!(w.route_signature&&routeCounts[w.route_signature]>1);
    w.is_slow_outdoor_walk=!!(w.has_gps_route&&Number(w.pace_min_per_km)>=15);
    w.cardio_exclusion_reason=w.is_commute_like?'repeated_gps_route':(w.is_slow_outdoor_walk?'slow_outdoor_walk':null);
  });
  const cardioWorkouts=workouts.filter(w=>w.is_walk_run&&!w.cardio_exclusion_reason);
  const recentCardioWorkouts=cardioWorkouts.slice()
    .sort((a,b)=>parseDate_(a.start).getTime()-parseDate_(b.start).getTime())
    .slice(-5);
  const cardioDistance=sum_(cardioWorkouts.map(w=>w.distance_km||0));
  const cardioMinutes=sum_(cardioWorkouts.map(w=>w.duration_min||0));
  const cardioKcal=sum_(cardioWorkouts.map(w=>w.active_kcal||0));
  const cardioHrWeighted=sum_(cardioWorkouts.map(w=>(w.avg_hr||0)*(w.duration_min||0)));
  const cardioIntensityMinutes=cardioWorkouts.filter(w=>w.intensity_met!==null).reduce((s,w)=>s+Number(w.duration_min||0),0);
  const cardioIntensityWeighted=cardioWorkouts.filter(w=>w.intensity_met!==null).reduce((s,w)=>s+Number(w.intensity_met)*Number(w.duration_min||0),0);
  const cardioIntensityValues=cardioWorkouts.map(w=>w.intensity_met).filter(v=>v!==null&&isFinite(Number(v))).map(Number);
  const cardioPhysicalEffort={
    sample_count:round_(sum_(cardioWorkouts.map(w=>w.physical_effort&&w.physical_effort.sample_count||0)),0),
    low_minutes_est:round_(sum_(cardioWorkouts.map(w=>w.physical_effort&&w.physical_effort.low_minutes_est||0)),1),
    moderate_minutes_est:round_(sum_(cardioWorkouts.map(w=>w.physical_effort&&w.physical_effort.moderate_minutes_est||0)),1),
    vigorous_minutes_est:round_(sum_(cardioWorkouts.map(w=>w.physical_effort&&w.physical_effort.vigorous_minutes_est||0)),1),
    coverage_minutes_est:round_(sum_(cardioWorkouts.map(w=>w.physical_effort&&w.physical_effort.coverage_minutes_est||0)),1)
  };
  const cardioSummary={
    session_count:cardioWorkouts.length,
    total_minutes:round_(cardioMinutes,1),
    distance_km:round_(cardioDistance,2),
    avg_pace_min_per_km:cardioDistance?round_(cardioMinutes/cardioDistance,2):null,
    avg_hr:cardioMinutes?round_(cardioHrWeighted/cardioMinutes,1):null,
    active_kcal:round_(cardioKcal,1),
    avg_intensity_met:cardioIntensityMinutes?round_(cardioIntensityWeighted/cardioIntensityMinutes,2):null,
    max_intensity_met:cardioIntensityValues.length?round_(Math.max.apply(null,cardioIntensityValues),2):null,
    intensity_source_priority:'Fitness workout intensity first; Health physical_effort average is fallback.',
    physical_effort_distribution:cardioPhysicalEffort,
    quality_detail_note:'Cardio sessions in the selected analysis period include minute-level estimated splits, heart-rate zones, cadence, recovery, Fitness intensity (MET-equivalent), and Health physical_effort when available.',
    quality_sessions:cardioWorkouts.map(w=>({
      name:w.name,
      start:w.start,
      distance_km:w.distance_km,
      pace_min_per_km:w.pace_min_per_km,
      avg_hr:w.avg_hr,
      cadence_spm:w.cadence_spm,
      active_kcal:w.active_kcal,
      intensity_met:w.intensity_met,
      intensity_category:w.intensity_category,
      intensity_source:w.intensity_source,
      fitness_intensity_met:w.fitness_intensity_met,
      physical_effort:w.physical_effort,
      cardio_quality_detail:w.cardio_quality_detail
    }))
  };
  const excludedCardioWorkouts=workouts
    .filter(w=>w.is_walk_run&&w.cardio_exclusion_reason)
    .map(w=>({
      name:w.name,
      start:w.start,
      distance_km:w.distance_km,
      pace_min_per_km:w.pace_min_per_km,
      reason:w.cardio_exclusion_reason
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
    const name=String(ex.exercise||'unknown');
    if(!byExercise[name])byExercise[name]={sessions:0,sets:0,reps:0,volume_kg:0,timed_seconds:0,last_weight_kg:null,last_recorded_at:null,rpe_values:[]};
    const a=byExercise[name]; a.sessions++; a.sets+=Number(ex.sets||0); a.reps+=Number(ex.reps||0)*Number(ex.sets||0); a.volume_kg+=Number(ex.weight_kg||0)*Number(ex.reps||0)*Number(ex.sets||0); a.timed_seconds+=Number(ex.seconds||0)*Number(ex.sets||0);
    if(Number(ex.weight_kg||0)>0)a.last_weight_kg=Number(ex.weight_kg); a.last_recorded_at=ex.recorded_at||s.finished_at||s.started_at;
    if(ex.rpe!==null&&ex.rpe!==undefined&&isFinite(Number(ex.rpe)))a.rpe_values.push(Number(ex.rpe));
    totalSets+=Number(ex.sets||0); totalReps+=Number(ex.reps||0)*Number(ex.sets||0); totalVolume+=Number(ex.weight_kg||0)*Number(ex.reps||0)*Number(ex.sets||0); totalTimedSeconds+=Number(ex.seconds||0)*Number(ex.sets||0);
    if(Number(ex.pain_level||0)>0)pain.push({date:ex.recorded_at||s.finished_at||s.started_at,exercise:name,level:Number(ex.pain_level),area:ex.pain_area||'unknown',memo:ex.memo||''});
  }));
  Object.keys(byExercise).forEach(k=>{const a=byExercise[k];a.volume_kg=round_(a.volume_kg,1);a.avg_rpe=a.rpe_values.length?round_(avg_(a.rpe_values),1):null;delete a.rpe_values;});
  const strengthDailySessions=strengthSessions.slice()
    .sort((a,b)=>getSessionTimestamp_(a)-getSessionTimestamp_(b))
    .map(s=>{
      const t=parseDate_(s.finished_at||s.started_at||s.date||s.created_at);
      const exercises=(s.exercises||[]).map(ex=>{
        const sets=Number(ex.sets||0);
        const reps=Number(ex.reps||0);
        const weight=Number(ex.weight_kg||0);
        const seconds=Number(ex.seconds||0);
        return {
          exercise:String(ex.exercise||'unknown'),
          type:ex.record_type||ex.type||'',
          weight_kg:weight||0,
          reps:reps||0,
          sets:sets||0,
          seconds:seconds||0,
          volume_kg:round_(weight*reps*sets,1),
          total_reps:round_(reps*sets,0),
          rpe:ex.rpe!==null&&ex.rpe!==undefined&&isFinite(Number(ex.rpe))?Number(ex.rpe):null,
          pain_level:ex.pain_level!==null&&ex.pain_level!==undefined&&isFinite(Number(ex.pain_level))?Number(ex.pain_level):0,
          pain_area:ex.pain_area||'',
          memo:ex.memo||''
        };
      });
      const rpes=exercises.map(ex=>ex.rpe).filter(v=>v!==null);
      return {
        date:Utilities.formatDate(t,TIME_ZONE,'yyyy-MM-dd'),
        started_at:s.started_at||null,
        finished_at:s.finished_at||null,
        exercise_count:exercises.length,
        total_sets:round_(sum_(exercises.map(ex=>ex.sets)),0),
        total_reps:round_(sum_(exercises.map(ex=>ex.total_reps)),0),
        total_volume_kg:round_(sum_(exercises.map(ex=>ex.volume_kg)),1),
        timed_seconds:round_(sum_(exercises.map(ex=>ex.seconds*ex.sets)),0),
        avg_rpe:rpes.length?round_(avg_(rpes),1):null,
        max_pain_level:exercises.length?Math.max.apply(null,exercises.map(ex=>ex.pain_level||0)):0,
        exercises:exercises
      };
    });

  const weightLatest=latestMetric('weight_body_mass');
  const weightFirst=firstMetric('weight_body_mass');
  const waistMeasurements=(metrics.waist_circumference||[]).length;
  const waistLatest=latestMetric('waist_circumference');
  const waistFirst=firstMetric('waist_circumference');
  const waistChange=waistMeasurements>=2&&waistLatest!==null&&waistFirst!==null?round_(waistLatest-waistFirst,1):null;
  const metricCount=(name)=>(metrics[name]||[]).length;
  const metricDays=(name)=>periodDays.filter(d=>daily[d]&&daily[d][name]&&daily[d][name].length).length;
  const recoveryStats=buildRecoveryStatistics_(recoveryMetrics,heartRateSamples,sleepRecords,periodTo);
  const nutritionStats=buildNutritionStatistics_(nutritionFiles,periodFrom,periodTo);
  const missingOrSparse=[];
  if(metricCount('weight_body_mass')<2)missingOrSparse.push('weight_body_mass has fewer than 2 measurements in the analysis period. Weight trend confidence is low.');
  if(metricCount('body_fat_percentage')<2)missingOrSparse.push('body_fat_percentage has fewer than 2 measurements in the analysis period. Body-fat trend confidence is low.');
  if(metricCount('body_mass_index')<2)missingOrSparse.push('body_mass_index has fewer than 2 measurements in the analysis period. BMI trend confidence is low.');
  if((recoveryStats.resting_heart_rate&&recoveryStats.resting_heart_rate.days_7d||0)<3)missingOrSparse.push('resting_heart_rate coverage is sparse in the recent 7-day window. Recovery assessment should be conservative.');
  if(!(recoveryMetrics.heart_rate_variability||[]).length)missingOrSparse.push('heart_rate_variability is not available in the recovery lookback window, so recovery analysis cannot use HRV.');
  if(!sleepRecords.length)missingOrSparse.push('sleep_analysis is not available in the recovery lookback window, so sleep-based recovery confidence is limited.');
  if(!nutritionStats.days_recorded)missingOrSparse.push('Nutrition source records are not available in the analysis period, so calorie intake and energy balance cannot be evaluated.');
  if(!metricCount('physical_effort'))missingOrSparse.push('physical_effort is not available in Health exports. Absolute-intensity analysis will rely on Fitness workout intensity when present.');
  if(!workouts.some(w=>w.fitness_intensity_met!==null))missingOrSparse.push('Fitness workout intensity is not available in the selected workouts. Absolute-intensity analysis will use Health physical_effort when available.');
  if(!strengthSessions.length)missingOrSparse.push('No manual strength sessions were recorded in the analysis period. Strength-volume conclusions should be cautious.');
  const dataDiagnosis={
    analysis_days:periodDays.length,
    file_counts:{health:healthFiles.length,fitness:fitnessFiles.length,strength:strengthFiles.length,nutrition:nutritionFiles.length},
    available_metrics:Object.keys(metrics).sort(),
    measurement_counts:{
      weight:metricCount('weight_body_mass'),
      body_fat:metricCount('body_fat_percentage'),
      bmi:metricCount('body_mass_index'),
      waist:metricCount('waist_circumference'),
      resting_hr:metricCount('resting_heart_rate'),
      heart_rate:heartRateSamples.length,
      hrv:(recoveryMetrics.heart_rate_variability||[]).length,
      sleep:sleepRecords.length,
      blood_oxygen:(recoveryMetrics.blood_oxygen_saturation||[]).length,
      respiratory_rate:(recoveryMetrics.respiratory_rate||[]).length,
      dietary_energy:metricCount('dietary_energy_consumed'),
      physical_effort:metricCount('physical_effort')
    },
    days_with_metric:{
      weight:metricDays('weight_body_mass'),
      body_fat:metricDays('body_fat_percentage'),
      bmi:metricDays('body_mass_index'),
      resting_hr:metricDays('resting_heart_rate'),
      steps:metricDays('step_count'),
      active_energy:metricDays('active_energy'),
      exercise_minutes:metricDays('apple_exercise_time'),
      physical_effort:metricDays('physical_effort')
    },
    cardio:{
      included_sessions:cardioWorkouts.length,
      excluded_sessions:excludedCardioWorkouts.length,
      excluded_workouts:excludedCardioWorkouts
    },
    strength:{
      recorded_sessions:strengthSessions.length,
      manual_tracking_start_note:'Manual strength logging started on 2026-07-20; earlier gaps may reflect missing records rather than no training.'
    },
    missing_or_sparse:missingOrSparse
  };
  return {
    coverage:{from:formatIso_(periodFrom),to:formatIso_(periodTo),analysis_days:periodDays.length,days_with_health_data:days.length,file_counts:dataDiagnosis.file_counts},
    data_diagnosis:dataDiagnosis,
    body:{weight_latest_kg:weightLatest,weight_first_kg:weightFirst,weight_change_kg:weightLatest!==null&&weightFirst!==null?round_(weightLatest-weightFirst,2):null,body_fat_latest_pct:normalizePercent(latestMetric('body_fat_percentage')),lean_mass_latest_kg:latestMetric('lean_body_mass'),bmi_latest:latestMetric('body_mass_index'),weight_measurements:(metrics.weight_body_mass||[]).length,waist_latest_cm:waistLatest,waist_first_cm:waistFirst,waist_change_cm:waistChange,waist_measurements:waistMeasurements,weekly_body_series:weeklyBodySeries,weekly_waist_series:weeklyWaistSeries,body_trend:{weight_kg_ma7_latest:weightMaLatest,weight_kg_ma7_first:weightMaFirst,weight_kg_ma7_change:weightMaLatest!==null&&weightMaFirst!==null?round_(weightMaLatest-weightMaFirst,2):null,body_fat_pct_ma7_latest:bodyFatMaLatest,bmi_ma7_latest:bmiMaLatest,moving_average_series:bodyTrendSeries}},
    activity:{steps_total:round_(sumMetric('step_count'),0),steps_daily_average:round_(avg_(dailySums('step_count')),0),distance_total_km:sumMetric('walking_running_distance'),active_energy_total_kcal:round_(sumMetric('active_energy')/4.184,1),basal_energy_total_kcal:round_(sumMetric('basal_energy_burned')/4.184,1),exercise_minutes_total:sumMetric('apple_exercise_time'),stand_minutes_total:sumMetric('apple_stand_time'),daily_activity_series:dailyActivitySeries,physical_effort:physicalEffortPeriod,cardio_summary:cardioSummary,cardio_sessions:recentCardioWorkouts},
    heart_rate:{resting_hr_average:round_(avg_(dailyAvgs('resting_heart_rate')),1),resting_hr_latest:latestMetric('resting_heart_rate'),walking_hr_average:round_(avg_(dailyAvgs('walking_heart_rate_average')),1),heart_rate_average:recoveryStats.heart_rate&&recoveryStats.heart_rate.avg_7d_bpm||null,oxygen_saturation_latest:recoveryStats.blood_oxygen&&recoveryStats.blood_oxygen.latest_pct||null},
    fitness:{session_count:workouts.length,total_minutes:round_(workouts.reduce((s,w)=>s+w.duration_min,0),1),active_kcal:round_(workouts.reduce((s,w)=>s+w.active_kcal,0),1),cardio_sessions:recentCardioWorkouts,sessions:workouts.slice(-50)},
    strength:{session_count:strengthSessions.length,total_sets:totalSets,total_reps:totalReps,total_volume_kg:round_(totalVolume,1),timed_seconds:totalTimedSeconds,by_exercise:byExercise,daily_sessions:strengthDailySessions.slice(-60)},
    pain:{event_count:pain.length,max_level:pain.length?Math.max.apply(null,pain.map(x=>x.level)):0,events:pain.slice(-30)},
    recovery:recoveryStats,
    nutrition:nutritionStats,
    weight_loss_context:{
      goal:'체중감량',
      active_energy_expenditure_kcal:round_(sumMetric('active_energy')/4.184,1),
      basal_energy_expenditure_kcal:round_(sumMetric('basal_energy_burned')/4.184,1),
      food_intake_data_available:nutritionStats.days_recorded>0,
      complete_nutrition_days:nutritionStats.complete_days,
      incomplete_nutrition_days:nutritionStats.incomplete_days,
      complete_day_average_calories_kcal:nutritionStats.complete_day_average?nutritionStats.complete_day_average.calories_kcal:null,
      estimated_complete_day_average_calories_kcal:nutritionStats.estimated_complete_day_average?nutritionStats.estimated_complete_day_average.calories_kcal:null,
      note:nutritionStats.days_recorded
        ? '완전 기록일의 실제 섭취량을 우선 사용합니다. 불완전 기록일의 recorded_total은 최소 기록 섭취량으로만 취급하고, 누락 끼니 보정치는 estimated_complete_total로 분리합니다.'
        : '식단 원본 기록이 없으므로 칼로리 섭취량과 에너지 균형을 평가하지 않습니다.'
    }
  };
}

function buildRecoveryStatistics_(recoveryMetrics,heartRateSamples,sleepRecords,periodTo) {
  recoveryMetrics=recoveryMetrics||{};
  heartRateSamples=(heartRateSamples||[]).slice().sort((a,b)=>a.t-b.t);
  sleepRecords=(sleepRecords||[]).slice().sort((a,b)=>a.t-b.t);
  const end=startOfDay_(periodTo).getTime()+86400000-1;
  const dayKey_=(t)=>Utilities.formatDate(new Date(t),TIME_ZONE,'yyyy-MM-dd');
  const avgFinite_=(arr)=>{
    const a=(arr||[]).filter(v=>v!==null&&v!==undefined&&isFinite(Number(v))).map(Number);
    return a.length?round_(a.reduce((s,v)=>s+v,0)/a.length,2):null;
  };
  const minFinite_=(arr)=>{
    const a=(arr||[]).filter(v=>v!==null&&v!==undefined&&isFinite(Number(v))).map(Number);
    return a.length?round_(Math.min.apply(null,a),2):null;
  };
  const maxFinite_=(arr)=>{
    const a=(arr||[]).filter(v=>v!==null&&v!==undefined&&isFinite(Number(v))).map(Number);
    return a.length?round_(Math.max.apply(null,a),2):null;
  };
  const dailyMetric_=(name)=>{
    const by={};
    (recoveryMetrics[name]||[]).forEach(p=>{
      const d=dayKey_(p.t);
      if(!by[d])by[d]=[];
      by[d].push(Number(p.qty));
    });
    return Object.keys(by).sort().map(d=>({date:d,avg:avgFinite_(by[d]),min:minFinite_(by[d]),max:maxFinite_(by[d]),samples:by[d].length}));
  };
  const inWindow_=(series,fromMs,toMs)=>series.filter(x=>{
    const t=parseDate_(x.date+'T12:00:00+09:00').getTime();
    return t>=fromMs&&t<=toMs;
  });
  const summarizeMetric_=(name,unitKey)=>{
    const series=dailyMetric_(name);
    const latest=series.length?series[series.length-1]:null;
    const d3=inWindow_(series,end-2*86400000,end);
    const d7=inWindow_(series,end-6*86400000,end);
    const prev7=inWindow_(series,end-13*86400000,end-7*86400000);
    const avg3=avgFinite_(d3.map(x=>x.avg));
    const avg7=avgFinite_(d7.map(x=>x.avg));
    const prev=avgFinite_(prev7.map(x=>x.avg));
    const out={
      latest_date:latest?latest.date:null,
      latest:latest?latest.avg:null,
      avg_3d:avg3,
      avg_7d:avg7,
      previous_7d_avg:prev,
      change_vs_7d_pct:latest&&avg7?round_((latest.avg-avg7)/Math.abs(avg7)*100,1):null,
      change_7d_vs_previous_7d_pct:avg7&&prev?round_((avg7-prev)/Math.abs(prev)*100,1):null,
      days_7d:d7.length,
      daily_series:series.slice(-28)
    };
    if(unitKey)out.unit=unitKey;
    return out;
  };

  const hrv=summarizeMetric_('heart_rate_variability','ms');
  const resting=summarizeMetric_('resting_heart_rate','bpm');
  const spo2=summarizeMetric_('blood_oxygen_saturation','%');
  const respiratory=summarizeMetric_('respiratory_rate','count/min');
  const walkingHr=summarizeMetric_('walking_heart_rate_average','bpm');
  const vo2=summarizeMetric_('vo2_max','mL/kg/min');

  const hrByDay={};
  heartRateSamples.forEach(p=>{
    const d=dayKey_(p.t);
    if(!hrByDay[d])hrByDay[d]=[];
    hrByDay[d].push(p);
  });
  const hrDaily=Object.keys(hrByDay).sort().map(d=>{
    const a=hrByDay[d];
    return {date:d,avg_bpm:avgFinite_(a.map(x=>x.avg)),min_bpm:minFinite_(a.map(x=>x.min)),max_bpm:maxFinite_(a.map(x=>x.max)),samples:a.length};
  });
  const hr7=inWindow_(hrDaily.map(x=>({date:x.date,avg:x.avg_bpm,min:x.min_bpm,max:x.max_bpm,samples:x.samples})),end-6*86400000,end);

  const sleepSeries=sleepRecords.map(s=>{
    const start=parseDate_(s.sleepStart);
    const finish=parseDate_(s.sleepEnd);
    const sleepHr=heartRateSamples.filter(h=>start.getTime()>0&&finish.getTime()>0&&h.t>=start.getTime()&&h.t<=finish.getTime());
    return {
      date:dayKey_(s.t),
      sleep_start:s.sleepStart,
      sleep_end:s.sleepEnd,
      total_sleep_hours:round_(s.totalSleep,2),
      deep_hours:s.deep!==null?round_(s.deep,2):null,
      core_hours:s.core!==null?round_(s.core,2):null,
      rem_hours:s.rem!==null?round_(s.rem,2):null,
      awake_hours:s.awake!==null?round_(s.awake,2):null,
      sleep_hr_avg_bpm:avgFinite_(sleepHr.map(x=>x.avg)),
      sleep_hr_min_bpm:minFinite_(sleepHr.map(x=>x.min)),
      sleep_hr_max_bpm:maxFinite_(sleepHr.map(x=>x.max)),
      sleep_hr_samples:sleepHr.length
    };
  });
  const recentSleep=sleepSeries.filter(x=>parseDate_(x.date+'T12:00:00+09:00').getTime()>=end-6*86400000);
  const lastSleep=sleepSeries.length?sleepSeries[sleepSeries.length-1]:null;

  return {
    hrv:{latest_ms:hrv.latest,latest_date:hrv.latest_date,avg_3d_ms:hrv.avg_3d,avg_7d_ms:hrv.avg_7d,previous_7d_avg_ms:hrv.previous_7d_avg,change_vs_7d_pct:hrv.change_vs_7d_pct,change_7d_vs_previous_7d_pct:hrv.change_7d_vs_previous_7d_pct,days_7d:hrv.days_7d,daily_series:hrv.daily_series},
    resting_heart_rate:{latest_bpm:resting.latest,latest_date:resting.latest_date,avg_3d_bpm:resting.avg_3d,avg_7d_bpm:resting.avg_7d,previous_7d_avg_bpm:resting.previous_7d_avg,change_vs_7d_pct:resting.change_vs_7d_pct,change_7d_vs_previous_7d_pct:resting.change_7d_vs_previous_7d_pct,days_7d:resting.days_7d,daily_series:resting.daily_series},
    sleep:{last_sleep:lastSleep,avg_7d_hours:avgFinite_(recentSleep.map(x=>x.total_sleep_hours)),days_7d:recentSleep.length,daily_series:sleepSeries.slice(-28)},
    heart_rate:{avg_7d_bpm:avgFinite_(hr7.map(x=>x.avg)),min_7d_bpm:minFinite_(hr7.map(x=>x.min)),max_7d_bpm:maxFinite_(hr7.map(x=>x.max)),daily_series:hrDaily.slice(-28)},
    blood_oxygen:{latest_pct:spo2.latest,avg_7d_pct:spo2.avg_7d,previous_7d_avg_pct:spo2.previous_7d_avg,days_7d:spo2.days_7d,daily_series:spo2.daily_series},
    respiratory_rate:{latest_count_min:respiratory.latest,avg_7d_count_min:respiratory.avg_7d,previous_7d_avg_count_min:respiratory.previous_7d_avg,days_7d:respiratory.days_7d,daily_series:respiratory.daily_series},
    walking_heart_rate:{latest_bpm:walkingHr.latest,avg_7d_bpm:walkingHr.avg_7d,previous_7d_avg_bpm:walkingHr.previous_7d_avg,daily_series:walkingHr.daily_series},
    vo2_max:{latest:vo2.latest,latest_date:vo2.latest_date,avg_7d:vo2.avg_7d,previous_7d_avg:vo2.previous_7d_avg,daily_series:vo2.daily_series},
    data_quality:{
      hrv_days_7d:hrv.days_7d,
      resting_hr_days_7d:resting.days_7d,
      sleep_days_7d:recentSleep.length,
      blood_oxygen_days_7d:spo2.days_7d,
      respiratory_rate_days_7d:respiratory.days_7d,
      note:'회복 평가는 HRV·안정시 심박·수면·수면중 심박을 우선하고, SpO2·호흡수는 보조 지표로 사용합니다. 수면/호흡 데이터가 희소하면 강한 결론을 피합니다.'
    }
  };
}

function buildNutritionStatistics_(nutritionFiles,periodFrom,periodTo) {
  const mainMeals=['breakfast','lunch','dinner'];
  const nutrientKeys=['calories_kcal','protein_g','carbs_g','fat_g'];
  const zeroNutrients_=()=>({calories_kcal:0,protein_g:0,carbs_g:0,fat_g:0});
  const addNutrients_=(a,b)=>{
    const out={};
    nutrientKeys.forEach(k=>out[k]=round_(Number(a&&a[k]||0)+Number(b&&b[k]||0),1));
    return out;
  };
  const avgNutrients_=(arr)=>{
    if(!arr.length)return null;
    const out={};
    nutrientKeys.forEach(k=>out[k]=round_(arr.reduce((s,x)=>s+Number(x&&x[k]||0),0)/arr.length,1));
    return out;
  };
  const median_=(arr)=>{
    const a=(arr||[]).filter(v=>isFinite(Number(v))).map(Number).sort((x,y)=>x-y);
    if(!a.length)return null;
    const m=Math.floor(a.length/2);
    return round_(a.length%2?a[m]:(a[m-1]+a[m])/2,1);
  };
  const mealTotal_=(meal)=>{
    if(meal&&meal.total&&isFinite(Number(meal.total.calories_kcal)))return nutrientKeys.reduce((o,k)=>(o[k]=round_(Number(meal.total[k]||0),1),o),{});
    const foods=(meal&&meal.foods)||(meal&&meal.items)||[];
    return foods.reduce((sum,f)=>addNutrients_(sum,nutrientKeys.reduce((o,k)=>(o[k]=Number(f&&f[k]||0),o),{})),zeroNutrients_());
  };
  const dailyTotal_=(record,meals)=>{
    if(record&&record.daily_total&&isFinite(Number(record.daily_total.calories_kcal)))return nutrientKeys.reduce((o,k)=>(o[k]=round_(Number(record.daily_total[k]||0),1),o),{});
    return meals.reduce((sum,m)=>addNutrients_(sum,m.total),zeroNutrients_());
  };

  const allRecords=[];
  (nutritionFiles||[]).forEach(f=>{
    const r=f&&f.data||{};
    const date=String(r.date||'').slice(0,10)||((f.name||'').match(/20\d{2}-\d{2}-\d{2}/)||[])[0];
    if(!date)return;
    const meals=(Array.isArray(r.meals)?r.meals:[]).map(m=>{
      const foods=(m.foods||m.items||[]).map(food=>({
        name:food.name||food.food_name||'',
        nutrition_source:food.nutrition_source||null,
        confidence:food.confidence||null
      })).filter(x=>x.name);
      return {time:m.time||null,meal_type:m.meal_type||'other',total:mealTotal_(m),foods:foods};
    });
    const present=[...new Set(meals.map(m=>m.meal_type).filter(x=>mainMeals.indexOf(x)>=0))];
    const missing=mainMeals.filter(x=>present.indexOf(x)<0);
    const coverage=r.record_coverage||{};
    const status=String(coverage.coverage_status||'').toLowerCase()==='complete'||missing.length===0?'complete':'incomplete';
    allRecords.push({
      date:date,
      recorded_total:dailyTotal_(r,meals),
      coverage_status:status,
      main_meals_present:present,
      main_meals_missing:Array.isArray(coverage.main_meals_missing)?coverage.main_meals_missing:missing,
      meals:meals,
      daily_total_scope:r.daily_total_scope||'recorded_items_only'
    });
  });
  allRecords.sort((a,b)=>a.date.localeCompare(b.date));

  const mealObservations=[];
  allRecords.forEach(r=>r.meals.forEach(m=>{
    if(mainMeals.indexOf(m.meal_type)<0)return;
    mealObservations.push({date:r.date,meal_type:m.meal_type,total:m.total});
  }));

  const imputeMeal_=(targetDate,mealType)=>{
    const target=parseDate_(targetDate+'T12:00:00+09:00').getTime();
    const windows=[3,7,14];
    for(let wi=0;wi<windows.length;wi++){
      const w=windows[wi];
      const c=mealObservations.filter(o=>o.meal_type===mealType&&Math.abs(parseDate_(o.date+'T12:00:00+09:00').getTime()-target)<=w*86400000);
      if(c.length){
        const total={};
        nutrientKeys.forEach(k=>total[k]=median_(c.map(x=>x.total[k]))||0);
        return {meal_type:mealType,estimated_total:total,method:'same_meal_nearby_median',window_days:w,source_count:c.length,source_dates:c.map(x=>x.date)};
      }
    }
    return null;
  };

  const periodStart=startOfDay_(periodFrom).getTime();
  const periodEnd=startOfDay_(periodTo).getTime()+86400000-1;
  const periodRecords=allRecords.filter(r=>{
    const t=parseDate_(r.date+'T12:00:00+09:00').getTime();
    return t>=periodStart&&t<=periodEnd;
  }).map(r=>{
    const out=JSON.parse(JSON.stringify(r));
    out.recorded_total_is_lower_bound=out.coverage_status!=='complete';
    out.imputed_meals=[];
    out.estimated_complete_total=out.coverage_status==='complete'?out.recorded_total:null;
    if(out.coverage_status!=='complete'){
      const missing=mainMeals.filter(x=>(out.main_meals_missing||[]).indexOf(x)>=0);
      let estimated=JSON.parse(JSON.stringify(out.recorded_total));
      let allEstimated=missing.length>0;
      missing.forEach(mt=>{
        const imp=imputeMeal_(out.date,mt);
        if(imp){out.imputed_meals.push(imp);estimated=addNutrients_(estimated,imp.estimated_total);}else{allEstimated=false;}
      });
      out.estimated_complete_total=allEstimated?estimated:null;
    }
    return out;
  });

  const complete=periodRecords.filter(r=>r.coverage_status==='complete');
  const incomplete=periodRecords.filter(r=>r.coverage_status!=='complete');
  const estimatedEligible=periodRecords.filter(r=>r.estimated_complete_total!==null);
  const recordedAvg=avgNutrients_(periodRecords.map(r=>r.recorded_total));
  const completeAvg=avgNutrients_(complete.map(r=>r.recorded_total));
  const estimatedAvg=avgNutrients_(estimatedEligible.map(r=>r.estimated_complete_total));
  const imputedDays=incomplete.filter(r=>r.estimated_complete_total!==null).length;

  return {
    days_recorded:periodRecords.length,
    complete_days:complete.length,
    incomplete_days:incomplete.length,
    imputed_complete_days:imputedDays,
    complete_day_average:completeAvg,
    recorded_all_days_average:recordedAvg,
    estimated_complete_day_average:estimatedAvg,
    daily_series:periodRecords,
    interpretation_rule:{
      priority:['complete recorded total','estimated complete total','incomplete recorded total as lower bound only'],
      incomplete_recorded_total_is_daily_intake:false,
      incomplete_recorded_total_meaning:'minimum_recorded_intake',
      imputation_is_source_data:false,
      imputation_method:'missing main meal -> same meal median within ±3 days, then ±7 days, then ±14 days',
      source_json_modified:false
    },
    data_quality:{
      complete_ratio:periodRecords.length?round_(complete.length/periodRecords.length,3):null,
      estimated_coverage_ratio:periodRecords.length?round_(estimatedEligible.length/periodRecords.length,3):null,
      note:'불완전 기록일의 recorded_total은 실제 하루 총섭취량으로 간주하지 않으며 complete-day 평균 계산에서 제외합니다. 추정치는 별도 estimated_complete_total로만 제공합니다.'
    }
  };
}

function dedupeCollectedFiles_(files) {
  const out=[];
  const seen={};
  (files||[]).forEach(x=>{
    // 같은 파일명·내부 최신시각·바이트 크기가 같은 재업로드본은 동일 raw로 간주합니다.
    const key=[x&&x.name||'',x&&x.timestamp||0,x&&x.size_bytes||0].join('|');
    if(seen[key])return;
    seen[key]=true;
    out.push(x);
  });
  return out;
}

function hasNumber_(value) {
  return value !== null && value !== undefined && value !== '' && isFinite(Number(value));
}

function periodDaysFromStats_(stats) {
  const coverage = stats && stats.coverage || {};
  const from = parseDate_(coverage.from);
  const to = parseDate_(coverage.to);

  if (from.getTime() > 0 && to.getTime() >= from.getTime()) {
    return Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86400000));
  }

  const recordedDays = Number(coverage.days_with_health_data);
  return isFinite(recordedDays) && recordedDays > 0 ? recordedDays : 1;
}

function normalizeRate_(value, periodDays, targetDays) {
  if (!hasNumber_(value) || !hasNumber_(periodDays) || Number(periodDays) <= 0) {
    return null;
  }
  return round_(Number(value) / Number(periodDays) * Number(targetDays || 1), 2);
}

function buildMetricComparison_(current, previous, lowerIsBetter, basis) {
  if (!hasNumber_(current) || !hasNumber_(previous)) {
    return null;
  }

  const currentNum = Number(current);
  const previousNum = Number(previous);
  const change = round_(currentNum - previousNum, 2);
  const changePct = previousNum !== 0
    ? round_((change / Math.abs(previousNum)) * 100, 1)
    : null;

  let direction = 'same';
  if (change > 0) direction = 'up';
  if (change < 0) direction = 'down';

  let improved = null;
  if (change !== 0 && lowerIsBetter !== null && lowerIsBetter !== undefined) {
    improved = lowerIsBetter ? change < 0 : change > 0;
  }

  return {
    current: round_(currentNum, 2),
    previous: round_(previousNum, 2),
    change: change,
    change_pct: changePct,
    direction: direction,
    improved: improved,
    basis: basis || 'direct'
  };
}

function buildActivityComparison_(currentStats, previousAnalysis) {
  const previousStats = previousAnalysis && previousAnalysis.statistics;
  if (!previousStats) return null;

  const currentActivity = currentStats.activity || {};
  const previousActivity = previousStats.activity || {};
  const currentFitness = currentStats.fitness || {};
  const previousFitness = previousStats.fitness || {};
  const currentCardio = currentActivity.cardio_summary || {};
  const previousCardio = previousActivity.cardio_summary || {};

  const currentDays = periodDaysFromStats_(currentStats);
  const previousDays = periodDaysFromStats_(previousStats);

  const currentDistanceDaily = normalizeRate_(
    currentCardio.distance_km ?? currentActivity.distance_total_km,
    currentDays,
    1
  );
  const previousDistanceDaily = normalizeRate_(
    previousCardio.distance_km ?? previousActivity.distance_total_km,
    previousDays,
    1
  );

  const currentSessionsWeekly = normalizeRate_(
    currentCardio.session_count ?? currentFitness.session_count,
    currentDays,
    7
  );
  const previousSessionsWeekly = normalizeRate_(
    previousCardio.session_count ?? previousFitness.session_count,
    previousDays,
    7
  );

  const currentMinutesWeekly = normalizeRate_(
    currentCardio.total_minutes ?? currentFitness.total_minutes,
    currentDays,
    7
  );
  const previousMinutesWeekly = normalizeRate_(
    previousCardio.total_minutes ?? previousFitness.total_minutes,
    previousDays,
    7
  );

  const currentKcalDaily = normalizeRate_(
    currentCardio.active_kcal ?? currentActivity.active_energy_total_kcal,
    currentDays,
    1
  );
  const previousKcalDaily = normalizeRate_(
    previousCardio.active_kcal ?? previousActivity.active_energy_total_kcal,
    previousDays,
    1
  );

  return {
    compared_to_analysis_id: previousAnalysis.analysis_id || null,
    compared_to_created_at: previousAnalysis.created_at || null,
    current_period_days: currentDays,
    previous_period_days: previousDays,
    steps_daily_average: buildMetricComparison_(
      currentActivity.steps_daily_average,
      previousActivity.steps_daily_average,
      false,
      'daily_average'
    ),
    distance_km: buildMetricComparison_(
      currentDistanceDaily,
      previousDistanceDaily,
      false,
      'daily_average'
    ),
    cardio_session_count: buildMetricComparison_(
      currentSessionsWeekly,
      previousSessionsWeekly,
      false,
      'weekly_equivalent'
    ),
    cardio_minutes: buildMetricComparison_(
      currentMinutesWeekly,
      previousMinutesWeekly,
      false,
      'weekly_equivalent'
    ),
    average_pace_min_per_km: buildMetricComparison_(
      currentCardio.avg_pace_min_per_km,
      previousCardio.avg_pace_min_per_km,
      true,
      'direct_average'
    ),
    average_heart_rate: buildMetricComparison_(
      currentCardio.avg_hr,
      previousCardio.avg_hr,
      null,
      'direct_average'
    ),
    active_kcal: buildMetricComparison_(
      currentKcalDaily,
      previousKcalDaily,
      false,
      'daily_average'
    )
  };
}

function parseDate_(v){if(v instanceof Date)return v;let s=String(v||'');if(!s)return new Date(0);s=s.replace(/ (\+\d{4})$/,' $1').replace(/ ([+-]\d{2})(\d{2})$/,' $1:$2');const d=new Date(s);return isNaN(d.getTime())?new Date(0):d;}

function normalizeAnalysisFrom_(value, fallback, now){const raw=String(value||'').trim();const parsed=raw?parseDate_(raw+(raw.length===10?'T00:00:00+09:00':'')):parseDate_(fallback);let d=startOfDay_(parsed.getTime()>0?parsed:fallback);const today=startOfDay_(now);if(d>today)d=today;return d;}

function formatIso_(d){return Utilities.formatDate(parseDate_(d),TIME_ZONE,"yyyy-MM-dd'T'HH:mm:ssXXX");}

function startOfDay_(d){const x=new Date(parseDate_(d).getTime());x.setHours(0,0,0,0);return x;}

function addDays_(d,n){const x=new Date(parseDate_(d).getTime());x.setDate(x.getDate()+n);return x;}

function sum_(a){return (a||[]).reduce((s,v)=>s+(isFinite(Number(v))?Number(v):0),0);}

function avg_(a){const b=(a||[]).filter(v=>isFinite(Number(v))).map(Number);return b.length?sum_(b)/b.length:null;}

function round_(v,n){if(v===null||v===undefined||!isFinite(Number(v)))return null;const p=Math.pow(10,n||0);return Math.round(Number(v)*p)/p;}

function num_(v){return isFinite(Number(v))?round_(Number(v),1):null;}
