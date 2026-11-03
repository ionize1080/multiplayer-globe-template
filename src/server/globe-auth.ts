const cookieName = '__Host-ionize_session';
const now = () => Math.floor(Date.now()/1000);
export const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');
export const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
const cookieValue = (req: Request,name: string) => (req.headers.get('Cookie')||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1)||'';
const cookie = (name: string,value: string,age: number) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const headers = {'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'};
export async function globeUser(req: Request,db: D1Database) {
  const token=cookieValue(req,cookieName);
  if(!/^[a-f0-9]{64}$/.test(token))return null;
  const row=await db.prepare(`SELECT a.name,a.password,n.password_version FROM globe_sessions g JOIN nav_sessions n ON n.token_hash=g.session_hash JOIN address a ON a.id=n.address_id WHERE g.token_hash=? AND g.expires_at>? AND n.expires_at>?`).bind(await digest(token),now(),now()).first<{name:string,password:string,password_version:string}>();
  return row && await digest(row.password||'')===row.password_version ? {email:row.name} : null;
}
export async function authRoute(req: Request,db: D1Database): Promise<Response|null> {
  const url=new URL(req.url);
  if(url.pathname==='/api/globe/me')return Response.json({user:await globeUser(req,db)},{headers});
  if(url.pathname==='/auth/login' && req.method==='GET') {
    const state=randomToken();
    return new Response(null,{status:302,headers:{...headers,Location:'https://ionacs.com/api/globe-authorize?state='+state,'Set-Cookie':cookie('__Host-ionize_state',state,600)}});
  }
  if(url.pathname==='/auth/callback' && req.method==='GET') {
    const state=url.searchParams.get('state')||'',code=url.searchParams.get('code')||'';
    if(!/^[a-f0-9]{64}$/.test(state)||state!==cookieValue(req,'__Host-ionize_state')||!/^[a-f0-9]{48}$/.test(code))return new Response('登录验证失败，请重新登录',{status:400,headers});
    const row=await db.prepare('DELETE FROM globe_tickets WHERE token_hash=? AND state=? AND expires_at>? RETURNING session_hash').bind(await digest(code),state,now()).first<{session_hash:string}>();
    if(!row)return new Response('登录凭证已过期，请重新登录',{status:401,headers});
    const token=randomToken();
    await db.prepare('INSERT INTO globe_sessions VALUES(?,?,?)').bind(await digest(token),row.session_hash,now()+86400).run();
    const response=new Response(null,{status:302,headers:{...headers,Location:'/?explore=1','Set-Cookie':cookie(cookieName,token,86400)}});
    response.headers.append('Set-Cookie',cookie('__Host-ionize_state','',0));return response;
  }
  if(url.pathname==='/api/globe/logout' && req.method==='POST') {
    if(req.headers.get('Origin')!==url.origin)return new Response('Forbidden',{status:403,headers});
    await db.prepare('DELETE FROM globe_sessions WHERE token_hash=?').bind(await digest(cookieValue(req,cookieName))).run();
    return Response.json({ok:true},{headers:{...headers,'Set-Cookie':cookie(cookieName,'',0)}});
  }
  return null;
}
