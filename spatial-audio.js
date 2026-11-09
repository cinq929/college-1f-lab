// Explicit mono-to-stereo equal-power gains: left/right relations are testable.
export function stereoGraph(ctx,destination) {
  const left=ctx.createGain(),right=ctx.createGain(),merge=ctx.createChannelMerger(2);
  left.connect(merge,0,0);right.connect(merge,0,1);merge.connect(destination);
  return {left,right,merge,connect(source){source.connect(left);source.connect(right);},disconnect(){left.disconnect();right.disconnect();merge.disconnect();}};
}

export class SpatialCue {
  constructor(onStatus=()=>{}){this.onStatus=onStatus;this.ctx=null;this.timer=null;this.active=null;this.params=null;this.volume=.15;this.swap=false;this.token=0;}
  async unlock(){
    const AC=window.AudioContext||window.webkitAudioContext;if(!AC)throw Error('此浏览器不支持 Web Audio');
    if(!this.ctx){this.ctx=new AC();this.master=this.ctx.createGain();this.master.gain.value=this.volume;this.master.connect(this.ctx.destination);this.ctx.onstatechange=()=>{if(this.ctx.state!=='running')this.stop();};}
    await this.ctx.resume();if(this.ctx.state!=='running')throw Error('浏览器没有开启音频，请再次点击');
  }
  update(params){this.params=params;if(!params){this.silence();return;}if(this.active)this.apply(this.active.graph,params);}
  apply(graph,p){const t=this.ctx.currentTime;graph.left.gain.setTargetAtTime(this.swap?p.right:p.left,t,.025);graph.right.gain.setTargetAtTime(this.swap?p.left:p.right,t,.025);}
  pulse(params){
    if(!this.ctx||this.ctx.state!=='running'||!params)return;
    this.silence();const ctx=this.ctx,t=ctx.currentTime,osc=ctx.createOscillator(),env=ctx.createGain(),graph=stereoGraph(ctx,this.master);
    osc.type='triangle';osc.frequency.value=params.front<0?440:880;
    graph.left.gain.value=this.swap?params.right:params.left;graph.right.gain.value=this.swap?params.left:params.right;
    env.gain.setValueAtTime(0,t);env.gain.linearRampToValueAtTime(.7,t+.02);env.gain.setValueAtTime(.7,t+.18);env.gain.linearRampToValueAtTime(0,t+.23);
    osc.connect(env);graph.connect(env);const active={osc,env,graph};this.active=active;
    osc.onended=()=>{osc.disconnect();env.disconnect();graph.disconnect();if(this.active===active)this.active=null;};osc.start(t);osc.stop(t+.25);
  }
  async start(){const ticket=++this.token;await this.unlock();if(ticket!==this.token)return;clearInterval(this.timer);this.pulse(this.params);this.timer=setInterval(()=>this.pulse(this.params),550);this.onStatus('声音已开启');}
  silence(){if(this.active){this.active.env.gain.cancelScheduledValues(this.ctx.currentTime);this.active.env.gain.setValueAtTime(0,this.ctx.currentTime);try{this.active.osc.stop();}catch{}this.active=null;}}
  stop(){this.token++;clearInterval(this.timer);this.timer=null;this.silence();this.onStatus('声音已停止');}
  async test(side){this.stop();const ticket=this.token;await this.unlock();if(ticket!==this.token)return;this.pulse({left:side==='left'?1:0,right:side==='right'?1:0,front:1});this.onStatus(side==='left'?'左耳测试（导航已暂停）':'右耳测试（导航已暂停）');}
  setVolume(value){this.volume=Math.max(0,Math.min(.5,value));if(this.master)this.master.gain.setTargetAtTime(this.volume,this.ctx.currentTime,.025);}
}
