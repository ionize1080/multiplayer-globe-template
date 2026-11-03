import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeTerrarium,terrainPosition,terrainTileId,contourSegments,contourInterval} from '../src/terrain';
import {terrainTile} from '../src/server/terrain';
test('terrain preserves signed heights, excludes voids and handles world edges',()=>{
  assert.equal(decodeTerrarium(128,0,0),0);assert.equal(decodeTerrarium(127,246,128),-9.5);assert.equal(decodeTerrarium(145,193,0),4545);
  assert.ok(Number.isNaN(decodeTerrarium(0,0,0)));assert.ok(Number.isNaN(decodeTerrarium(128,0,0,0)));
  assert.deepEqual(terrainPosition(0,0,1),{x:1,y:1});assert.equal(terrainPosition(89,0,14),null);
  assert.deepEqual(terrainPosition(30,-180,14),terrainPosition(30,180,14));
  const point=terrainPosition(31.7873,89.1181,14)!;assert.ok(point.x>12247&&point.x<12248);assert.ok(point.y>6600&&point.y<6800);
  assert.deepEqual(terrainTileId('/api/globe/terrain/14/16383/0.png'),{z:14,x:16383,y:0});
  for(const path of ['/api/globe/terrain/15/0/0.png','/api/globe/terrain/1/2/0.png','/api/globe/terrain/1/-1/0.png','/api/globe/terrain/0/0/0.png/other'])assert.equal(terrainTileId(path),null);
});
test('contours interpolate actual crossings, avoid voids and split saddles',()=>{
  assert.deepEqual(contourSegments([0,100,100,0],50),[[.5,0,.5,1]]);
  assert.deepEqual(contourSegments([0,0,0,0],0),[]);assert.deepEqual(contourSegments([0,NaN,100,0],50),[]);
  assert.equal(contourSegments([100,0,100,0],50).length,2);
  assert.equal(contourInterval(14),20);assert.equal(contourInterval(0),1000);
});
test('terrain proxy validates before fetching, streams PNG and never forwards credentials',async()=>{
  const original=globalThis.fetch;let calls=0;
  try{
    globalThis.fetch=async(input,init)=>{calls++;assert.equal(String(input),'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/0/0/0.png');assert.equal(new Headers(init?.headers).has('Cookie'),false);assert.equal((init as {cf:{cacheTtlByStatus:Record<string,number>}}).cf.cacheTtlByStatus['200-299'],2592000);return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}});};
    assert.equal((await terrainTile(new Request('https://ionize.club/api/globe/terrain/99/0/0.png'))).status,400);assert.equal(calls,0);
    const response=await terrainTile(new Request('https://ionize.club/api/globe/terrain/0/0/0.png',{headers:{Cookie:'secret'}}));
    assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'private, max-age=86400');assert.equal((await response.arrayBuffer()).byteLength,3);
    globalThis.fetch=async()=>new Response('<html>error</html>',{headers:{'Content-Type':'text/html'}});
    assert.equal((await terrainTile(new Request('https://ionize.club/api/globe/terrain/0/0/0.png'))).status,502);
  }finally{globalThis.fetch=original;}
});
