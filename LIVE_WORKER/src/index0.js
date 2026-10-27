import { DurableObject } from 'cloudflare:workers';

const json = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'https://ligasdetenis.github.io'}});
const validId = id => /^[a-zA-Z0-9_-]{1,80}$/.test(id || '');

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null,{status:204,headers:{'access-control-allow-origin':'https://ligasdetenis.github.io','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type,authorization'}});
    if(url.pathname === '/health') return json({ok:true,service:'ct-campeador-live-produccion',websocket:true});
    const m = url.pathname.match(/^\/api\/match\/([^/]+)(\/ws)?$/);
    if(!m || !validId(m[1])) return json({error:'Ruta no encontrada'},404);
    // Solo las acciones mutantes requieren permiso. Lectura/WebSocket son públicos.
    if (req.method === 'POST' && !m[2]) {
      const bearer = (req.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
      if (!bearer) return json({error:'Entra en la liga oficial con tu PIN para controlar el marcador.'},401);
      if (!env.API_PRODUCCION) return json({error:'Falta Service Binding API_PRODUCCION en LIVE Worker.'},503);
      let permission;
      try {
        const resp = await env.API_PRODUCCION.fetch('https://api.internal/', {
          method:'POST',
          headers:{'content-type':'application/json','authorization':'Bearer '+bearer},
          body:JSON.stringify({action:'liveAuthorization',matchKey:m[1]})
        });
        permission = await resp.json();
        if (!resp.ok || !permission.ok) return json({error:permission.error||'Sesión no válida'},resp.status===401?401:403);
        if (!permission.canControl) return json({error:'Solo los dos jugadores de este partido pueden modificar el tanteo.'},403);
      } catch(e) { return json({error:'No se pudo validar la sesión de producción.'},503); }
      // Identidad de los participantes obtenida exclusivamente de la API de producción.
      let body;
      try {body=await req.json()}catch{return json({error:'JSON inválido'},400)}
      if (body.action==='start') body.names=permission.names;
      const forwarded = new Request('https://internal'+url.pathname, {
        method:'POST', headers:{'content-type':'application/json','x-live-validated':'1'},
        body:JSON.stringify(body)
      });
      const stub = env.LIVE_MATCH.get(env.LIVE_MATCH.idFromName(m[1]));
      return stub.fetch(forwarded);
    }
    const stub = env.LIVE_MATCH.get(env.LIVE_MATCH.idFromName(m[1]));
    const forward = new Request('https://internal'+url.pathname+url.search, req);
    return stub.fetch(forward);
  }
};

