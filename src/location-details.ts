export type LocationDetails={parts:{label:string;value:string}[];distanceMeters:number|null;source:string};
/** Reverse geocoders return a nearby mapped feature, not proof of parcel ownership. */
export function locationDetails(payload:unknown,lat:number,lon:number):LocationDetails{
 const empty:LocationDetails={parts:[],distanceMeters:null,source:'Photon / OpenStreetMap'};
 const features=(payload as {features?:unknown[]}|null)?.features;if(!Array.isArray(features))return empty;
 for(const raw of features){
  const feature=raw as {geometry?:{coordinates?:number[]};properties?:Record<string,unknown>};
  const c=feature?.geometry?.coordinates,p=feature?.properties;if(!c||!p||!Number.isFinite(c[0])||!Number.isFinite(c[1])||Math.abs(c[0])>180||Math.abs(c[1])>90)continue;
  const rad=Math.PI/180,a=Math.sin((c[1]-lat)*rad/2)**2+Math.cos(lat*rad)*Math.cos(c[1]*rad)*Math.sin((c[0]-lon)*rad/2)**2;
  const distanceMeters=Math.round(12742000*Math.asin(Math.sqrt(Math.min(1,a))));if(distanceMeters>1000)continue;
  const parts:LocationDetails['parts']=[],seen=new Set<string>();
  for(const [key,label] of [['country','国家／地区'],['state','省／州'],['county','县／地区'],['city','城市'],['district','区／街区'],['locality','村镇／社区'],['street','街道'],['housenumber','门牌'],['name','具体地点'],['postcode','邮编']]){
   let value=typeof p[key]==='string'?(p[key] as string).trim().slice(0,200):'';
   if(key==='country'&&typeof p.countrycode==='string'&&/^[a-z]{2}$/i.test(p.countrycode)){try{const chinese=new Intl.DisplayNames(['zh-CN'],{type:'region'}).of(p.countrycode.toUpperCase());if(chinese)value=chinese;}catch{}}
   if(!value||seen.has(value))continue;seen.add(value);parts.push({label,value});
  }
  if(parts.length)return {parts,distanceMeters,source:empty.source};
 }
 return empty;
}
