import { classify, nearby, horizontalRadius, markerToMap, poseToMap } from './position.js';
import { LivePosition } from './live.js';
import { relativeCue, canStand, movePerson, findPath, advancePath, parseTour } from './navigation.js';
import { SpatialCue } from './spatial-audio.js';
import { tourGeometry, placementStudy } from './planning.js';

const $ = id => document.getElementById(id);
const legacy=new URLSearchParams(location.search).get('plan')==='legacy';
const data = await fetch(legacy?'floorplan.json':'architecture/floorplan.json').then(r => { if (!r.ok) throw Error('楼层数据无法读取'); return r.json(); });
const img = new Image(); img.src = data.image.file; img.onload = () => draw();
const canvas = $('scene'), ctx = canvas.getContext('2d');
let view = '2d', yaw = -0.22, elevation = 0.85, zoom = 1, selected = data.markers[0];
let panX=0,panY=0,tool='person',frame=0,baseKey='',tourPaths=[],tourCursor=1;
data.tour=data.tour||[0,2,1,3];
const base=document.createElement('canvas');
const center=data.viewCenter||[853,435],bounds=data.viewBounds||[40,10,1665,815],wallTop=data.renderWallPx??55,blockTop=data.renderBlockPx??12;
const demoStart=data.demoStart||{x:848,y:745},defaultTarget=data.defaultTarget??2,arrival=data.arrivalPx??12;
let study=null,geometry=null;
let point = {...demoStart}, ring = null, source = '模拟观测 · 非真实扫描', records = [], selection = '', reference = [], projectedMarkers = [];
let projection, W = 1, H = 1, drag = null;
let heading=0,guideTarget=data.markers.find(m=>m.id===defaultTarget),guidePath=null,routeKey='',cue=null;
const sound=new SpatialCue(message=>{$('sound-status').textContent=message;});
const mpp = () => data.scale?.metersPerPixel || null;
const status = message => { $('observation-status').textContent = message; };
let liveCalibration=null;
const scanner=new LivePosition({
  video:$('camera'),markers:data.markers,
  onStatus:message=>{$('live-status').textContent=message;},
  onInvalid:message=>{if($('mode').value==='live'){point=null;ring=null;source='实时扫描 · 当前无有效位置';$('live-status').textContent=message;result();}},
  onPose:(marker,observation)=>{
    if($('mode').value!=='live')return;
    try {
      selectMarker(marker);point=poseToMap(marker,observation,mpp());ring=null;status('');
      source=`实时扫描实验估计 / ID ${marker.id} / ${new Date().toLocaleTimeString('zh-CN')}`;result();return true;
    }catch(e){point=null;source='实时扫描 · 观测不能定位';status(e.message);result();return false;}
  }
});
document.addEventListener('visibilitychange',()=>{if(document.hidden){sound.stop();scanner.stop();}});
window.addEventListener('pagehide',()=>{sound.stop();scanner.stop();});
window.addEventListener('blur',()=>sound.stop());