const initial = () => ({version:0, status:'not_started', names:['Jugador A','Jugador B'], firstServer:0, server:0, sets:[[],[]], games:[0,0], points:[0,0], phase:'normal', winner:null, history:[], updatedAt:null});
const clone = value => structuredClone(value);
const winnerAt = (a,b,target) => Math.max(a,b)>=target && Math.abs(a-b)>=2 ? (a>b?0:1) : null;
const pointsText = (p,q) => {
  if (p>=3 && q>=3) return p===q?'40':p>q?'AD':'40';
  return ['0','15','30','40'][Math.min(p,3)];
};
function advance(s,who){
  if(s.status!=='live') throw Error('Partido no iniciado o finalizado');
  s.points[who]++;
  if(s.phase==='normal') {
    const w=winnerAt(...s.points,4);
    if(w!==null){
      s.games[w]++; s.points=[0,0]; s.server=1-s.server;
      const sw=winnerAt(...s.games,6);
      if(s.games[0]===6 && s.games[1]===6){ s.phase='tiebreak'; s.tiebreakFirstServer=s.server; s.tbPointsPlayed=0; }
      else if(sw!==null && (Math.min(...s.games)<=4 || (Math.max(...s.games)===7 && Math.min(...s.games)===5))) completeSet(s,sw);
    }
  } else {
    s.tbPointsPlayed=(s.tbPointsPlayed||0)+1;
    const w=winnerAt(...s.points,s.phase==='super' ? 10 : 7);
    if(w!==null){
      if(s.phase==='super'){
        s.sets[w].push(s.points[w]); s.sets[1-w].push(s.points[1-w]);
        s.winner=w; s.status='finished';
      }else{
        s.games[w]++; completeSet(s,w);
      }
    }else{
      const n=s.tbPointsPlayed;
      s.server=((Math.floor((n+1)/2) % 2) === 0) ? s.tiebreakFirstServer : 1-s.tiebreakFirstServer;
    }
  }
}
function completeSet(s,w){
  const previousPhase=s.phase;
  s.sets[0].push(s.games[0]);s.sets[1].push(s.games[1]);
  const wins=[0,1].map(i=>s.sets[i].slice(0,2).filter((g,j)=>g>s.sets[1-i][j]).length);
  s.games=[0,0];s.points=[0,0];
  if(wins[w]===2){ s.winner=w;s.status='finished'; s.phase='finished'; return; }
  s.phase=(s.sets[0].length===2) ? 'super' : 'normal';
  if(previousPhase==='tiebreak') s.server=1-s.tiebreakFirstServer;
  s.tbPointsPlayed=0;
  if(s.phase==='super'){s.tiebreakFirstServer=s.server;}
}
export class LiveMatch extends DurableObject {
  constructor(ctx,env){ super(ctx,env); this.ctx=ctx;this.env=env; }
  async getState(){return (await this.ctx.storage.get('state'))||initial();}
  async save(s){s.version++;s.updatedAt=new Date().toISOString();await this.ctx.storage.put('state',s);this.broadcast(s);}
  broadcast(s){ const payload=JSON.stringify({type:'state',state:this.publicState(s)});for(const ws of this.ctx.getWebSockets()){try{ws.send(payload)}catch{}} }
  publicState(s){const {history,...publicData}=s;return {...publicData,pointLabels:s.phase==='normal'?[pointsText(s.points[0],s.points[1]),pointsText(s.points[1],s.points[0])]:s.points};}
  async fetch(req){
    const url=new URL(req.url);const ws=url.pathname.endsWith('/ws');
    if(ws){
      if(req.headers.get('Upgrade')?.toLowerCase()!=='websocket') return json({error:'Se requiere WebSocket'},426);
      const pair=new WebSocketPair();const client=pair[0],server=pair[1];this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({type:'state',state:this.publicState(await this.getState())}));
      return new Response(null,{status:101,webSocket:client});
    }
    if(req.method==='GET')return json({ok:true,state:this.publicState(await this.getState())});
    if(req.method!=='POST')return json({error:'Método no permitido'},405);
    let body;try{body=await req.json()}catch{return json({error:'JSON inválido'},400)}
    // El Worker exterior ya verificó la sesión y la participación en este partido.
    if(req.headers.get('x-live-validated')!=='1')return json({error:'No autorizado'},401);
    try{
      const result=await this.ctx.blockConcurrencyWhile(async()=>{
        const s=await this.getState();
        if(body.action==='start'){
          if(s.status!=='not_started')throw Error('Este partido ya ha comenzado');
          if(!Array.isArray(body.names)||body.names.length!==2||body.names.some(x=>typeof x!=='string'||!x.trim()||x.length>80))throw Error('Nombres inválidos');
          if(body.firstServer!==0 && body.firstServer!==1)throw Error('Sacador inicial inválido');
          Object.assign(s,initial(),{names:body.names.map(x=>x.trim()),firstServer:body.firstServer,server:body.firstServer,status:'live'});
        }else if(body.action==='reset'){
          // Solo accesible desde POST validado por la API TEST (jugadores del partido).
          if(s.status==='not_started')throw Error('El marcador ya está reiniciado');
          const names=Array.isArray(s.names)&&s.names.length===2?s.names:['Jugador A','Jugador B'];
          const oldVersion=s.version;
          Object.assign(s,initial(),{version:oldVersion,names});
        }else if(body.action==='point'){
          if(body.who!==0&&body.who!==1)throw Error('Jugador inválido');
          if(s.history.length>=10000)throw Error('Historial completo');
          s.history.push(clone({...s,history:[]}));advance(s,body.who);
        }else if(body.action==='undo'){
          if(s.history.length===0)throw Error('No hay puntos que deshacer');
          const before=s.history.pop();const history=s.history;Object.assign(s,before,{history});
        }else throw Error('Acción no reconocida');
        await this.save(s);return this.publicState(s);
      });
      return json({ok:true,state:result});
    }catch(e){return json({error:e.message||'Error'},400)}
  }
  async webSocketMessage(ws,message){
    // Los espectadores no pueden modificar resultados por WebSocket.
    try{const data=JSON.parse(message);if(data.type==='ping')ws.send(JSON.stringify({type:'pong'}));}catch{}
  }
  async webSocketClose(ws,code,reason){try{ws.close(code,reason)}catch{}}
  async webSocketError(ws){try{ws.close(1011,'Error')}catch{}}
}
