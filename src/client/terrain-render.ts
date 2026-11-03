import {contourInterval,contourSegments,terrainColor} from '../terrain';
export type ContourLabel={x:number;y:number;h:number};
export type TerrainOptions={elevation:boolean;hillshade:boolean;contours:boolean};
export async function renderTerrain(grid:Float32Array,z:number,y:number,options:TerrainOptions,cancelled:()=>boolean=()=>false){
  const canvas=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(256,256):document.createElement('canvas');canvas.width=canvas.height=256;
  const ctx=canvas.getContext('2d') as CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D;
  const pixels=ctx.createImageData(256,256);
  const labels:ContourLabel[]=[];
  if(options.elevation||options.hillshade)for(let row=0;row<256;row++){
    const lat=Math.atan(Math.sinh(Math.PI*(1-2*(y+(row+.5)/256)/2**z)));
    const spacing=40075016.686*Math.cos(lat)/(256*2**z);
    for(let col=0;col<256;col++){
      const i=row*257+col,h=grid[i];if(!Number.isFinite(h))continue;
      const dx=(grid[i+1]-h)/spacing,dy=(grid[i+257]-h)/spacing;
      // Fixed NW illumination for readable relief; this is not live sunlight.
      const light=Number.isFinite(dx+dy)?Math.max(0,(.5*dx+.5*dy+.7071)/Math.hypot(dx,dy,1)):.7071;
      const color=options.elevation?terrainColor(h):[0,0,0],out=(row*256+col)*4;
      if(options.elevation){const shade=options.hillshade?.55+.65*light:1;for(let k=0;k<3;k++)pixels.data[out+k]=color[k]*shade;pixels.data[out+3]=220;}
      else if(options.hillshade){const bright=light>.7071;pixels.data[out]=pixels.data[out+1]=pixels.data[out+2]=bright?255:15;pixels.data[out+3]=Math.abs(light-.7071)*(bright?160:200);}
    }
    if(row%32===31){if(typeof window!=='undefined')await new Promise(resolve=>setTimeout(resolve,0));if(cancelled())throw Error('图层已关闭');}
  }
  ctx.putImageData(pixels,0,0);
  // Global contour labels are unreadable on a curved globe. Reveal them as the
  // imagery reaches regional scales, then refine using the same source heights.
  if(options.contours&&z>=5){
    const interval=contourInterval(z),minor=new Path2D(),major=new Path2D();
    for(let row=0;row<256;row++){
      for(let col=0;col<256;col++){
        const i=row*257+col,values=[grid[i],grid[i+1],grid[i+258],grid[i+257]];
        if(values.some(v=>!Number.isFinite(v)))continue;
        const lo=Math.min(...values),hi=Math.max(...values);
        for(let h=Math.ceil(lo/interval)*interval;h<hi;h+=interval){
          const isMajor=Math.round(h/interval)%5===0,path=isMajor?major:minor;
          for(const [x1,y1,x2,y2] of contourSegments(values,h)){
            path.moveTo(col+x1+.5,row+y1+.5);path.lineTo(col+x2+.5,row+y2+.5);
            if(isMajor&&z>=8&&col>30&&col<215&&row>24&&row<232&&labels.length<3&&labels.every(p=>Math.hypot(p.x-col,p.y-row)>100))labels.push({x:col,y:row,h});
          }
        }
      }
      if(row%32===31){if(typeof window!=='undefined')await new Promise(resolve=>setTimeout(resolve,0));if(cancelled())throw Error('图层已关闭');}
    }
    ctx.strokeStyle='rgba(244,239,218,.35)';ctx.lineWidth=.8;ctx.stroke(minor);
    ctx.strokeStyle='rgba(28,39,49,.9)';ctx.lineWidth=2.2;ctx.stroke(major);
    ctx.strokeStyle='rgba(250,241,209,.8)';ctx.lineWidth=1;ctx.stroke(major);

  }
  return {canvas,labels};
}
