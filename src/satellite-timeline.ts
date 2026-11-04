import type {SatelliteScene} from './satellite';
export type SatelliteInterval='recent'|'week'|'month'|'quarter';
export type SatelliteFrame=SatelliteScene&{targetAt:string;offsetDays:number};
export const SATELLITE_START=Date.parse('2017-01-01T00:00:00Z');
export const DAY=86400000;
export const toleranceDays:Record<SatelliteInterval,number>={recent:0,week:3.5,month:15,quarter:45};
/** Calendar arithmetic clamps month ends instead of rolling February into March. */
export function satelliteTarget(anchor:number,interval:SatelliteInterval,index:number){
 if(interval==='week'||interval==='recent')return anchor-index*7*DAY;
 const date=new Date(anchor),day=date.getUTCDate();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()-index*(interval==='quarter'?3:1));
 const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();date.setUTCDate(Math.min(day,last));return date.getTime();
}
export function satelliteRows(features:unknown[],from:number,to:number):SatelliteScene[]{
 const rows=new Map<string,SatelliteScene>();
 for(const raw of features){const f=raw as {id?:unknown;properties?:Record<string,unknown>}|null;const value=f?.properties?.datetime,time=typeof value==='string'?Date.parse(value):NaN;
  if(typeof f?.id!=='string'||f.id.length>250||!Number.isFinite(time)||time<from||time>to)continue;
  const cloud=f.properties?.['eo:cloud_cover'],scene={id:f.id,acquiredAt:new Date(time).toISOString(),cloudCover:typeof cloud==='number'&&cloud>=0&&cloud<=100?cloud:null};
  const existing=rows.get(scene.acquiredAt);if(!existing||(scene.cloudCover??101)<(existing.cloudCover??101))rows.set(scene.acquiredAt,scene);
 }
 return [...rows.values()].sort((a,b)=>Date.parse(b.acquiredAt)-Date.parse(a.acquiredAt));
}
export function satelliteSequence(rows:SatelliteScene[],interval:SatelliteInterval,count:number,anchor:number){
 const ordered=[...new Map(rows.filter(r=>Date.parse(r.acquiredAt)<=anchor).map(r=>[r.acquiredAt,r])).values()].sort((a,b)=>Date.parse(b.acquiredAt)-Date.parse(a.acquiredAt));
 if(interval==='recent')return ordered.slice(0,count).reverse().map(scene=>({...scene,targetAt:scene.acquiredAt,offsetDays:0}));
 const used=new Set<string>(),frames:SatelliteFrame[]=[];
 for(let i=0;i<count;i++){
  const target=satelliteTarget(anchor,interval,i),tolerance=toleranceDays[interval]*DAY;
  // Nearest observation, then least cloudy on ties. Never reuse a timestamp to fill a gap.
  const candidate=ordered.filter(r=>!used.has(r.acquiredAt)&&Math.abs(Date.parse(r.acquiredAt)-target)<=tolerance).sort((a,b)=>Math.abs(Date.parse(a.acquiredAt)-target)-Math.abs(Date.parse(b.acquiredAt)-target)||(a.cloudCover??101)-(b.cloudCover??101))[0];
  if(candidate){used.add(candidate.acquiredAt);frames.push({...candidate,targetAt:new Date(target).toISOString(),offsetDays:(Date.parse(candidate.acquiredAt)-target)/DAY});}
 }
 return frames.sort((a,b)=>Date.parse(a.acquiredAt)-Date.parse(b.acquiredAt));
}
