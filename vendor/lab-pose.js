(function(root){
'use strict';
function validate(c,w,h){
 if(!c||c.schemaVersion!==1||typeof c.id!=='string'||!c.id||!Number.isInteger(c.width)||!Number.isInteger(c.height)||c.width<=0||c.height<=0)throw Error('无效标定标识或分辨率');
 const K=c.cameraMatrix,D=c.distCoeffs;
 if(!Array.isArray(K)||K.length!==3||!K.every(r=>Array.isArray(r)&&r.length===3&&r.every(Number.isFinite))||K[0][0]<=0||K[1][1]<=0||K[2][2]!==1||K[2][0]!==0||K[2][1]!==0||K[0][1]!==0||K[1][0]!==0||K[0][2]<0||K[0][2]>c.width||K[1][2]<0||K[1][2]>c.height)throw Error('无效相机内参');
 if(!Array.isArray(D)||![4,5,8,12,14].includes(D.length)||!D.every(Number.isFinite)||!Number.isFinite(c.rmsPx)||c.rmsPx<0||!c.board||!Number.isInteger(c.board.innerCols)||c.board.innerCols<3||!Number.isInteger(c.board.innerRows)||c.board.innerRows<3||!Number.isFinite(c.board.squareMm)||c.board.squareMm<=0)throw Error('缺少畸变、棋盘格或误差字段');
 // Strict same resolution: no assumption that another camera mode is just a resize.
 if(w!==c.width||h!==c.height)throw Error(`标定为 ${c.width}×${c.height}，视频为 ${w}×${h}；请使用相同镜头与分辨率重新采集`);
 return c;
}
function pointsToVideo(corners,vw,vh,dw,dh){return corners.map(p=>({x:p.x*vw/dw,y:p.y*vh/dh}));}
function objectPoints(mm){const s=mm/2000;return [-s,s,0,s,s,0,s,-s,0,-s,-s,0];}
function minEdge(corners){return Math.min(...corners.map((p,i)=>Math.hypot(p.x-corners[(i+1)%4].x,p.y-corners[(i+1)%4].y)));}
// Only current valid observations can be recorded; this stabilizes status, not distance.
const MODES={relaxed:{label:'超宽松粗估',enterPx:4,holdPx:3,maxRmsPx:12,confirmFrames:1,maxLengthSkew:.8,maxNonOrth:.95,maxTiltDeg:89.8},coarse:{label:'粗略测距',enterPx:8,holdPx:6,maxRmsPx:6},strict:{label:'较严格测距',enterPx:16,holdPx:12,maxRmsPx:3}};
function createTracker({enterPx=16,holdPx=12,confirmFrames=3}={}){
 let state='idle',good=0,bad=0,failure='';
 return {
  reset(){state='idle';good=bad=0;failure='';},
  step({edge=0,valid=false,lost=false}={}){
   if(lost){this.reset();return {state,ready:false};}
   const holding=state==='tracking'&&valid&&edge>=holdPx;
   if(holding){good=bad=0;failure='';return {state,ready:true};}
   if(valid&&edge>=enterPx){
    bad=0;failure='';good++;
    if(good>=confirmFrames){state='tracking';good=0;return {state,ready:true};}
    // Keep a latched failure message until enough good observations arrive.
    if(state==='idle')state='acquiring';
    else if(state==='tracking')state='recovering';
   }else{
    good=0;
    const reason=edge<enterPx?'tooSmall':'unstable';
    bad=reason===failure?bad+1:1;failure=reason;
    if(state==='tracking')state='recovering';
    if(state==='idle')state='acquiring';
    if(bad>=3)state=reason;
   }
   return {state,ready:false};
  }
 };
}
function solve(cv,corners,mm,c,{minEdgePx=12,maxRmsPx=3}={}){
 if(!Number.isFinite(mm)||mm<10||mm>2000)throw Error('码体边长需为 10–2000 mm');
 if(corners.length!==4||!corners.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)))throw Error('四角无效');
 if(corners.some((p,i)=>Math.hypot(p.x-corners[(i+1)%4].x,p.y-corners[(i+1)%4].y)<minEdgePx))throw Error('标记过小');
 const turns=corners.map((p,i)=>{const q=corners[(i+1)%4],r=corners[(i+2)%4];return(q.x-p.x)*(r.y-q.y)-(q.y-p.y)*(r.x-q.x);});
 if(!turns.every(v=>v>0)&&!turns.every(v=>v<0))throw Error('角点不构成有序凸四边形');
 const mats=[];const mat=(r,col,type,data)=>{const m=cv.matFromArray(r,col,type,data);mats.push(m);return m;};
 try{
 const obj=mat(4,1,cv.CV_64FC3,objectPoints(mm)),img=mat(4,1,cv.CV_64FC2,corners.flatMap(p=>[p.x,p.y]));
 const K=mat(3,3,cv.CV_64F,c.cameraMatrix.flat()),D=mat(c.distCoeffs.length,1,cv.CV_64F,c.distCoeffs);
 const r=new cv.Mat(),t=new cv.Mat(),pred=new cv.Mat(),R=new cv.Mat();mats.push(r,t,pred,R);
 if(!cv.solvePnP(obj,img,K,D,r,t,false,cv.SOLVEPNP_IPPE_SQUARE))throw Error('位姿无解');
 cv.Rodrigues(r,R);const tr=Array.from(t.data64F),rot=Array.from(r.data64F);
 const xyz=objectPoints(mm);
 for(let i=0;i<4;i++)if(R.data64F[6]*xyz[i*3]+R.data64F[7]*xyz[i*3+1]+tr[2]<=0)throw Error('标记在相机后方');
 cv.projectPoints(obj,r,t,K,D,pred);
 const pp=pred.data64F;let error=0;
 corners.forEach((p,i)=>error+=(p.x-pp[2*i])**2+(p.y-pp[2*i+1])**2);
 const rms=Math.sqrt(error/4),distanceM=Math.hypot(...tr);
 if(!Number.isFinite(distanceM)||distanceM<=0||distanceM>100||!Number.isFinite(rms)||rms>maxRmsPx)throw Error(`结果异常或重投影误差超过 ${maxRmsPx} px`);
 return {distanceM,tvec:tr,rvec:rot,rmsPx:rms,solver:'IPPE_SQUARE',ambiguity:'单平面可能存在双解；本构建仅返回首选解，未消除歧义',smoothed:false};
 }finally{mats.forEach(m=>m.delete());}
}
const api={validate,pointsToVideo,objectPoints,solve,minEdge,createTracker,MODES};if(typeof module!=='undefined')module.exports=api;else root.LabPose=api;
})(typeof window==='undefined'?globalThis:window);
