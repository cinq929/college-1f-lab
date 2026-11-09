// Reuses the uploaded demo's strict OpenCV pose solver and the existing ArUco dictionary.
let runtime;
function openCV() {
  if (window.cv?.solvePnP && window.cv?.calledRun) return Promise.resolve({ cv: window.cv });
  if (runtime) return runtime;
  runtime = new Promise((resolve,reject) => {
    const script=document.createElement('script');
    const timer=setTimeout(()=>reject(Error('OpenCV 加载超时，请检查网络后刷新')),30000);
    const fail=message=>{clearTimeout(timer);reject(Error(message));};
    script.src='https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
    script.onerror=()=>fail('OpenCV.js 加载失败，请检查网络');
    script.onload=()=>{
      try {
        const ready=cv=>{
          if(!cv?.solvePnP){fail('OpenCV 缺少 solvePnP');return;}
          // Emscripten's custom thenable can resolve to itself; never await it directly.
          clearTimeout(timer);resolve({cv});
        };
        if(typeof window.cv?.then==='function')window.cv.then(ready);
        else if(window.cv?.solvePnP)ready(window.cv);
        else throw Error('OpenCV 未就绪');
      }catch(e){fail(e.message);}
    };
    document.head.append(script);
  }).catch(e=>{runtime=null;throw e;});
  return runtime;
}

export class LivePosition {
  constructor({video, markers, onPose, onInvalid, onStatus}) {
    Object.assign(this,{video,markers,onPose,onInvalid,onStatus});
    this.frame=document.createElement('canvas');this.ctx=this.frame.getContext('2d',{willReadFrequently:true});
    this.session=0;this.stream=null;this.raf=null;this.lastSeen=0;
    this.staleTimer=setInterval(()=>{if(this.lastSeen&&performance.now()-this.lastSeen>600){this.lastSeen=0;this.onInvalid('新观测已超过 0.6 秒，位置失效');}},200);
  }
  stop() {
    this.session++;cancelAnimationFrame(this.raf);this.raf=null;
    this.stream?.getTracks().forEach(t=>t.stop());this.stream=null;this.video.srcObject=null;this.lastSeen=0;
    this.onInvalid('摄像头已停止');
  }
  async start(calibration) {
    this.stop();const ticket=this.session;
    try {
      if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw Error('摄像头需要 HTTPS 或电脑 localhost');
      if(!calibration)throw Error('请先导入本机相机标定 JSON');
      if(!window.LabPose||!window.AR)throw Error('识别／位姿库没有加载');
      window.LabPose.validate(calibration,calibration.width,calibration.height);
      this.onStatus('正在加载位姿求解库…');this.cv=(await openCV()).cv;if(ticket!==this.session)return;
      const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:calibration.width},height:{ideal:calibration.height}}});
      if(ticket!==this.session){stream.getTracks().forEach(t=>t.stop());return;}
      this.stream=stream;this.video.srcObject=stream;await this.video.play();if(ticket!==this.session)return;
      window.LabPose.validate(calibration,this.video.videoWidth,this.video.videoHeight);
      this.calibration=calibration;this.detector=new window.AR.Detector({dictionaryName:'ARUCO'});
      this.tracker=window.LabPose.createTracker(window.LabPose.MODES.strict);this.targetId=null;this.lastScan=0;
      this.onStatus('摄像头已启动，等待已登记的地面标记');
      this.raf=requestAnimationFrame(t=>this.loop(t,ticket));
    }catch(e){if(ticket===this.session){this.stop();this.onStatus('启动失败：'+e.message);}}
  }
  loop(time,ticket) {
    if(ticket!==this.session||!this.stream)return;
    this.raf=requestAnimationFrame(t=>this.loop(t,ticket));
    if(time-this.lastScan<120||this.video.readyState<2)return;this.lastScan=time;
    try {
      const vw=this.video.videoWidth,vh=this.video.videoHeight,w=Math.min(960,vw),h=Math.round(vh*w/vw);
      this.frame.width=w;this.frame.height=h;this.ctx.drawImage(this.video,0,0,w,h);
      const detections=this.detector.detect(this.ctx.getImageData(0,0,w,h));
      const detected=detections.find(m=>m.id===this.targetId)||detections.find(m=>this.markers.some(n=>n.id===m.id));
      if(!detected){this.tracker.reset();this.targetId=null;this.lastSeen=0;this.onInvalid('未检测到已登记标记，当前无有效位置');return;}
      if(detected.id!==this.targetId){this.tracker.reset();this.targetId=detected.id;}
      const marker=this.markers.find(n=>n.id===detected.id),corners=window.LabPose.pointsToVideo(detected.corners,vw,vh,w,h),edge=window.LabPose.minEdge(corners);
      const pose=window.LabPose.solve(this.cv,corners,marker.sizeMm,this.calibration,{minEdgePx:12,maxRmsPx:3});
      const state=this.tracker.step({edge,valid:true});
      if(!state.ready){this.lastSeen=0;this.onInvalid(`读到 ID ${marker.id}，正在确认连续测位质量`);return;}
      this.lastSeen=performance.now();
      const accepted=this.onPose(marker,{...pose,id:marker.id,sizeMm:marker.sizeMm,calibrationId:this.calibration.id,time:new Date().toISOString()},corners);
      if(accepted===false)return;
      this.onStatus(`ID ${marker.id} · ${vw}×${vh} · 斜距 ${pose.distanceM.toFixed(2)} m · 重投影 RMS ${pose.rmsPx.toFixed(2)} px`);
    }catch(e){this.tracker?.step({edge:0,valid:false});this.lastSeen=0;this.onInvalid('当前无有效位置：'+e.message);}
  }
}
