import { classify } from './position.js';

// Heading: 0 = map up, 90 = map right, independent of the viewing camera.
export function relativeCue(person, target, headingDeg) {
  const dx=target.x-person.x, dy=target.y-person.y, distance=Math.hypot(dx,dy),h=headingDeg*Math.PI/180;
  if(distance<1e-8)return {distance:0,pan:0,angleDeg:0,front:1,left:Math.SQRT1_2,right:Math.SQRT1_2};
  const right=(dx*Math.cos(h)+dy*Math.sin(h))/distance,front=(dx*Math.sin(h)-dy*Math.cos(h))/distance;
  const pan=Math.max(-1,Math.min(1,right));
  return {distance,pan,front,angleDeg:Math.atan2(right,front)*180/Math.PI,left:Math.sqrt((1-pan)/2),right:Math.sqrt((1+pan)/2)};
}

export function canStand(p,data,radius=data.geometry?.bodyRadiusPx??6) {
  return [[0,0],[radius,0],[-radius,0],[0,radius],[0,-radius]].every(([dx,dy])=>classify({x:p.x+dx,y:p.y+dy},data).kind==='corridor');
}
export function clearSegment(a,b,data) {
  const steps=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/3));
  for(let i=0;i<=steps;i++)if(!canStand({x:a.x+(b.x-a.x)*i/steps,y:a.y+(b.y-a.y)*i/steps},data))return false;
  return true;
}
export function movePerson(p,headingDeg,distance,data) {
  const a=headingDeg*Math.PI/180,steps=Math.max(1,Math.ceil(Math.abs(distance)/2));let next={...p};
  for(let i=0;i<steps;i++){
    const q={x:next.x+Math.sin(a)*distance/steps,y:next.y-Math.cos(a)*distance/steps};
    if(!canStand(q,data))return {point:next,blocked:true};next=q;
  }
  return {point:next,blocked:false};
}

export function findPath(start,goal,data) {
  if(!canStand(start,data)||!canStand(goal,data))return null;
  if(clearSegment(start,goal,data))return [{...start},{x:goal.x,y:goal.y}];
  const step=data.geometry?.gridStepPx??10,key=(x,y)=>`${x},${y}`,distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),cache=new Map();
  const valid=p=>{const k=key(p.x,p.y);if(!cache.has(k))cache.set(k,canStand(p,data));return cache.get(k);};
  const snap=p=>{
    const points=[];for(let dx=-2;dx<=2;dx++)for(let dy=-2;dy<=2;dy++)points.push({x:Math.round(p.x/step)*step+dx*step,y:Math.round(p.y/step)*step+dy*step});
    return points.sort((a,b)=>distance(a,p)-distance(b,p)).find(q=>valid(q)&&clearSegment(p,q,data));
  };
  const a=snap(start),b=snap(goal);if(!a||!b)return null;
  const first={...a,g:0,f:distance(a,b),parent:null},open=[first],best=new Map([[key(a.x,a.y),0]]),closed=new Set();
  while(open.length){
    let index=0;for(let i=1;i<open.length;i++)if(open[i].f<open[index].f)index=i;
    const current=open.splice(index,1)[0],k=key(current.x,current.y);if(closed.has(k))continue;closed.add(k);
    if(current.x===b.x&&current.y===b.y){
      const nodes=[{x:goal.x,y:goal.y}];for(let n=current;n;n=n.parent)nodes.push({x:n.x,y:n.y});nodes.push({...start});nodes.reverse();
      const result=[nodes[0]];let i=0;
      while(i<nodes.length-1){let j=nodes.length-1;while(j>i+1&&!clearSegment(nodes[i],nodes[j],data))j--;result.push(nodes[j]);i=j;}
      return result;
    }
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){
      const p={x:current.x+dx*step,y:current.y+dy*step};
      if(p.x<0||p.y<0||p.x>data.image.width||p.y>data.image.height||closed.has(key(p.x,p.y))||!valid(p)||!clearSegment(current,p,data))continue;
      const g=current.g+distance(current,p),pk=key(p.x,p.y);if(g>=(best.get(pk)??Infinity))continue;
      best.set(pk,g);open.push({...p,g,f:g+distance(p,b),parent:current});
    }
  }
  return null;
}

// Reuse only collision-checked forward segments; a changed map needs a new path.
export function advancePath(start,path,data) {
  if(!path||!canStand(start,data))return null;
  for(let i=path.length-1;i>=1;i--)if(clearSegment(start,path[i],data))return [{...start},...path.slice(i)];
  return null;
}

export function parseTour(text,markers) {
  const tokens=text.trim().split(/[\s,，→]+/).filter(Boolean);
  if(tokens.length<2||tokens.some(t=>!/^\d+$/.test(t)))throw Error('请输入至少两个 ID，以逗号或箭头分隔');
  const ids=tokens.map(Number);
  if(ids.some(id=>!markers.some(m=>m.id===id)))throw Error('路线包含未登记的 ID');
  if(ids.some((id,i)=>i&&id===ids[i-1]))throw Error('相邻站点不能相同');
  return ids;
}
