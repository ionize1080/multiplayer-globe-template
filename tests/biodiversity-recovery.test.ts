import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bioGroup,normalizeTaxonomy} from '../src/taxonomy';
import {boundsGeometry} from '../src/atlas-stats';
import {photoLicense,safeHttps,speciesPreviewUrl} from '../src/species';
import {atlasStats} from '../src/server/atlas-stats';
import {speciesDetails} from '../src/server/species';
test('recovered taxonomy recognizes GBIF nested classifications and distinct biological groups',()=>{
 const nested={classifications:{backbone:{usage:{key:'100',name:'Egretta garzetta'},classification:[{rank:'KINGDOM',name:'Animalia',key:'1'},{rank:'CLASS',name:'Aves',key:'212'},{rank:'SPECIES',name:'Egretta garzetta',key:'200'}]}}};
 const r=normalizeTaxonomy(nested);assert.equal(r.kingdomKey,1);assert.equal(r.speciesKey,200);assert.equal(bioGroup(r,'animals'),'bird');
 assert.equal(bioGroup({class:'Arachnida'},'animals'),'arachnid');assert.equal(bioGroup({family:'Poaceae'},'plants'),'grass');assert.equal(bioGroup({phylum:'Bryophyta'},'plants'),'moss');assert.equal(bioGroup({phylum:'Mollusca'},'animals'),'mollusc');assert.equal(bioGroup({},'animals'),'unknown');
});
test('photos preserve provenance, reject unsafe links and limit size rewriting to known image services',()=>{
 assert.equal(safeHttps('javascript:alert(1)'), '');assert.equal(safeHttps('https://user:password@example.com/a'), '');assert.equal(photoLicense('all rights reserved'),'');assert.equal(photoLicense('https://creativecommons.org/licenses/by-nc-sa/4.0/'),'CC BY-NC-SA 4.0');
 assert.equal(speciesPreviewUrl('https://static.inaturalist.org/photos/123/original.jpg'),'https://static.inaturalist.org/photos/123/medium.jpg');
 for(const u of ['https://other.example/photos/123/original.jpg','https://static.inaturalist.org/photos/123/original.jpg?token=1'])assert.equal(speciesPreviewUrl(u),u);
});
test('invalid species and statistics parameters are rejected without provider requests',async()=>{
 const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected');};try{
  for(const value of ['','0','-1','abc','9007199254740992'])assert.equal((await speciesDetails(new Request('https://test/api/globe/atlas/species?occurrence='+value))).status,400);
  for(const q of ['layer=minerals&west=0&east=1&south=0&north=1','layer=animals&west=0&east=1&south=0&north=1&offset=-1','layer=animals&west=0&east=1&south=0&north=1&species=0'])assert.equal((await atlasStats(new Request('https://test/api/globe/atlas/stats?'+q))).status,400);
  assert.equal(calls,0);
 }finally{globalThis.fetch=old;}
});
test('species details prefer exact matches, retain partial facts and distinguish reference photos',async()=>{
 const old=globalThis.fetch;globalThis.fetch=async input=>{const u=new URL(String(input));
  if(u.pathname==='/v1/occurrence/10')return Response.json({kingdomKey:1,speciesKey:20,scientificName:'Egretta garzetta',species:'Egretta garzetta',class:'Aves',habitat:'Wetland',media:[{type:'StillImage',identifier:'https://example.com/restricted.jpg',license:'All rights reserved'}]});
  if(u.pathname==='/v1/species/20')return Response.json({canonicalName:'Egretta garzetta'});
  if(u.pathname.includes('vernacularNames'))return new Response('',{status:503});
  assert.equal(u.hostname,'api.inaturalist.org');return Response.json({results:[{is_active:true,id:1,name:'Egretta wrong',preferred_common_name:'错误匹配'}, {is_active:true,id:2,name:'Egretta garzetta',preferred_common_name:'小白鹭',default_photo:{license_code:'cc-by',medium_url:'https://static.inaturalist.org/photos/1/medium.jpg',attribution:'Photographer'}}]});
 };
 try{const r=await speciesDetails(new Request('https://test/api/globe/atlas/species?occurrence=10')),d=await r.json();assert.equal(d.chineseName,'小白鹭');assert.equal(d.partial,true);assert.equal(d.photos.length,1);assert.equal(d.photos[0].reference,true);assert.equal(d.photos[0].credit,'Photographer');assert.deepEqual(d.facts,[{label:'生境',value:'Wetland'}]);assert.match(r.headers.get('Cache-Control')!,/max-age=60/);}finally{globalThis.fetch=old;}
});
test('statistics paginate facets independently of sampled map markers and support dateline record drilldown',async()=>{
 const old=globalThis.fetch;const urls:URL[]=[];
 globalThis.fetch=async input=>{const u=new URL(String(input));urls.push(u);
  if(u.pathname==='/v1/occurrence/search')return u.searchParams.has('speciesKey')?Response.json({count:27,endOfRecords:false,results:[{key:123,decimalLatitude:1,decimalLongitude:179,speciesKey:1,class:'Aves',scientificName:'A bird'}]}):Response.json({count:500,facets:[{field:'SPECIES_KEY',counts:Array.from({length:21},(_,i)=>({name:String(i+1),count:21-i}))}]});
  return Response.json({canonicalName:'A bird',vernacularName:'鸟类',class:'Aves'});
 };
 try{const base='https://test/api/globe/atlas/stats?layer=animals&west=170&east=-170&south=-10&north=10';const d=await (await atlasStats(new Request(base+'&offset=20'))).json();assert.equal(d.rows.length,20);assert.equal(d.totalRecords,500);assert.equal(d.hasMore,true);assert.equal(urls[0].searchParams.get('facetOffset'),'20');assert.match(urls[0].searchParams.get('geometry')!,/^MULTIPOLYGON/);assert.equal(d.rows[0].group,'bird');
  const records=await (await atlasStats(new Request(base+'&species=1&offset=20'))).json();assert.equal(records.records[0].id,'123');assert.equal(records.hasMore,true);assert.equal(records.total,27);assert.ok(urls.some(u=>u.searchParams.get('speciesKey')==='1'&&u.searchParams.get('offset')==='20'));
  assert.match(boundsGeometry({west:1,east:2,south:3,north:4}),/^POLYGON/);
 }finally{globalThis.fetch=old;}
});