function polygon(points, fill, stroke) {
  ctx.beginPath(); points.forEach((p,i) => { const q=projection(...p); i ? ctx.lineTo(...q) : ctx.moveTo(...q); }); ctx.closePath();
  if (fill) { ctx.fillStyle=fill; ctx.fill(); } if (stroke) { ctx.strokeStyle=stroke; ctx.lineWidth=1; ctx.stroke(); }
}
function line(a,b,color,width=1) { ctx.beginPath(); ctx.moveTo(...projection(...a)); ctx.lineTo(...projection(...b)); ctx.strokeStyle=color; ctx.lineWidth=width; ctx.stroke(); }
function dot(p, color, radius=7) { const q=projection(p.x,p.y,2); ctx.beginPath();ctx.arc(...q,radius,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();ctx.lineWidth=2;ctx.strokeStyle='#fff';ctx.stroke();return q; }
function label(x,y,z,text,color='#4b6269',size=11) {const p=projection(x,y,z);ctx.font=`600 ${size}px "Microsoft YaHei",sans-serif`;ctx.textAlign='center';ctx.fillStyle=color;ctx.fillText(text,p[0],p[1]);}

function draw() {if(!frame)frame=requestAnimationFrame(()=>{frame=0;drawNow();});}
function drawNow() {
  if (!W || !H) return;
  ctx.clearRect(0,0,W,H); projectedMarkers=[];
  let raw;
  if(view==='2d') raw=(x,y,z=0)=>[x-center[0],y-center[1]-z*.15];
  else raw=(x,y,z=0)=>{const a=x-center[0],b=center[1]-y,u=a*Math.cos(yaw)-b*Math.sin(yaw),v=a*Math.sin(yaw)+b*Math.cos(yaw);return[u,-v*Math.sin(elevation)-z*Math.cos(elevation)];};
  const [x0,y0,x1,y1]=bounds;
  const corners=[[x0,y0,0],[x1,y0,0],[x0,y1,0],[x1,y1,0],[x0,y0,wallTop+10],[x1,y1,wallTop+10]].map(p=>raw(...p));
  const xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const scale=Math.min((W-55)/(maxX-minX),(H-65)/(maxY-minY))*zoom;
  const cx=(minX+maxX)/2,cy=(minY+maxY)/2;
  projection=(x,y,z=0)=>{const p=raw(x,y,z);return[W/2+panX+(p[0]-cx)*scale,H/2+panY+(p[1]-cy)*scale];};
  projection.inverse=(x,y)=>{
    const u=(x-W/2-panX)/scale+cx,v=(y-H/2-panY)/scale+cy;
    if(view==='2d')return{x:u+center[0],y:v+center[1]};
    const b=-v/Math.sin(elevation);return{x:center[0]+u*Math.cos(yaw)+b*Math.sin(yaw),y:center[1]+u*Math.sin(yaw)-b*Math.cos(yaw)};
  };
  const key=[view,W,H,canvas.width,canvas.height,yaw,elevation,zoom,panX,panY,img.naturalWidth].join('/');
  if(key===baseKey)ctx.drawImage(base,0,0,W,H);
  else {
  if(view==='2d' && img.complete && img.naturalWidth) {
    const a=projection(0,0),b=projection(data.image.width,data.image.height);ctx.globalAlpha=.65;ctx.drawImage(img,a[0],a[1],b[0]-a[0],b[1]-a[1]);ctx.globalAlpha=1;
  } else {
    data.footprints.forEach(p=>polygon(p.map(([x,y])=>[x,y,-8]),'#ccd8d4','#c3d0cb'));
    data.zones.filter(z=>z.kind==='room').forEach(z=>polygon(z.polygon.map(([x,y])=>[x,y,0]),z.name==='梦想花园'?'#b6c9b0':z.name==='演播厅'?'#cbd4da':'#e1e7df','#c4d0c7'));
    const shapes=[];
    const box=(poly,height,color)=>{
      poly.forEach(([x,y],i)=>{const [a,b]=poly[(i+1)%poly.length];shapes.push({p:[[x,y,0],[a,b,0],[a,b,height],[x,y,height]],color,depth:((x+a)/2-853)*Math.sin(yaw)+(435-(y+b)/2)*Math.cos(yaw)});});
      shapes.push({p:poly.map(([x,y])=>[x,y,height]),color:color==='#91a3a1'?'#b7c5c0':'#f7f7ee',depth:poly.reduce((s,[x,y])=>s+(x-853)*Math.sin(yaw)+(435-y)*Math.cos(yaw),0)/poly.length-.1});
    };
    data.blocks.forEach(b=>box(b.polygon,blockTop,'#91a3a1'));
    data.walls.forEach(([x,y,a,b])=>{const dx=a-x,dy=b-y,n=Math.hypot(dx,dy),px=-dy/n*(data.wallWidthPx??4),py=dx/n*(data.wallWidthPx??4);box([[x+px,y+py],[a+px,b+py],[a-px,b-py],[x-px,y-py]],wallTop,'#b0bfb6');});
    shapes.sort((a,b)=>b.depth-a.depth).forEach(s=>polygon(s.p,s.color,'#94a79d66'));
    data.zones.filter(z=>z.kind==='room').forEach(z=>{const x=z.polygon.reduce((s,p)=>s+p[0],0)/z.polygon.length,y=z.polygon.reduce((s,p)=>s+p[1],0)/z.polygon.length;label(x,y,wallTop+5,z.name,'#3e575b',Math.max(8,Math.min(12,W/85)));});
    label(demoStart.x,demoStart.y+25,0,legacy?'主入口 ↓':'起点：入口位置待核查','#496469',12);
  }
  base.width=canvas.width;base.height=canvas.height;base.getContext('2d').drawImage(canvas,0,0);baseKey=key;
  }
  ctx.setLineDash([6,5]);
  tourPaths.forEach(path=>{for(let i=1;i<path.length;i++)line([path[i-1].x,path[i-1].y,1],[path[i].x,path[i].y,1],'#735fa6',2);});
  ctx.setLineDash([]);
  drawStudy();
  if(reference.length) {
    reference.forEach(p=>dot(p,'#8559a8',4));
    if(reference.length===2) line([reference[0].x,reference[0].y,1],[reference[1].x,reference[1].y,1],'#8559a8',2);
  }
  if(ring) {
    const p=[];for(let i=0;i<=120;i++){const a=i/120*Math.PI*2;p.push([ring.x+Math.cos(a)*ring.radius,ring.y+Math.sin(a)*ring.radius,1]);}
    polygon(p,'#da665019','#da6650');
  }
  if(point && $('mode').value!=='demo') line([selected.x,selected.y,2],[point.x,point.y,2],'#dd6d55',2);
  if(guidePath&&$('mode').value==='demo'){
    for(let i=1;i<guidePath.length;i++)line([guidePath[i-1].x,guidePath[i-1].y,3],[guidePath[i].x,guidePath[i].y,3],'#087ea4',3);
    if(guidePath.length>2)dot(guidePath[1],'#087ea4',5);
  }
  data.markers.forEach(m=>{
    const color=$('mode').value==='demo'&&m.id===guideTarget.id?'#a647a2':m.id===selected.id?'#176a94':'#dfa920',q=dot(m,color,m.id===selected.id?9:7);projectedMarkers.push({m,q});
    const a=m.yawDeg*Math.PI/180;line([m.x,m.y,2],[m.x-Math.sin(a)*27,m.y-Math.cos(a)*27,2],color,2);
    label(m.x,m.y-20,4,`ID ${m.id}`,'#1d4c60',11);
  });
  if(point) {
    dot(point,'#de604e',7);
    if($('mode').value==='demo'){
      const h=heading*Math.PI/180,tip=[point.x+Math.sin(h)*30,point.y-Math.cos(h)*30,5],left=[point.x-Math.cos(h)*8,point.y-Math.sin(h)*8,5],right=[point.x+Math.cos(h)*8,point.y+Math.sin(h)*8,5];polygon([tip,left,right],'#c83d30','#fff');
    }
    label(point.x,point.y+30,4,source.startsWith('模拟')?'模拟人物':source.startsWith('实时')?'扫描手机':'历史／手动手机','#a54436',11);
  }
}

function refreshStudy(){
  if(legacy||!geometry)return;
  study=placementStudy(geometry,data,{slantRangeM:Number($('scan-range').value),cameraHeightM:Number($('scan-height').value),budget:Number($('extra-budget').value)});
  updateStudyText();
}
function updateStudyText(){
  if(legacy||!study)return;
  if(study.error){$('placement-status').textContent=study.error;return;}
  const dense=$('placement-mode').value==='greedy',coverage=dense?study.dense:study.sparse;
  $('placement-status').textContent=`图纸估算路线长 ${study.lengthM.toFixed(1)} m；稀疏 ${study.critical.length} 个 ID 点，补码候选 ${dense?study.extra.length:0} 个。\n斜距 ${study.slantRangeM} m、高度 ${study.cameraHeightM} m → 水平半径 ${study.radiusM.toFixed(2)} m。\n${coverage.covered}/${coverage.total} 个采样点满足图上距离与无遮挡条件（${(coverage.ratio*100).toFixed(1)}%）；红点是条件不满足处。即使达到 100%，也不代表真实连续识别。\n触觉建议 ${study.tactile.length} 处；房内、楼梯、中央高差不明区不进入。`;
}
function drawStudy(){
  if(legacy||!study||study.error)return;
  if($('show-tactile').checked){
    ctx.setLineDash([3,6]);
    tourPaths.forEach(path=>{for(let i=1;i<path.length;i++)line([path[i-1].x,path[i-1].y,1],[path[i].x,path[i].y,1],'#37894e',7);});ctx.setLineDash([]);
    study.tactile.forEach(p=>{const q=projection(p.x,p.y,2);ctx.strokeStyle='#bf6509';ctx.lineWidth=2;ctx.strokeRect(q[0]-11,q[1]-11,22,22);});
    (data.hazardChecks||[]).forEach(p=>label(p.x,p.y,2,'⚠ 核查高差','#aa392c',10));
  }
  const dense=$('placement-mode').value==='greedy';
  if(dense)study.extra.forEach(p=>{const q=projection(p.x,p.y,2);ctx.strokeStyle='#047e84';ctx.lineWidth=1.5;ctx.strokeRect(q[0]-3,q[1]-3,6,6);if(zoom>=2)label(p.x,p.y-12,2,p.proposal,'#047e84',10);});
  if($('show-coverage').checked)study.samples.filter(p=>!(dense?p.dense:p.sparse)).forEach(p=>dot(p,'#d74237',2));
}

function result() {
  updateGuidance();
  $('source').textContent=source;
  document.querySelector('.readout').classList.remove('error');
  if (!point) {
    $('region').textContent=ring?'只能确定可能范围':'当前无有效位置';
    $('result').textContent=ring?'圆周是已知相机高度下的水平距离约束；仍存在多个可能位置，不自动吸附到最近通道。':'需要新的观测或选择模拟位置。';
    $('nearby').replaceChildren();draw();return;
  }
  const region=classify(point,data);$('region').textContent=region.name;
  if(['blocked','outside','unknown'].includes(region.kind))document.querySelector('.readout').classList.add('error');
  const d=Math.hypot(point.x-selected.x,point.y-selected.y),a=(Math.atan2(selected.y-point.y,point.x-selected.x)*180/Math.PI-selected.yawDeg+360)%360;
  $('result').textContent=`图像坐标 (${point.x.toFixed(1)}, ${point.y.toFixed(1)}) · 相对 ID ${selected.id} 水平直线距离 ${mpp()?(d*mpp()).toFixed(2)+' m':d.toFixed(0)+' 图像 px（未定标）'} · 码中心看向手机方位 ${a.toFixed(0)}°`+(point.heightM!=null?` · 相机高度 ${point.heightM.toFixed(2)} m`:'');
  $('nearby').replaceChildren();
  nearby(point,data.markers,mpp()).slice(0,3).forEach(m=>{const span=document.createElement('span');span.className='near';span.textContent=`ID ${m.id} ${m.name} / ${m.distance.toFixed(mpp()?2:0)} ${mpp()?'m':'px'}`;$('nearby').append(span);});
  draw();
}
function updateScale() {$('scale-status').textContent=data.scale?.kind==='drawing'?`图纸比例估算：0–10 m = 75 px，1 px ≈ ${(mpp()*1000).toFixed(1)} mm；未现场核验。入口与通行条件是假设，旧码位不能直接沿用。`:mpp()?`已输入参考比例：1 图像 px = ${(mpp()*1000).toFixed(2)} mm。来自单段人工定标，未核验透视与测量误差。`:'示意坐标，尚未定标。可模拟布点；米制真实观测须先输入现场参考长度。';}
function invalidate() {ring=null;if($('mode').value!=='demo'){point=null;source='设置已改变 · 需要重新换算';}result();}
function selectMarker(m) {
  selected=m;$('marker').value=String(m.id);$('size').value=m.sizeMm;$('yaw').value=m.yawDeg;$('mx').value=m.x;$('my').value=m.y;
  $('reason').textContent=m.reason;$('marker-status').textContent=m.stage+'；'+classify(m,data).name;
  invalidate();
}
data.markers.forEach(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=`ID ${m.id} · ${m.name}`;$('marker').append(o);});
$('marker').onchange=()=>selectMarker(data.markers.find(m=>m.id===Number($('marker').value)));
for(const id of ['size','yaw','mx','my']) $(id).onchange=()=>{
  if($('mode').value==='live')scanner.stop();
  const size=Number($('size').value),yawDeg=Number($('yaw').value),x=Number($('mx').value),y=Number($('my').value);
  if(![size,yawDeg,x,y].every(Number.isFinite)||size<10||size>2000||x<0||x>data.image.width||y<0||y>data.image.height){status('点位设置无效');return;}
  Object.assign(selected,{sizeMm:size,yawDeg,x,y});routeKey='';routeGoal='';rebuildTour();selectMarker(selected);status('候选位置已修改；导出 JSON 后保存。');
};
function setView(v) {view=v;zoom=1;panX=panY=0;document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===v)));$('view-label').textContent=v==='3d'?'拖动旋转 · 滚轮缩放':'拖彩色点调整码位 · 拖空白平移 · 点击空白放人物';draw();}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{selection='';setView(b.dataset.view);});
$('reset-view').onclick=()=>{yaw=-.22;elevation=.85;zoom=1;panX=panY=0;draw();};
document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>{selection='';tool=b.dataset.tool;document.querySelectorAll('[data-tool]').forEach(a=>a.setAttribute('aria-pressed',String(a===b)));if(view!=='2d')setView('2d');$('view-label').textContent=tool==='marker'?'拖动码位；空白拖动平移。松手提交，Esc 取消':tool==='browse'?'只浏览：拖动平移，滚轮缩放':'拖彩色点调整码位；点击空白放人物，拖空白平移';});
$('focus-marker').onclick=()=>{if(view!=='2d')setView('2d');zoom=3;panX=panY=0;drawNow();const q=projection(selected.x,selected.y);panX=W/2-q[0];panY=H/2-q[1];draw();};
$('move').onclick=()=>{setView('2d');selection='move';$('view-label').textContent='点击通道内的位置移动所选标记';};
$('pick-scale').onclick=()=>{setView('2d');selection='scale';reference=[];$('reference').textContent='请依次点选参考线的两个端点';$('view-label').textContent='定标：依次点击同一条实测参考线的两端';draw();};
$('apply-scale').onclick=()=>{
  const length=Number($('length').value),pixels=reference.length===2?Math.hypot(reference[0].x-reference[1].x,reference[0].y-reference[1].y):0;
  if(!Number.isFinite(length)||length<=0||pixels<10){status('请选两个相距至少 10 px 的端点，并输入正数实测长度');return;}
  if($('mode').value==='live')scanner.stop();
  data.scale={metersPerPixel:length/pixels,reference:structuredClone(reference),lengthM:length,source:'人工输入，尚未独立核验'};updateScale();refreshStudy();invalidate();status('参考比例已应用，请用第二段独立长度复核。');
};
$('clear-scale').onclick=()=>{scanner.stop();data.scale=null;updateScale();refreshStudy();invalidate();status('已清除比例');};
$('mode').onchange=()=>{
  sound.stop();
  scanner.stop();point=null;ring=null;selection='';const mode=$('mode').value;$('manual').hidden=!['range','bearing'].includes(mode);$('bearing-field').hidden=mode!=='bearing';$('pose-input').hidden=mode!=='pose';$('live-input').hidden=mode!=='live';
  source=mode==='demo'?'模拟观测 · 非真实扫描':mode==='pose'?'导入历史观测 · 非实时追踪':mode==='live'?'实时扫描 · 尚未启动':'手动观测 · 未核实精度';status('');if(mode==='demo'){point={...demoStart};setView('2d');}result();
};
$('live-calibration').onchange=async e=>{
  scanner.stop();liveCalibration=null;
  try{const file=e.target.files[0];if(!file)return;const c=JSON.parse(await file.text());window.LabPose.validate(c,c.width,c.height);liveCalibration=c;$('live-cal-status').textContent=`${c.id} / ${c.width}×${c.height} / 标定 RMS ${c.rmsPx.toFixed(2)} px`;}catch(e){$('live-cal-status').textContent='标定无效：'+e.message;}
};
$('live-start').onclick=()=>{if(!mpp()){status('请先用实测长度定标，再开始实时定位');return;}if(!liveCalibration){status('请先导入本机相机标定 JSON');return;}status('');scanner.start(liveCalibration);};
$('live-stop').onclick=()=>scanner.stop();
for(const id of ['distance','height','bearing'])$(id).oninput=()=>invalidate();
$('calculate').onclick=()=>{
  point=null;ring=null;
  try {
    if(!mpp())throw Error('必须先用现场长度定标，不能将米直接当作图像像素');
    const distance=Number($('distance').value),height=Number($('height').value),radius=horizontalRadius(distance,height);
    if($('mode').value==='range')ring={x:selected.x,y:selected.y,radius:radius/mpp()};
    else{const angle=Number($('bearing').value);if(!Number.isFinite(angle)||!$('bearing').value.trim())throw Error('请输入码坐标系方位');const a=angle*Math.PI/180;point=markerToMap(selected,[radius*Math.cos(a),radius*Math.sin(a),height],mpp());}
    source='手动输入观测 · 非实时追踪';status('此处没有不确定度模型；圆周和点均为输入值的几何结果。');
  } catch(e) {status(e.message);} result();
};
$('observations').onchange=async e=>{
  records=[];$('record').replaceChildren();point=null;ring=null;
  try {
    const file=e.target.files[0];if(!file)return;
    const doc=JSON.parse(await file.text());records=Array.isArray(doc.records)?doc.records:[doc];
    if(!records.length||records.length>10000)throw Error('观测列表为空或超过 10000 条');
    records.forEach((r,i)=>{if(!r||typeof r!=='object')throw Error('存在非对象观测');const o=document.createElement('option');o.value=i;o.textContent=`${i+1} / ID ${r.id} / ${r.recordedAt||r.time||'无时间'}`;$('record').append(o);});status(`已加载 ${records.length} 条，需选取观测并换算。`);
  } catch(e) {records=[];$('record').replaceChildren();status('导入失败：'+e.message);}result();
};
$('record').onchange=()=>{point=null;ring=null;result();};
$('locate').onclick=()=>{
  point=null;ring=null;
  try{
    if(!mpp())throw Error('请先定标，再导入米制观测');
    const observation=records[Number($('record').value)];if(!observation)throw Error('请先导入观测文件');
    const marker=data.markers.find(m=>m.id===observation.id);if(!marker)throw Error('该 ID 未登记在此模型');
    selectMarker(marker);point=poseToMap(marker,observation,mpp());
    source=`历史扫描 / ${observation.recordedAt||observation.time||'时间未知'}`;status('已换算历史相机位置；安装方向、比例和单平面双解仍需现场核对。');
  }catch(e){status('不能定位：'+e.message);}result();
};
$('demo-reset').onclick=()=>{heading=0;tourCursor=-1;$('heading').value=0;guideTarget=data.markers.find(m=>m.id===defaultTarget);$('guide-target').value=defaultTarget;$('mode').value='demo';$('mode').onchange();selectMarker(data.markers[0]);};
$('export').onclick=()=>{
  const out={...data,exportedAt:new Date().toISOString(),lastObservation:point?{source,point}:null,placementStudy:study};const blob=new Blob([JSON.stringify(out,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='college-1f-markers.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
};
function canvasPoint(e){const r=canvas.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};}
function markerAt(p){return projectedMarkers.reduce((best,q)=>{
  const distance=Math.hypot(q.q[0]-p.x,q.q[1]-p.y);
  return distance<24&&(!best||distance<best.distance)?{...q,distance}:best;
},null);}
function cancelDrag(){if(drag?.marker){Object.assign(drag.marker,drag.original);routeKey='';}drag=null;routeGoal='';result();}
canvas.onpointerdown=e=>{
  if(drag)return;
  drawNow();const p=canvasPoint(e),hit=markerAt(p);
  canvas.setPointerCapture(e.pointerId);
  drag={x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false};
  if(view==='2d'&&!selection&&tool!=='browse'&&hit){
    selectMarker(hit.m);drag.marker=hit.m;drag.original={x:hit.m.x,y:hit.m.y};
    drag.anchor=projection.inverse(p.x,p.y);sound.silence();canvas.style.cursor='grabbing';
    $('view-label').textContent=`正在调整 ID ${hit.m.id}；拖到通道内松手，Esc 取消`;
  }
};
canvas.onpointermove=e=>{
  if(!drag){const p=canvasPoint(e);canvas.style.cursor=view==='2d'&&tool!=='browse'&&markerAt(p)?'move':'grab';return;}
  if(Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)>4)drag.moved=true;
  if(!drag.moved)return;
  const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
  if(view==='3d'){yaw+=dx*.006;elevation=Math.max(.3,Math.min(1.4,elevation+dy*.005));}
  else if(drag.marker){const p=canvasPoint(e),q=projection.inverse(p.x,p.y);Object.assign(drag.marker,{x:drag.original.x+q.x-drag.anchor.x,y:drag.original.y+q.y-drag.anchor.y});}
  else{panX+=dx;panY+=dy;}
  drag.x=e.clientX;drag.y=e.clientY;draw();
};
canvas.onpointerup=e=>{
  if(!drag)return;
  const ended=drag;drag=null;
  if(ended.marker){
    canvas.style.cursor='move';
    if(!ended.moved){selectMarker(ended.marker);return;}
    if(!canStand(ended.marker,data)){Object.assign(ended.marker,ended.original);status('落点不是有净空的已划定通道，已恢复原码位');}
    else status('码位已更新；刷新前请导出 JSON 保存');
    routeKey='';routeGoal='';rebuildTour();selectMarker(ended.marker);return;
  }
  if(ended.moved)return;
  drawNow();const {x,y}=canvasPoint(e);
  if(view==='2d'&&selection){const p=projection.inverse(x,y);
    if(selection==='scale'){reference.push(p);if(reference.length===2){selection='';$('reference').textContent=`参考线 ${Math.hypot(reference[0].x-reference[1].x,reference[0].y-reference[1].y).toFixed(1)} 图像 px`;$('view-label').textContent='输入这段参考线的实测长度，再应用比例';}draw();}
    else{if(!canStand(p,data)){status('请选择有净空的已划定通道');return;}Object.assign(selected,p);selection='';routeKey='';routeGoal='';rebuildTour();selectMarker(selected);status('候选码位已移动，现场还需核查门扇和人流。');}return;
  }
  const hit=markerAt({x,y});if(hit){selectMarker(hit.m);return;}
  if($('mode').value==='demo'&&(view==='3d'||tool==='person')){point=projection.inverse(x,y);ring=null;source='模拟观测 · 非真实扫描';result();}
};
canvas.onpointercancel=cancelDrag;
canvas.addEventListener('lostpointercapture',()=>{if(drag)cancelDrag();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){cancelDrag();selection='';}});
canvas.addEventListener('wheel',e=>{
  e.preventDefault();if(drag)return;
  drawNow();const p=canvasPoint(e),anchor=projection.inverse(p.x,p.y);
  zoom=Math.max(.6,Math.min(8,zoom*(e.deltaY>0?.9:1.1)));
  drawNow();if(view==='2d'){const q=projection(anchor.x,anchor.y);panX+=p.x-q[0];panY+=p.y-q[1];}draw();
},{passive:false});
new ResizeObserver(()=>{
  const center=view==='2d'&&projection?projection.inverse(W/2,H/2):null;
  const rect=canvas.getBoundingClientRect();W=rect.width;H=rect.height;const dpr=window.devicePixelRatio||1;
  canvas.width=Math.round(W*dpr);canvas.height=Math.round(H*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);
  if(center){panX=panY=0;drawNow();const q=projection(center.x,center.y);panX=W/2-q[0];panY=H/2-q[1];}
  draw();
}).observe(canvas);

