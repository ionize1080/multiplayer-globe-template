import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {authRoute,globeUser,digest} from '../src/server/globe-auth';
test('SSO rejects missing/mismatched state, consumes codes once, enforces revocation and logout origin',async()=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2025-04-01',d1Databases:['DB']});
  try {
    const db=await mf.getD1Database('DB');
    await db.exec('CREATE TABLE address(id INTEGER PRIMARY KEY,name TEXT,password TEXT);\nCREATE TABLE nav_sessions(token_hash TEXT PRIMARY KEY,address_id INTEGER,password_version TEXT,expires_at INTEGER);\nCREATE TABLE globe_tickets(token_hash TEXT PRIMARY KEY,session_hash TEXT,state TEXT,expires_at INTEGER);\nCREATE TABLE globe_sessions(token_hash TEXT PRIMARY KEY,session_hash TEXT,expires_at INTEGER);');
    const state='a'.repeat(64),code='b'.repeat(48),nav='c'.repeat(64),future=Math.floor(Date.now()/1000)+600;
    await db.prepare('INSERT INTO address VALUES(1,?,?)').bind('fixture@ionacs.com','fixture-password-hash').run();
    await db.prepare('INSERT INTO nav_sessions VALUES(?,1,?,?)').bind(nav,await digest('fixture-password-hash'),future).run();
    await db.prepare('INSERT INTO globe_tickets VALUES(?,?,?,?)').bind(await digest(code),nav,state,future).run();
    const callback=(cookie:string)=>new Request('https://ionize.club/auth/callback?state='+state+'&code='+code,{headers:{Cookie:cookie}});
    assert.equal((await authRoute(callback(''),db))?.status,400);
    assert.equal((await authRoute(callback('__Host-ionize_state='+'d'.repeat(64)),db))?.status,400);
    const responses=await Promise.all([authRoute(callback('__Host-ionize_state='+state),db),authRoute(callback('__Host-ionize_state='+state),db)]);
    assert.deepEqual(responses.map(r=>r?.status).sort(),[302,401]);
    const token=responses.find(r=>r?.status===302)!.headers.get('set-cookie')!.match(/__Host-ionize_session=([a-f0-9]+)/)![1];
    const req=new Request('https://ionize.club/api/globe/me',{headers:{Cookie:'__Host-ionize_session='+token}});
    assert.deepEqual(await globeUser(req,db),{email:'fixture@ionacs.com'});
    assert.equal(await globeUser(new Request(req.url),db),null);
    const forged=new Request('https://ionize.club/api/globe/logout',{method:'POST',headers:{Cookie:req.headers.get('Cookie')!,Origin:'https://evil.example'}});
    assert.equal((await authRoute(forged,db))?.status,403);
    await db.prepare('UPDATE address SET password=? WHERE id=1').bind('changed-password').run();
    assert.equal(await globeUser(req,db),null);
    await db.prepare('UPDATE address SET password=? WHERE id=1').bind('fixture-password-hash').run();
    await db.prepare('DELETE FROM nav_sessions').run();
    assert.equal(await globeUser(req,db),null);
  }finally{await mf.dispose();}
});
