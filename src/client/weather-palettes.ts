export type WeatherField='temperature'|'humidity'|'pressure'|'cloud';
export const weatherFields={
 temperature:{label:'气温',unit:'°C',ticks:['−40','−20','0','10','20','30','40','50'],stops:[[-40,73,45,155],[-20,46,105,209],[0,34,183,210],[10,69,199,139],[20,233,218,80],[30,249,146,45],[40,224,59,75],[50,151,36,114]]},
 humidity:{label:'湿度',unit:'%',ticks:['0','25','50','75','100'],stops:[[0,181,121,55],[25,224,192,120],[50,97,192,174],[75,43,130,192],[100,77,52,151]]},
 pressure:{label:'海平面气压',unit:'hPa',ticks:['960','990','1010','1030','1050'],stops:[[960,114,59,173],[990,44,134,213],[1010,62,195,169],[1030,240,200,73],[1050,219,71,72]]},
 cloud:{label:'总云量',unit:'%',ticks:['0','25','50','75','100'],stops:[[0,32,70,107],[25,80,115,147],[50,136,158,178],[75,199,211,222],[100,249,250,252]]}
};
export function fieldColor(value:number,field:WeatherField){const stops=weatherFields[field].stops;let i=0;while(i<stops.length-2&&value>stops[i+1][0])i++;const a=stops[i],b=stops[i+1],f=Math.max(0,Math.min(1,(value-a[0])/(b[0]-a[0])));return [1,2,3].map(k=>Math.round(a[k]*(1-f)+b[k]*f));}
export function fieldGradient(field:WeatherField){const s=weatherFields[field].stops;return `linear-gradient(90deg,${s.map(p=>`rgb(${p.slice(1).join(',')}) ${(p[0]-s[0][0])/(s.at(-1)![0]-s[0][0])*100}%`).join(',')})`;}
