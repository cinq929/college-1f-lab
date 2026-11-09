// Map: image x right, image y down. World: +X right, +Y image up, +Z up.
export function rodrigues(v) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) throw Error('rvec 必须是三个有限数');
  const a = Math.hypot(...v);
  if (a < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = v.map(n => n / a), c = Math.cos(a), s = Math.sin(a), d = 1 - c;
  return [[c+x*x*d, x*y*d-z*s, x*z*d+y*s], [y*x*d+z*s, c+y*y*d, y*z*d-x*s], [z*x*d-y*s, z*y*d+x*s, c+z*z*d]];
}

export function markerToMap(marker, local, metersPerPixel) {
  if (!(metersPerPixel > 0) || !Number.isFinite(metersPerPixel)) throw Error('请先用实测长度定标');
  const a = marker.yawDeg * Math.PI / 180, [x, y, z] = local;
  return { x: marker.x + (Math.cos(a)*x - Math.sin(a)*y) / metersPerPixel,
    y: marker.y - (Math.sin(a)*x + Math.cos(a)*y) / metersPerPixel, heightM: z };
}

export function poseToMap(marker, observation, metersPerPixel) {
  const { rvec, tvec } = observation;
  if (!Array.isArray(tvec) || tvec.length !== 3 || !tvec.every(Number.isFinite) || tvec[2] <= 0 || Math.hypot(...tvec) > 100) throw Error('tvec 无效，需使用米制 OpenCV 位姿');
  if (!Number.isFinite(observation.sizeMm) || Math.abs(observation.sizeMm - marker.sizeMm) > 0.1) throw Error('观测码体边长与登记尺寸不一致');
  if (observation.solver !== 'IPPE_SQUARE' || !observation.calibrationId || !Number.isFinite(observation.rmsPx) || observation.rmsPx > 3 || observation.rmsPx < 0) throw Error('需已标定 IPPE_SQUARE 观测，重投影 RMS ≤3 px');
  const R = rodrigues(rvec);
  // Camera center in marker coordinates = -R^T t. Never use t as world position.
  const local = [0, 1, 2].map(j => -tvec.reduce((sum, n, i) => sum + R[i][j] * n, 0));
  if (local[2] < 0.2 || local[2] > 2.5) throw Error('解算相机高度不在 0.2–2.5 m 实验范围，请核对朝向、尺寸或平面双解');
  return { ...markerToMap(marker, local, metersPerPixel), local, distanceM: Math.hypot(...tvec) };
}

export function horizontalRadius(slant, height) {
  if (![slant, height].every(Number.isFinite) || height < 0 || slant <= 0 || slant < height) throw Error('斜距必须大于等于相机离地高度，且为正数');
  return Math.sqrt(Math.max(0, slant*slant - height*height));
}

export function insidePolygon(p, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [x, y] = polygon[i], [a, b] = polygon[j];
    if ((y > p.y) !== (b > p.y) && p.x < (a-x)*(p.y-y)/(b-y)+x) inside = !inside;
  }
  return inside;
}

export function classify(p, data) {
  if (!data.footprints.some(poly => insidePolygon(p, poly))) return { kind: 'outside', name: '图示建筑外／未覆盖区' };
  const block = data.blocks.find(b => insidePolygon(p, b.polygon));
  if (block) return { kind: 'blocked', name: block.name + '（不可用作停靠点）' };
  // Reject a position inside a traced wall rather than snapping it onto a corridor.
  if (data.walls.some(([x1,y1,x2,y2]) => {
    const dx=x2-x1, dy=y2-y1, t=Math.max(0,Math.min(1,((p.x-x1)*dx+(p.y-y1)*dy)/(dx*dx+dy*dy)));
    return Math.hypot(p.x-x1-t*dx,p.y-y1-t*dy)<(data.geometry?.wallClearancePx??5);
  })) return { kind: 'blocked', name: '墙体附近，需重新确认' };
  const zone = data.zones.find(z => insidePolygon(p, z.polygon));
  return zone ? { kind: zone.kind || 'zone', name: zone.name } : { kind: 'unknown', name: '未划定区域，需现场确认' };
}

export function nearby(p, markers, metersPerPixel) {
  return markers.map(m => ({ ...m, distance: Math.hypot(m.x-p.x,m.y-p.y)*(metersPerPixel || 1) })).sort((a,b) => a.distance-b.distance);
}