function updateGuidance(){
  cue=null;guidePath=null;
  const debug=$('guide-debug');
  if($('mode').value!=='demo'||!point){sound.update(null);debug.textContent='当前不是有效模拟位置，方向音静音。';return;}
  if(!canStand(point,data)){sound.update(null);debug.textContent='模拟人物不在可通行区，停止指引。请点击通道放置人物。';return;}
  const key=[point.x,point.y,guideTarget.id,guideTarget.x,guideTarget.y].join('/');
  if(key!==routeKey){routeKey=key;cachedPath=routeGoal===`${guideTarget.id}/${guideTarget.x}/${guideTarget.y}`?(advancePath(point,cachedPath,data)||findPath(point,guideTarget,data)):findPath(point,guideTarget,data);routeGoal=`${guideTarget.id}/${guideTarget.x}/${guideTarget.y}`;}
  guidePath=cachedPath;
  const distance=Math.hypot(point.x-guideTarget.x,point.y-guideTarget.y);
  if(distance<=arrival){sound.update(null);debug.textContent=`已到达 ID ${guideTarget.id} ${guideTarget.name}（模拟阈值 ${arrival} 图像 px），已静音。可选择下一目标点。`;return;}
  if(!guidePath){sound.update(null);debug.textContent=`无法找到通往 ID ${guideTarget.id} 的已划定安全通道，停止指引。`;return;}
  const waypoint=guidePath[1];cue=relativeCue(point,waypoint,heading);sound.update(cue);
  const side=Math.abs(cue.angleDeg)<5?'正前方':cue.angleDeg<0?'左侧':'右侧',back=cue.front<0?'（身后，请转身；低音提示）':'';
  const l=sound.swap?cue.right:cue.left,r=sound.swap?cue.left:cue.right;
  debug.textContent=`人物 (${point.x.toFixed(1)}, ${point.y.toFixed(1)})，朝向 ${heading.toFixed(0)}°\n目标 ID ${guideTarget.id} ${guideTarget.name}；${guidePath.length>2?'正在引导至绕行路径点':'直接指向目标'} (${waypoint.x.toFixed(1)}, ${waypoint.y.toFixed(1)})\n相对角 ${cue.angleDeg.toFixed(1)}°，${side}${back}\n左增益 ${l.toFixed(3)} / 右增益 ${r.toFixed(3)}；pan ${cue.pan.toFixed(3)}\n到目标直线距离 ${mpp()?(distance*mpp()).toFixed(2)+' m':distance.toFixed(1)+' px（未定标）'}；音量不随距离改变`;
}
let cachedPath=null,routeGoal='';
function rebuildTour(){
  tourPaths=[];const failed=[];
  geometry=tourGeometry(data.tour,data);tourPaths=geometry.paths;geometry.failed.forEach(([a,b])=>failed.push(`${a}→${b}`));
  refreshStudy();
  $('tour-status').textContent=failed.length?`断路：${failed.join('、')}；这些段不绘制，不提供穿墙指引。`:`参观顺序 ${data.tour.join(' → ')}；紫色虚线为整条路线，蓝色实线为当前人物指引。`;
  draw();
}
$('tour-order').value=data.tour.join(', ');
$('apply-tour').onclick=()=>{
  try{const ids=parseTour($('tour-order').value,data.markers);data.tour=ids;tourCursor=0;guideTarget=data.markers.find(m=>m.id===ids[0]);$('guide-target').value=guideTarget.id;sound.silence();rebuildTour();result();}
  catch(e){$('tour-status').textContent=e.message;}
};
data.markers.forEach(m=>{const option=document.createElement('option');option.value=m.id;option.textContent=`ID ${m.id} · ${m.name}`;$('guide-target').append(option);});
$('guide-target').value=guideTarget.id;
$('guide-target').onchange=()=>{tourCursor=-1;guideTarget=data.markers.find(m=>m.id===Number($('guide-target').value));sound.silence();result();};
$('next-target').onclick=()=>{
  const i=tourCursor>=0&&data.tour[tourCursor]===guideTarget.id?tourCursor:data.tour.indexOf(guideTarget.id);
  if(i===data.tour.length-1){sound.stop();status('模拟路线已到最后一站，可手动选择目标。');return;}
  tourCursor=i+1;guideTarget=data.markers.find(m=>m.id===data.tour[tourCursor]);$('guide-target').value=guideTarget.id;sound.silence();result();
};
$('heading').onchange=()=>{const n=Number($('heading').value);if(!Number.isFinite(n))return;heading=(n%360+360)%360;$('heading').value=heading;result();};
function act(action){
  if($('mode').value!=='demo'||!point){status('方向键行走只在模拟模式可用');return;}
  if(action==='left'||action==='right'){heading=(heading+(action==='left'?-15:15)+360)%360;$('heading').value=heading;}
  else{const moved=movePerson(point,heading,(action==='forward'?1:-1)*(data.stepPx??8),data);point=moved.point;status(moved.blocked?'前方为墙、楼梯或未划定通道，已停止移动':'');}
  result();
}
document.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>act(button.dataset.action));
document.addEventListener('keydown',e=>{
  const action={ArrowUp:'forward',ArrowDown:'back',ArrowLeft:'left',ArrowRight:'right'}[e.key];
  if(!action||$('mode').value!=='demo'||e.target.matches('input,select,textarea,[contenteditable="true"]'))return;
  e.preventDefault();act(action);
});
$('sound-start').onclick=async()=>{try{updateGuidance();if(!cue){sound.stop();status('当前无可引导路径，或已到达目标');return;}await sound.start();}catch(e){$('sound-status').textContent='声音启动失败：'+e.message;}};
$('sound-stop').onclick=()=>sound.stop();
for(const side of ['left','right'])$(`ear-${side}`).onclick=async()=>{try{await sound.test(side);}catch(e){$('sound-status').textContent=e.message;}};
$('sound-volume').oninput=()=>sound.setVolume(Number($('sound-volume').value));
$('swap-ears').onchange=()=>{sound.swap=$('swap-ears').checked;updateGuidance();};
$('plan-source').value=legacy?'legacy':'architecture';
$('plan-source').onchange=()=>{if(!confirm('切换底图会清除本页未导出的修改，是否继续？')){$('plan-source').value=legacy?'legacy':'architecture';return;}const url=new URL(location.href);url.searchParams.set('plan',$('plan-source').value);location.href=url;};
$('plan-description').textContent=legacy?'旧导视图 · 保留原实验坐标':'建筑原图 · 仅下半张一层；带图纸估算比例，入口待核查';
$('planning-controls').hidden=legacy;
$('model-download').href=legacy?'college-1f.glb':'architecture/college-1f.glb';
$('mx').max=data.image.width;$('my').max=data.image.height;
if(!legacy){$('sim-step').textContent='新图每步 3px（图纸估算约 0.4m）；左右键转身 15°。起点朝向默认向图上方，目标可能在左侧。';$('placement-intro').textContent='彩色 ID 为稀疏候选；橙色方框是触觉决策／停靠建议，绿色线为导向走廊建议，青色 P 点为覆盖算法补码候选（未登记 ID）。码不能贴在凸起盲道上；最终坐标与铺装均需现场确认。';}
for(const id of ['show-tactile','show-coverage','placement-mode'])$(id).onchange=()=>{updateStudyText();draw();};
$('recompute-study').onclick=()=>{refreshStudy();draw();};
$('short-tour').onclick=()=>{$('tour-order').value=(data.experiment?.shortTour||[0,2]).join(',');$('apply-tour').click();};
$('full-tour').onclick=()=>{$('tour-order').value=data.markers.map(m=>m.id).concat(data.markers[0].id).join(',');$('apply-tour').click();};
setView('2d');rebuildTour();updateScale();selectMarker(selected);
