import { findPath, clearSegment } from './navigation.js';

const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
export function tourGeometry(ids,data){
  const paths=[],failed=[],points=[];
  let lengthPx=0;
  for(let i=1;i<ids.length;i++){
    const a=data.markers.find(m=>m.id===ids[i-1]),b=data.markers.find(m=>m.id===ids[i]);
    const path=a&&b?findPath(a,b,data):null;
    if(!path){failed.push([ids[i-1],ids[i]]);continue;}
    paths.push(path);
    for(let j=1;j<path.length;j++)lengthPx+=distance(path[j-1],path[j]);
    // Separate paths are retained; never join across a failed segment.
    if(!failed.length)points.push(...path.slice(points.length?1:0));
  }
  return {paths,failed,points,lengthPx};
}

export function samplePaths(paths,spacingPx){
  if(!(spacingPx>0))throw Error('采样间隔必须为正数');
  const samples=[];
  for(const path of paths){
    if(!path.length)continue;
    samples.push({x:path[0].x,y:path[0].y});
    for(let i=1;i<path.length;i++){
      const a=path[i-1],b=path[i],n=Math.max(1,Math.ceil(distance(a,b)/spacingPx));
      for(let j=1;j<=n;j++)samples.push({x:a.x+(b.x-a.x)*j/n,y:a.y+(b.y-a.y)*j/n});
    }
  }
  return samples;
}

// A coverage hypothesis only: range + clear plan segment, not camera FOV or success probability.
export function coveredBy(sample,marker,radiusPx,data){
  return distance(sample,marker)<=radiusPx+1e-7&&clearSegment(sample,marker,data);
}

export function placementStudy(geometry,data,{slantRangeM=2,cameraHeightM=1.2,budget=150}={}){
  const scale=data.scale?.metersPerPixel;
  if(!(scale>0))return {error:'请先输入比例才能计算米制覆盖；原图比例也需现场复核。'};
  if(![slantRangeM,cameraHeightM,budget].every(Number.isFinite)||slantRangeM<=0||cameraHeightM<0||slantRangeM<=cameraHeightM||budget<0||budget>300||!Number.isInteger(budget))return {error:'斜距须大于相机高度；补码上限须为 0–300 的整数。'};
  if(geometry.failed.length)return {error:'路线存在断路，不为不完整路线生成覆盖／触觉建议。'};
  if(!geometry.paths.length)return {error:'路线为空。'};
  const radiusM=Math.sqrt(slantRangeM**2-cameraHeightM**2),radiusPx=radiusM/scale;
  const samples=samplePaths(geometry.paths,Math.min(1,radiusM/2)/scale);
  const ids=new Set(data.tour),critical=data.markers.filter(m=>ids.has(m.id));
  const sparseCovered=samples.map(p=>critical.some(m=>coveredBy(p,m,radiusPx,data)));
  const covered=[...sparseCovered],candidates=samplePaths(geometry.paths,Math.min(1,radiusM)/scale);
  const gains=candidates.map(c=>samples.flatMap((p,i)=>!covered[i]&&coveredBy(p,c,radiusPx,data)?[i]:[]));
  const extra=[];
  // Unit-cost greedy set cover on sampled visible route points, subject to a hard budget.
  while(extra.length<budget){
    let best=-1,count=0;
    gains.forEach((set,i)=>{const n=set.reduce((sum,j)=>sum+!covered[j],0);if(n>count){count=n;best=i;}});
    if(best<0)break;
    extra.push({...candidates[best],proposal:`P${extra.length+1}`,registered:false});
    gains[best].forEach(i=>{covered[i]=true;});gains[best]=[];
  }
  const tactile=[];
  for(const path of geometry.paths){
    for(let i=1;i<path.length-1;i++){
      const a=path[i-1],b=path[i],c=path[i+1];
      const turn=Math.acos(Math.max(-1,Math.min(1,((b.x-a.x)*(c.x-b.x)+(b.y-a.y)*(c.y-b.y))/(distance(a,b)*distance(b,c)))))*180/Math.PI;
      if(turn>=35&&!tactile.some(p=>distance(p,b)*scale<1))tactile.push({...b,kind:'decision',reason:`路径转向约 ${turn.toFixed(0)}°；现场评估决策／提示位置`});
    }
  }
  for(const m of critical){
    const i=geometry.points.findIndex(p=>distance(p,m)<1e-6);
    const a=geometry.points[i-1],b=geometry.points[i+1];
    let turn=0;
    if(a&&b)turn=Math.acos(Math.max(-1,Math.min(1,((m.x-a.x)*(b.x-m.x)+(m.y-a.y)*(b.y-m.y))/(distance(a,m)*distance(m,b)))))*180/Math.PI;
    if(!tactile.some(p=>distance(p,m)*scale<1))tactile.push({x:m.x,y:m.y,kind:turn>=35?'decision':'stop',reason:`${m.name}：${turn>=35?'转向决策':'起终点／功能停靠'}，不是自动确定铺装类型`});
  }
  const stats=flags=>({covered:flags.filter(Boolean).length,total:flags.length,ratio:flags.filter(Boolean).length/flags.length});
  return {algorithm:'A* + line-of-sight simplification; sampled unit-cost greedy set cover',
    scaleSource:data.scale.source,scaleVerified:data.scale.verified===true,lengthM:geometry.lengthPx*scale,
    slantRangeM,cameraHeightM,radiusM,sampleSpacingM:Math.min(1,radiusM/2),
    critical,extra,tactile,samples:samples.map((p,i)=>({...p,sparse:sparseCovered[i],dense:covered[i]})),
    sparse:stats(sparseCovered),dense:stats(covered),
    caution:'比例尺估算；覆盖仅为距离和图上无遮挡的必要条件，未建模视场、倾角、光照、遮挡、识别成功率。不证明连续定位。P 点尚无 ID、未登记扫码。触觉线为建议走廊中心线，非铺装施工线。'};
}
