import {interpolate,wrapLongitude,type Bounds,type WeatherGrid,type WeatherTile} from '../weather-tiles';
const stops=[[-40,53,39,132],[-20,51,104,202],[0,58,177,207],[10,104,202,169],[20,235,220,127],[30,243,156,78],[40,213,75,63],[50,141,34,83]];
export function weatherColor(value:number,temperature:boolean):number[]{
  const t=temperature?value:value*3-40;
  let i=0;while(i<stops.length-2&&t>stops[i+1][0])i++;
  const a=stops[i],b=stops[i+1],f=Math.max(0,Math.min(1,(t-a[0])/(b[0]-a[0])));
  return [1,2,3].map(k=>Math.round(a[k]*(1-f)+b[k]*f));
}
export function weatherSampler(global:WeatherGrid|null,tiles:WeatherTile[]){
  const level=tiles[0],size=level?level.resolution*4:0;
  const lookup=new Map(tiles.map(t=>[`${t.x}/${t.y}`,t]));
  return (latitude:number,longitude:number)=>{
    const lon=wrapLongitude(longitude),lat=Math.max(-90,Math.min(90-1e-9,latitude));
    const tile=level?lookup.get(`${Math.floor((lon+180)/size)}/${Math.floor((lat+90)/size)}`):undefined;
    if(tile){
      const x=Math.max(0,Math.min(4,(lon-tile.west)/tile.resolution)),y=Math.max(0,Math.min(4,(lat-tile.south)/tile.resolution));
      const left=Math.min(3,Math.floor(x)),bottom=Math.min(3,Math.floor(y)),i=bottom*5+left;
      return interpolate(tile.points,[i,i+1,i+5,i+6],x-left,y-bottom);
    }
    if(!global||lat<-75||lat>75)return {temperature:null,wind:null,u:null,v:null};
    const x=(lon+180)/15,y=(lat+75)/15,left=Math.floor(x),right=(left+1)%24,bottom=Math.min(9,Math.floor(y));
    return interpolate(global.points,[bottom*24+left,bottom*24+right,(bottom+1)*24+left,(bottom+1)*24+right],x-left,y-bottom);
  };
}
export async function drawWeather(bounds:Bounds,global:WeatherGrid|null,tiles:WeatherTile[],temperature:boolean,wind:boolean,width:number,height:number,cancelled:()=>boolean){
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d')!,pixels=ctx.createImageData(width,height),sample=weatherSampler(global,tiles);
  const east=bounds.east<=bounds.west?bounds.east+360:bounds.east;
  const at=(x:number,y:number)=>sample(bounds.north-(y+.5)/height*(bounds.north-bounds.south),bounds.west+(x+.5)/width*(east-bounds.west));
  for(let y=0;y<height;y++){
    if(y%64===0){await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));if(cancelled())return null;}
    for(let x=0;x<width;x++){
      const data=at(x,y),value=temperature?data.temperature:data.wind;
      if(value===null)continue;const i=(y*width+x)*4,color=weatherColor(value,temperature);
      pixels.data[i]=color[0];pixels.data[i+1]=color[1];pixels.data[i+2]=color[2];pixels.data[i+3]=255;
    }
  }
  ctx.putImageData(pixels,0,0);
  // Thin 5°C contours expose actual field structure without adding fake texture.
  if(temperature&&tiles.length){
    ctx.strokeStyle='rgba(255,255,255,.22)';ctx.lineWidth=.65;
    for(let y=0;y<height-12;y+=12)for(let x=0;x<width-12;x+=12){
      const corners=[[x,y],[x+12,y],[x+12,y+12],[x,y+12]];
      const values=corners.map(([a,b])=>at(a,b).temperature);if(values.some(v=>v===null))continue;
      const nums=values as number[];
      for(let t=Math.ceil(Math.min(...nums)/5)*5;t<=Math.max(...nums);t+=5){
        const hits:number[][]=[];
        for(let i=0;i<4;i++){const j=(i+1)%4,a=nums[i],b=nums[j];if((a<t)===(b<t))continue;const f=(t-a)/(b-a);hits.push([corners[i][0]+(corners[j][0]-corners[i][0])*f,corners[i][1]+(corners[j][1]-corners[i][1])*f]);}
        if(hits.length===2){ctx.beginPath();ctx.moveTo(hits[0][0],hits[0][1]);ctx.lineTo(hits[1][0],hits[1][1]);ctx.stroke();}
      }
    }
  }
  const arrows=document.createElement('canvas');arrows.width=width;arrows.height=height;
  if(wind){const pen=arrows.getContext('2d')!;
    for(let y=32;y<height;y+=64)for(let x=32;x<width;x+=64){
      const data=at(x,y);if(data.u===null||data.v===null||data.wind===null||data.wind<.2)continue;
      pen.save();pen.translate(x,y);pen.rotate(Math.atan2(-data.u,-data.v));
      pen.strokeStyle=temperature?`rgb(${weatherColor(data.wind,false).join(',')})`:'#f5faff';pen.lineWidth=2;pen.shadowColor='#172434';pen.shadowBlur=2;
      pen.beginPath();pen.moveTo(0,-10);pen.lineTo(0,10);pen.lineTo(-4,4);pen.moveTo(0,10);pen.lineTo(4,4);pen.stroke();pen.restore();
    }
  }
  return {canvas,arrows};
}
