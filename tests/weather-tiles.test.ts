import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planWeatherTiles,tileGeometry,interpolate,type WeatherPoint,type WeatherTile} from '../src/weather-tiles';
import {weatherSampler,weatherColor} from '../src/client/weather-render';
test('adaptive plans bound requests, refine on zoom, wrap longitude and cover polar views',()=>{
  assert.equal(planWeatherTiles({west:-180,east:180,south:-90,north:90}).length,0);
  let previous=Infinity;
  for(const width of [20,8,3,.8,.2,.03]){
    const plan=planWeatherTiles({west:103,east:103+width,south:1,north:1+width/2});
    assert.ok(plan.length>0&&plan.length<=6);assert.ok(plan[0].resolution<=previous);previous=plan[0].resolution;
    for(const t of plan)assert.ok(tileGeometry(t.level,t.x,t.y));
  }
  assert.equal(previous,.025);
  const seam=planWeatherTiles({west:179.8,east:-179.8,south:10,north:10.2});
  assert.ok(seam.some(t=>t.west<0)&&seam.some(t=>t.west>0));assert.ok(seam.length<=6);
  const polar=planWeatherTiles({west:5,east:5.4,south:89.8,north:90});assert.ok(polar.length>0);assert.ok(polar.every(t=>t.north<=90));
  for(const args of [[-1,0,0],[8,0,0],[0,-1,0],[0,18,0],[0,0,9],[0,.5,0]])assert.equal(tileGeometry(...args as [number,number,number]),null);
});
const point=(direction:number,temperature:number|null=20):WeatherPoint=>({lat:0,lon:0,time:null,temperature,wind:10,direction});
test('weather interpolation preserves missing data, wraps direction and blends wind components',()=>{
  const value=interpolate([point(359),point(1),point(359),point(1)],[0,1,2,3],.5,.5);
  assert.ok(Math.abs(value.u!)<1e-9);assert.ok(value.v!<-9.99);
  const calm=interpolate([point(90),point(270),point(90),point(270)],[0,1,2,3],.5,.5);assert.ok(calm.wind!<1e-9);
  assert.equal(interpolate([point(0,null),point(0),point(0),point(0)],[0,1,2,3],.5,.5).temperature,null);
  const geometry=tileGeometry(4,283,91)!;
  const tile:WeatherTile={...geometry,fetchedAt:new Date().toISOString(),points:Array.from({length:25},(_,i)=>({...point(0,Math.floor(i/5)*10+i%5),lat:0,lon:0}))};
  const sample=weatherSampler(null,[tile]);
  assert.equal(sample(tile.south+.125,tile.west+.125).temperature,5.5);
  assert.equal(sample(tile.south+.125,tile.west+.125+360).temperature,5.5);
  assert.equal(sample(-50,0).temperature,null);
  assert.deepEqual(weatherColor(-40,true),[53,39,132]);assert.deepEqual(weatherColor(50,true),[141,34,83]);
});
