/* ============================================================
   SETU — indent & work order approvals, web app on Supabase
   The browser never decides anything. It reads what row level
   security lets it see, and every change is a database function
   that enforces the rules itself.
   ============================================================ */

/* implicit flow: a password-reset link must work in whatever browser opens it, which on a
   phone is usually not the one that asked for it (the SETU app asks, the email app opens Chrome) */
const SB = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {auth:{flowType:'implicit',detectSessionInUrl:true,persistSession:true}});
const APP_URL = location.origin + location.pathname;   // where reset links come back to

/* ---------- utilities ---------- */
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>(n===''||n==null||isNaN(n))?'—':'₹'+Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtDT=t=>t?new Date(t).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
const fmtT=t=>t?new Date(t).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):'—';
const fmtD=t=>t?new Date(t).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}):'—';
const inits=n=>String(n||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();
const DAY=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});   // matches ist_today() in the database
const daysBetween=(a,b)=>Math.max(0,Math.round((b-a)/864e5));
const ts=s=>s?new Date(s).getTime():null;
function toISO(d){
  if(!d) return '';
  const m=String(d).trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if(m) return m[3]+'-'+m[2]+'-'+m[1];
  const m2=String(d).trim().match(/^(\d{2})-([A-Za-z]{3})-(\d{4})/);
  if(m2){const mm={JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12'}[m2[2].toUpperCase()];
    if(mm) return m2[3]+'-'+mm+'-'+m2[1]}
  return '';
}
const numOf=s=>{const m=String(s||'').replace(/,/g,'').match(/-?\d+(\.\d+)?/);return m?Number(m[0]):''};
const tidy=s=>String(s||'').replace(/,\s*,/g,', ').replace(/\s*,\s*/g,', ').replace(/,\s*$/,'').replace(/\s+/g,' ').trim();

/* ---------- state ---------- */
let DB={users:[],requests:[],audit:[],templates:[],departments:[],projects:[],notifs:[],passes:[],flows:[],units:[]};
let STATIONS=[], ME=null, ROUTE={name:'dash'};
const byCode=new Map(), byName=new Map();
function indexStations(){ byCode.clear(); byName.clear();
  STATIONS.forEach(s=>{byCode.set(s.code.toUpperCase(),s);byName.set(s.name.toLowerCase(),s)}) }

let skipPop=false;   // set when a dialog rewinds its own history entry, so the router ignores that one pop
/* ---------- toast / modal ---------- */
function toast(m,k){const t=document.createElement('div');t.className='toast '+(k||'');t.textContent=m;$('#toasts').appendChild(t);
  setTimeout(()=>{t.style.transition='opacity .3s';t.style.opacity='0';setTimeout(()=>t.remove(),320)},3600)}
function modal({title,body,footer,cls,onOpen,sticky}){
  const v=document.createElement('div');v.className='veil';
  v.innerHTML='<div class="modal '+(cls||'')+'"><div class="h"><h3>'+esc(title)+'</h3>'+(sticky?'':'<button class="btn ghost sm" data-x>Close</button>')+'</div>'+
    '<div class="c">'+body+'</div>'+(footer?'<div class="f">'+footer+'</div>':'')+'</div>';
  $('#modal-root').appendChild(v);
  const mid=uid(); let armed=false;
  const onPop=()=>{ v.remove(); window.removeEventListener('popstate',onPop) };
  const close=()=>{ v.remove(); window.removeEventListener('popstate',onPop);
    if(armed&&history.state&&history.state.mid===mid){ skipPop=true; history.back() } };
  // A sticky dialog cannot be dismissed — no outside-tap, no Escape, no back button, no history
  // entry (the history/keyboard interplay on Android could otherwise drop it). It closes only in code.
  if(!sticky){
    /* the dialog is a history entry so the phone's back button closes it — but if another dialog
       just closed, its rewind is still in flight; arm only after that has landed, or this dialog
       would mistake the rewind for a back press and close itself immediately */
    const arm=()=>{ if(!v.isConnected) return; try{ history.pushState(Object.assign({},history.state||ROUTE,{modal:true,mid}),'') }catch(e){}
      window.addEventListener('popstate',onPop); armed=true };
    if(skipPop) window.addEventListener('popstate',()=>setTimeout(arm,0),{once:true}); else arm();
    v.addEventListener('click',e=>{if(e.target===v||e.target.hasAttribute('data-x'))close()});
    document.addEventListener('keydown',function k(e){if(e.key==='Escape'){close();document.removeEventListener('keydown',k)}});
  }
  if(onOpen)onOpen(v,close); return {el:v,close};
}
/* every failed call surfaces its reason; the database writes them to be read */
const fail=e=>{const m=(e&&(e.message||e.error_description||e.hint))||'Something went wrong.';toast(m.replace(/^.*?: /,''),'bad');console.error(e)};
async function rpc(fn,args){const {data,error}=await SB.rpc(fn,args||{}); if(error) throw error; return data}
let busyTimer=null;
function busy(on){let v=$('#busy');
  if(on){ if(!v){v=document.createElement('div');v.id='busy';v.className='busy-veil';v.innerHTML='<span class="spin"></span>';document.body.appendChild(v)}
    clearTimeout(busyTimer); busyTimer=setTimeout(()=>{const x=$('#busy'); if(x)x.remove()},15000); }  // never let the veil lock the screen
  else { clearTimeout(busyTimer); if(v)v.remove(); } }

/* A full-screen "Signing you in…" splash shown while a saved session is being
   restored, so the sign-in page never flashes (and can't be tapped) during the
   wait and the person can see that something is happening. */
function showSplash(msg){
  let v=document.getElementById('splash');
  if(!v){
    v=document.createElement('div'); v.id='splash';
    v.style.cssText='position:fixed;inset:0;z-index:120;display:grid;place-items:center;background:linear-gradient(160deg,#0c3aa6,#0a2c78);transition:opacity .25s';
    v.innerHTML='<div style="text-align:center;color:#fff">'
      +'<div style="font-weight:800;letter-spacing:.34em;font-size:26px;margin-bottom:16px">S E T U</div>'
      +'<div style="display:flex;align-items:center;gap:9px;justify-content:center;opacity:.92">'
      +'<span class="spin" style="border-color:rgba(255,255,255,.35);border-top-color:#fff"></span>'
      +'<span id="splash-msg" style="font-size:14px"></span></div></div>';
    document.body.appendChild(v);
  }
  const m=document.getElementById('splash-msg'); if(m) m.textContent=msg||'Signing you in…';
  v.style.display='grid'; v.style.opacity='1';
}
function hideSplash(){ const v=document.getElementById('splash'); if(!v) return;
  v.style.opacity='0'; setTimeout(()=>{ const x=document.getElementById('splash'); if(x) x.remove() },260); }

/* ============================================================
   Loading everything this person is allowed to see
   ============================================================ */
/* Fetch every row of a table in 1000-row pages, so tables that can grow past the
   API's default row cap (the flow sub-tables) load in full rather than silently
   truncating. Page size sits at the cap, so it works whatever the project limit is. */
async function pageAll(table,orderCol,ascending){
  const size=1000; let from=0; const out=[];
  for(;;){
    let qb=SB.from(table).select('*');
    if(orderCol) qb=qb.order(orderCol,{ascending:ascending!==false});
    const {data,error}=await qb.range(from,from+size-1);
    if(error) throw error;
    if(data&&data.length) out.push(...data);
    if(!data||data.length<size) break;
    from+=size;
  }
  return out;
}
/* ---------- data loading, in slices (keeps Supabase data-transfer low) ----------
   Every phone used to re-download EVERYTHING (all profiles, all flows, all gate
   passes) on every change anyone made, and again each time the app came to the
   front — that pushed the project over its free data-transfer quota. Now:
     people : profiles, departments, projects, stations, templates (+usage for admins)
     legacy : chain requests, steps, tasks, files, notes, audit
     flows  : ALDS flows — or only the flows that changed
     gate   : gate passes            notif : my notifications
   A full load happens at sign-in and after your own edits. A live change touches
   only its slice, and gate passes / notifications are applied straight from the
   live event with no download at all. */
const LOAD_PARTS=['people','legacy','flows','gate','notif'];
const DATA_PARTS=['legacy','flows','gate','notif'];
let lastLoadAt=0;
const gateScopeOnly=()=>!!(ME&&ME.name&&(GATE_ONLY()||HR_HEAD()));   // sees only the gate pages
async function load(parts,flowIds){
  const P=new Set(parts&&parts.length?parts:LOAD_PARTS);
  if(P.has('people')){ P.delete('people'); await loadPeople(); const me=DB.users.find(u=>u.id===(ME&&ME.id)); if(me) ME=me; }
  // Gate-Pass-only and HR-Head accounts only ever see the gate pages — don't download
  // every flow and request for them (500+ such accounts)
  if(gateScopeOnly()){ P.delete('legacy'); P.delete('flows'); DB.requests=[]; DB.flows=[]; DB.audit=[]; }
  const jobs=[];
  if(P.has('legacy')) jobs.push(loadLegacy());
  if(P.has('flows'))  jobs.push((flowIds&&flowIds.length&&flowIds.length<=8&&DB.flows.length)?loadFlowsSome(flowIds):loadFlows());
  if(P.has('gate'))   jobs.push(loadGate());
  if(P.has('notif'))  jobs.push(loadNotifs());
  await Promise.all(jobs);
  lastLoadAt=Date.now();
  const me=DB.users.find(u=>u.id===(ME&&ME.id));
  if(me) ME=me;
  // wipe gate selfies older than a week: remove my own old selfie files, then drop the references
  if(!load._expired){ load._expired=true; gpExpireSweep(); }
}
async function loadPeople(){
  const r=await Promise.all([
    SB.from('profiles').select('*'),
    SB.from('templates').select('*').order('name'),
    SB.from('departments').select('name').order('name'),
    SB.from('projects').select('name').order('name'),
    SB.from('stations').select('*').order('name'),
    SB.from('units').select('name').order('name')
  ]);
  const bad=r.slice(0,5).find(x=>x.error); if(bad) throw bad.error;   // units is optional (table may not exist before migration 71)
  const [prof,tpl,dept,proj,st]=r.slice(0,5).map(x=>x.data||[]);
  const unit=(r[5]&&!r[5].error&&r[5].data)?r[5].data:[];
  DB.users=prof.map(p=>({id:p.id,name:p.name,email:p.email,empId:p.emp_id||'',role:p.role||'',dept:p.dept||'',assistsId:p.assists_id||null,
    admin:p.is_admin,owner:!!p.is_owner,manager:p.is_manager,seeAll:p.see_all,gateman:!!p.gateman,gateOnly:!!p.gate_only,hrHead:!!p.hr_head,active:p.active,mustChange:!!p.must_change_password,pages:Array.isArray(p.pages)?p.pages:null,
    canCreateUsers:!!p.can_create_users,canManageUsers:!!p.can_manage_users,unit:p.unit||'',deptsVisible:Array.isArray(p.depts_visible)?p.depts_visible:[],garudaAccess:!!p.garuda_access,garudaStore:!!p.garuda_store,garudaSite:!!p.garuda_site,
    managerId:p.manager_id,managerConfirmed:p.manager_confirmed,pinDate:p.pin_date,
    stats:{lastLogin:ts(p.last_login),logins:p.logins||0,activeMs:Number(p.active_ms)||0,daily:{}}}));
  DB.templates=tpl.map(t=>({id:t.id,name:t.name,ownerId:t.owner_id,shared:t.shared,steps:t.steps||[],createdAt:ts(t.created_at)}));
  DB.departments=dept.map(d=>d.name);
  DB.units=unit.map(u=>u.name);
  DB.projects=proj.map(p=>p.name);
  STATIONS=st.map(s=>({code:s.code,name:s.name,state:s.state||''})); indexStations();
}
// The day-by-day usage history (up to 533 users × ~92 days) is only ever shown on the
// owner-only Usage / System overview pages — never on sign-in — so it is loaded lazily
// when one of those pages opens, not during login.
async function loadUsage(){
  if(DB._usageLoaded) return;
  if(!(ME&&(ME.admin||ME.seeAll||ME.owner))) return;
  const since=new Date(Date.now()-92*864e5).toISOString().slice(0,10);
  const {data:usage,error}=await SB.from('usage_daily').select('*').gte('day',since);
  if(error) return;
  const U={}; DB.users.forEach(u=>U[u.id]=u);
  (usage||[]).forEach(x=>{const u=U[x.user_id]; if(u) u.stats.daily[x.day]=Number(x.active_ms)||0});
  DB._usageLoaded=true;
}
function ensureUsage(){ if(DB._usageLoaded) return;
  loadUsage().then(()=>{ if((ROUTE.name==='usage'||ROUTE.name==='overview')&&!document.querySelector('.veil')) render(); }); }
async function loadLegacy(){
  const r=await Promise.all([
    SB.from('requests').select('*').order('created_at',{ascending:false}),
    SB.from('steps').select('*').order('position'),
    SB.from('tasks').select('*').order('assigned_at'),
    SB.from('files').select('*').order('created_at'),
    SB.from('notes').select('*').order('created_at'),
    SB.from('audit').select('*').order('created_at',{ascending:false}).limit(500)
  ]);
  const bad=r.find(x=>x.error); if(bad) throw bad.error;
  const [req,steps,tasks,files,notes,audit]=r.map(x=>x.data||[]);
  const R={};
  DB.requests=req.map(x=>R[x.id]={id:x.id,ref:x.ref,type:x.type,requesterId:x.requester_id,status:x.status,
    current:x.current_step,infoStep:x.info_step,infoTo:x.info_to,infoTos:x.info_tos||[],infoReplies:x.info_replies||[],f:x.fields||{},createdAt:ts(x.created_at),closedAt:ts(x.closed_at),
    chain:[],files:[],notes:[]});
  const S={};
  steps.forEach(s=>{const r=R[s.request_id]; if(!r) return;
    const step=S[s.id]={id:s.id,userId:s.user_id,status:s.status,remark:s.remark||'',condition:s.condition||'',
      systemApproved:!!s.system_approved,position:s.position,actedAt:ts(s.acted_at),
      erpDone:!!s.erp_done,erpDoneBy:s.erp_done_by,erpDoneAt:ts(s.erp_done_at),files:[],tasks:[]};
    r.chain[s.position]=step});
  const T={};
  tasks.forEach(t=>{const s=S[t.step_id]; if(!s) return;
    s.tasks.push(T[t.id]={id:t.id,userId:t.user_id,task:t.task,status:t.status,note:t.note||'',
      assignedAt:ts(t.assigned_at),closedAt:ts(t.closed_at),files:[]})});
  files.forEach(f=>{const rec={id:f.id,name:f.name,path:f.path,size:Number(f.size)||0};
    if(f.task_id&&T[f.task_id]) T[f.task_id].files.push(rec);
    else if(f.step_id&&S[f.step_id]) S[f.step_id].files.push(rec);
    else if(R[f.request_id]) R[f.request_id].files.push(rec)});
  notes.forEach(n=>{const r=R[n.request_id]; if(r) r.notes.push({id:n.id,userId:n.user_id,ts:ts(n.created_at),text:n.text})});
  DB.audit=audit.map(a=>({id:a.id,ts:ts(a.created_at),reqId:a.request_id,ref:a.ref,actorId:a.actor_id,actorName:a.actor_name,action:a.action,detail:a.detail||''}));
}
const mapPass=g=>({id:g.id,ref:g.ref,kind:g.kind,halfPart:g.half_part||'',employeeId:g.employee_id||'',name:g.emp_name||'',dept:g.dept||'',purpose:g.purpose||'',
    requesterId:g.requester_id,hodId:g.hod_id,hrId:g.hr_id,reqSelfie:g.requester_selfie,hodSelfie:g.hod_selfie,hrSelfie:g.hr_selfie,
    hodAt:ts(g.hod_at),hrAt:ts(g.hr_at),rejectBy:g.reject_by,rejectReason:g.reject_reason||'',rejectedAt:ts(g.rejected_at),
    gateBy:g.gate_by,outAt:ts(g.out_at),returnAt:ts(g.return_at),status:g.status,passDate:g.pass_date,createdAt:ts(g.created_at)});
const mapNotif=x=>({id:x.id,requestId:x.request_id,route:x.route||'',kind:x.kind,title:x.title,body:x.body||'',ts:ts(x.created_at),read:!!x.read_at});
async function loadGate(){
  // gate passes from the last 120 days (reports default to 30; selfies expire after 7)
  const since=new Date(Date.now()-120*864e5).toISOString();
  const {data,error}=await SB.from('gate_passes').select('*').gte('created_at',since).order('created_at',{ascending:false}).limit(3000);
  if(error) throw error;
  DB.passes=(data||[]).map(mapPass);
}
async function loadNotifs(){
  const {data,error}=await SB.from('notifications').select('*').order('created_at',{ascending:false}).limit(60);
  if(error) throw error;
  DB.notifs=(data||[]).map(mapNotif);
}
/* ALDS PO/WO flows: build the flow objects from their rows */
function buildFlows(freq,fsteps,factors,ffiles,faudit){
  const FR={};
  const list=freq.map(x=>FR[x.id]={id:x.id,ref:x.ref,head:x.head,division:x.division,department:x.department||(x.fields&&x.fields.department)||'ALDS',requesterId:x.requester_id,
    title:x.title||'',fields:x.fields||{},status:x.status,currentPos:x.current_pos,createdAt:ts(x.created_at),closedAt:ts(x.closed_at),
    steps:[],audit:[]});
  const FS={};
  fsteps.forEach(s=>{const f=FR[s.request_id]; if(!f) return;
    f.steps[s.pos]=FS[s.id]={id:s.id,pos:s.pos,stage:s.stage,substep:s.substep,label:s.label,actorKind:s.actor_kind,
      teamKey:s.team_key,action:s.action,needsFile:s.needs_file,needsDatetime:s.needs_datetime,fieldsSpec:s.fields_spec||[],
      canReject:s.can_reject,rejectTo:s.reject_to,escalatable:s.escalatable,cmdDual:!!s.cmd_dual,cmdTarget:!!s.cmd_target,status:s.status,systemApproved:!!s.system_approved,actedBy:s.acted_by,actedAt:ts(s.acted_at),
      canHold:!!s.can_hold,onHold:!!s.on_hold,holdReason:s.hold_reason||'',holdBy:s.hold_by,
      erpDone:!!s.erp_done,erpDoneBy:s.erp_done_by,erpDoneAt:ts(s.erp_done_at),
      remark:s.remark||'',datetimeVal:ts(s.datetime_val),dataVal:s.data_val,
      infoRequested:!!s.info_requested,infoText:s.info_text||'',infoBy:s.info_by,infoTo:s.info_to,infoTos:s.info_tos||[],infoReplies:s.info_replies||[],infoAt:ts(s.info_at),infoReply:s.info_reply||'',infoReplyAt:ts(s.info_reply_at),
      actors:[],files:[]}});
  factors.forEach(a=>{const s=FS[a.step_id]; if(s) s.actors.push(a.user_id)});
  ffiles.forEach(f=>{const s=FS[f.step_id]; const rec={id:f.id,name:f.name,path:f.path,size:Number(f.size)||0,by:f.uploaded_by,station:f.station||'',photoDate:f.photo_date||''};
    if(s) s.files.push(rec); else if(FR[f.request_id]) FR[f.request_id]._files=(FR[f.request_id]._files||[]).concat(rec)});
  faudit.forEach(a=>{const f=FR[a.request_id]; if(f) f.audit.push({ts:ts(a.created_at),actorName:a.actor_name,action:a.action,detail:a.detail||''})});
  list.forEach(f=>f.steps=f.steps.filter(Boolean));
  return list;
}
async function loadFlows(){
  // Flow sub-tables grow with every flow (steps × actors), so a single request
  // hits the API's 1000-row cap and newer flows come back with no actors — which
  // leaves their live step with no approver and no action button. Page through them.
  const [freq,fsteps,factors,ffiles,faudit]=await Promise.all([
    pageAll('flow_requests','created_at',false),
    pageAll('flow_steps','pos',true),
    pageAll('flow_step_actors','step_id',true),
    pageAll('flow_files','created_at',true),
    pageAll('flow_audit','created_at',false)
  ]);
  DB.flows=buildFlows(freq,fsteps,factors,ffiles,faudit);
}
/* re-fetch just these flows (a live change or your own action on one flow) and
   swap them into the list, instead of re-downloading every flow */
async function loadFlowsSome(ids){
  const r=await Promise.all([
    SB.from('flow_requests').select('*').in('id',ids),
    SB.from('flow_steps').select('*').in('request_id',ids).order('pos'),
    SB.from('flow_files').select('*').in('request_id',ids).order('created_at'),
    SB.from('flow_audit').select('*').in('request_id',ids).order('created_at',{ascending:false})
  ]);
  const bad=r.find(x=>x.error); if(bad) throw bad.error;
  const [freq,fsteps,ffiles,faudit]=r.map(x=>x.data||[]);
  const stepIds=fsteps.map(s=>s.id); let factors=[];
  if(stepIds.length){ const {data,error}=await SB.from('flow_step_actors').select('*').in('step_id',stepIds); if(error) throw error; factors=data||[]; }
  const fresh=buildFlows(freq,fsteps,factors,ffiles,faudit);
  DB.flows=DB.flows.filter(f=>ids.indexOf(f.id)<0).concat(fresh).sort((a,b)=>b.createdAt-a.createdAt);
}
async function gpExpireSweep(){
  try{
    const cut=Date.now()-7*864e5, paths=[];
    DB.passes.forEach(g=>{ if(g.requesterId===ME.id&&g.createdAt<cut){ [g.reqSelfie,g.hodSelfie,g.hrSelfie].forEach(p=>{ if(p) paths.push(p) }) } });
    if(paths.length){ try{ await SB.storage.from('documents').remove(withThumbs(paths)) }catch(e){} }
    await SB.rpc('gp_expire_photos');
  }catch(e){}
}
let reloadT=null, renderT=null, hiddenAt=0;
const pendingParts=new Set(), pendingFlowIds=new Set(); let pendingFlowsAll=false;
async function reload(parts,flowIds){ try{ await load(parts,flowIds); render(); paintNav(); paintPin() }catch(e){ fail(e) } }   // paintNav also repaints the tab bar
/* live changes are batched (2 s) and fetched only for the slice they touched; while
   the app is in the background nothing is fetched — it catches up when it returns */
function reloadSoon(parts,scopedFlows){
  (parts&&parts.length?parts:DATA_PARTS).forEach(p=>pendingParts.add(p));
  if(pendingParts.has('flows')&&!scopedFlows) pendingFlowsAll=true;
  if(document.hidden) return;
  clearTimeout(reloadT); reloadT=setTimeout(flushReload,2000);
}
function flushReload(){
  clearTimeout(reloadT);
  if(!ME||!pendingParts.size) return;
  if($('.veil')||$('#busy')){ reloadT=setTimeout(flushReload,3000); return; }   // don't redraw under an open dialog; retry shortly
  const parts=[...pendingParts]; pendingParts.clear();
  const ids=(!pendingFlowsAll&&pendingFlowIds.size)?[...pendingFlowIds]:null;
  pendingFlowIds.clear(); pendingFlowsAll=false;
  reload(parts,ids);
}
/* redraw without any download (a live event that carried its own data) */
function renderSoon(){
  if(document.hidden){ renderSoon._due=true; return; }
  clearTimeout(renderT);
  renderT=setTimeout(()=>{ if(!ME) return; if($('.veil')){ renderSoon(); return; } render(); paintNav(); paintPin(); },400);
}
/* live gate-pass change: the event already carries the row — apply it, no download */
function applyPassChange(p){
  try{
    if(p.eventType==='DELETE'){ const id=p.old&&p.old.id; if(!id) return reloadSoon(['gate']); DB.passes=DB.passes.filter(g=>g.id!==id); }
    else { const row=p.new; if(!row||!row.id||!row.status) return reloadSoon(['gate']);
      const g=mapPass(row), i=DB.passes.findIndex(x=>x.id===g.id);
      if(i>-1) DB.passes[i]=g; else DB.passes.unshift(g); }
    renderSoon();
  }catch(e){ reloadSoon(['gate']); }
}
/* live flow change: re-fetch only the flow it belongs to (a new flow, or anything
   we can't place, refreshes the whole flow list once) */
function flowChanged(p,table){
  const row=(p.new&&Object.keys(p.new).length)?p.new:(p.old||{});
  let fid=null;
  if(table==='flow_requests'&&p.eventType!=='INSERT') fid=row.id||null;
  else if(table==='flow_steps') fid=row.request_id||null;
  else if(table==='flow_step_actors'){ const x=row.step_id?flowFindStep(row.step_id):null; fid=x?x.f.id:null; }
  if(fid&&DB.flows.some(f=>f.id===fid)){ pendingFlowIds.add(fid); reloadSoon(['flows'],true); }
  else reloadSoon(['flows']);
}
const flowIdsOfStep=stepId=>{ const x=flowFindStep(stepId); return x?[x.f.id]:null; };

/* ---------- model helpers (read-only views over what was loaded) ---------- */
const user=id=>DB.users.find(u=>u.id===id)||{name:'Unknown',role:'',email:'',id:'',dept:''};
function holder(r){ if(r.status==='Approved'||r.status==='Rejected')return null;
  if(r.status==='Info Requested'){   // parked on an ask: it's with the tagged person (first not yet replied), else the requester
    const tg=infoTargets(r), pend=tg.filter(id=>!(r.infoReplies||[]).some(e=>(e.user_id||e.userId)===id));
    return tg.length?user((pend.length?pend:tg)[0]):user(r.requesterId); }
  const s=r.chain[r.current]; return s?user(s.userId):null }
const isMyTurn=r=>r.status==='In Progress'&&r.chain[r.current]&&r.chain[r.current].userId===ME.id;
// one reply per tagged person — did I already answer this ask?
const iReplied=repl=>Array.isArray(repl)&&repl.some(e=>(e.user_id||e.userId)===ME.id);
// the list of people a tag is directed at (supports old single-tag data)
const infoTargets=o=>(o&&o.infoTos&&o.infoTos.length)?o.infoTos:(o&&o.infoTo?[o.infoTo]:[]);
// the active tagged person = the first, in order, who has not yet replied (sequential tagging)
const legacyActiveTag=r=>{ const tg=infoTargets(r); if(!tg.length) return null; return tg.find(id=>!(r.infoReplies||[]).some(e=>(e.user_id||e.userId)===id))||null; };
const legacyTagged=r=>r&&r.status==='Info Requested'&&infoTargets(r).indexOf(ME.id)>-1;   // am I tagged on this (replied or not)
const needsMyInfo=r=>{ if(r.status!=='Info Requested') return false;
  const tg=infoTargets(r); return tg.length?(legacyActiveTag(r)===ME.id):(r.requesterId===ME.id); };
// the ordered "1. A ✓ → 2. B · now → 3. C → back to asker" chain, for a legacy request
function legacyTagChain(r){ const tg=infoTargets(r); if(tg.length<2) return '';
  const active=legacyActiveTag(r), rep=r.infoReplies||[], done=id=>rep.some(e=>(e.user_id||e.userId)===id);
  const chips=tg.map((id,i)=>{ const st=done(id)?'done':(id===active?'now':'next');
    return '<span class="tchain-chip tc-'+st+'">'+(i+1)+'. '+esc(user(id).name)+(st==='done'?' ✓':st==='now'?' · now':'')+'</span>'; });
  chips.push('<span class="tchain-chip tc-back">back to '+esc(user(r.chain[r.infoStep].userId).name)+'</span>');
  return '<div class="tchain" style="margin-top:7px">'+chips.join('<span class="tchain-arr">→</span>')+'</div>'; }
function legacyReplyThread(r){ const rep=r.infoReplies||[]; if(!rep.length) return '';
  return '<div class="cmt-thread" style="margin-top:8px">'+rep.map(e=>'<div class="cmt"><div class="cmt-h"><b>'+esc(e.name||user(e.user_id||e.userId).name)+'</b> <span class="hint">'+esc(e.at?fmtDT(ts(e.at)):'')+'</span></div><div class="cmt-b" style="white-space:pre-wrap">'+esc(e.text)+'</div></div>').join('')+'</div>'; }
const isManager=u=>!!(u&&(u.manager||u.admin||u.owner));
const teamOf=id=>DB.users.filter(u=>u.active&&u.managerId===id&&u.managerConfirmed);
const pendingTeam=id=>DB.users.filter(u=>u.active&&u.managerId===id&&!u.managerConfirmed);
const managers=()=>DB.users.filter(u=>u.active&&(u.manager||u.admin||u.owner));
const tasksOf=s=>(s&&s.tasks)||[];
const openTasks=s=>tasksOf(s).filter(t=>t.status==='open');
const stepBlocked=s=>openTasks(s).length>0;
const myOpenTask=r=>{ if(r.status!=='In Progress') return null; const s=r.chain[r.current]; if(!s) return null;
  const t=tasksOf(s).find(t=>t.userId===ME.id&&t.status==='open'); return t?{step:s,stepIndex:r.current,task:t}:null };
const myTasks=()=>DB.requests.filter(r=>myOpenTask(r));
const assignedIn=r=>r.chain.some(s=>tasksOf(s).some(t=>t.userId===ME.id));
const inChain=r=>r.requesterId===ME.id||r.chain.some(s=>s.userId===ME.id)||assignedIn(r);
const visible=()=>DB.requests.slice();          // the database already filtered to what this person may see
const myQueue=()=>DB.requests.filter(isMyTurn);
const myStuck=()=>DB.requests.filter(needsMyInfo);
// item 8 (legacy): requests I parked by asking someone — off my "Waiting on me", shown here until they reply
const legacyAwaiting=()=>DB.requests.filter(r=>r.status==='Info Requested'&&r.chain[r.infoStep]&&r.chain[r.infoStep].userId===ME.id&&!needsMyInfo(r));
function legacyAwaitingSection(){
  const list=legacyAwaiting(); if(!list.length) return '';
  return '<div class="card" style="margin-top:16px"><div class="row" style="padding:14px 18px;border-bottom:1px solid var(--line)"><h3>Awaiting reply — you asked someone</h3><span class="tag t-wait" style="margin-left:auto">'+list.length+'</span></div><table class="cards"><tbody>'+
    list.map(r=>{ const tg=infoTargets(r), pend=tg.filter(id=>!(r.infoReplies||[]).some(e=>(e.user_id||e.userId)===id)),
        who=tg.length?(pend.length?pend:tg).map(id=>user(id).name).join(', '):user(r.requesterId).name;
      return '<tr data-r="'+r.id+'" class="row-await"><td><b>'+esc(docTitle(r))+'</b><div class="hint">'+esc(typeLabel(r))+' · '+esc(r.ref)+'</div>'+
        '<div class="hint">Waiting on <b>'+esc(who)+'</b></div></td><td class="meta"><span class="tag t-wait">Awaiting reply</span></td></tr>'; }).join('')+
    '</tbody></table></div>';
}
const deptAt=(r,i)=>i<0?(user(r.requesterId).dept||''):(user(r.chain[i].userId).dept||'');
const docNo=r=>(r.type==='indent'?r.f.indentNo:r.f.orderNo)||'—';
const typeLabel=r=>r.type==='indent'?'Indent':'Work order';
const docTitle=r=>r.type==='indent'
  ? docNo(r)+(r.f.category==='Project'?(r.f.projectName?' · '+r.f.projectName:''):(r.f.siteName?' · '+r.f.siteName:''))
  : docNo(r)+(r.f.vendorName?' · '+r.f.vendorName:'');
const pinOK=u=>!!(u&&u.pinDate===DAY());
const myTemplates=()=>DB.templates.filter(t=>t.ownerId===ME.id||t.shared);

/* ---------- gate pass ---------- */
const isGateman=u=>!!(u&&(u.gateman||u.admin||u.owner));
const gpMine=()=>DB.passes.filter(g=>g.requesterId===ME.id);
const gpMyNext=()=>gpMine().filter(g=>g.status==='pending_hod'||g.status==='pending_hr');   // my passes awaiting a signature I must collect
const gpSignedByMe=()=>DB.passes.filter(g=>(g.hodId===ME.id&&g.hodAt)||(g.hrId===ME.id&&g.hrAt));   // passes I approved as HOD or HR
const gpMyRole=g=>g.hodId===ME.id?'HOD':(g.hrId===ME.id?'HR':'');
const gpCanDelete=g=>g.requesterId===ME.id&&['pending_hod','pending_hr','pending_gate'].includes(g.status);   // requester may delete until the gate acts
/* roles for the gate console / reports */
const HR_HEAD=()=>!!(ME&&ME.hrHead&&!ME.admin&&!ME.owner);
const canSeeReports=()=>!!(ME&&(ME.owner||ME.admin||ME.gateman||ME.hrHead));
const gateViewer=()=>!!(ME&&(isGateman(ME)||ME.hrHead||ME.admin||ME.owner));   // may see every entry (gateman clears, HR head/owner view)
const gpClearedToday=()=>DB.passes.filter(g=>g.passDate===DAY()&&g.status==='closed');   // everything closed at the gate today (any gateman), so nothing disappears from the console
const gpAllToday=()=>DB.passes.filter(g=>g.passDate===DAY());
const gpAtGate=()=>isGateman(ME)?DB.passes.filter(g=>(g.status==='pending_gate'||g.status==='out')&&g.passDate===DAY()&&g.requesterId!==ME.id):[];   // a gateman clears others, never their own pass
const gpBadge=()=>gpMyNext().length+gpAtGate().length;
const GP_KINDS=[['early','Early going'],['halfday','Half day leave'],['official','Outpass']];
const gpKindNote=k=>k==='early'?('Early-going passes left this month: <b>'+Math.max(0,2-gpEarlyUsed())+' of 2</b>. The gateman signs you out — you are not returning.')
  :k==='halfday'?'Half day leave — the gateman signs you out; you are not expected back today.'
  :'Outpass — the gateman records your out-time and, when you return, the time back. Not capped.';
const gpHalfLabel=h=>h==='1st'?'1st half':h==='2nd'?'2nd half':'';
const gpKindLabel=g=>{const isObj=(typeof g!=='string');const k=isObj?g.kind:g;const m=GP_KINDS.find(x=>x[0]===k);let lbl=m?m[1]:k;
  if(isObj&&k==='halfday'&&g.halfPart) lbl+=' ('+gpHalfLabel(g.halfPart)+')'; return lbl;};
const gpEarlyUsed=()=>{const m=DAY().slice(0,7);return gpMine().filter(g=>g.kind==='early'&&g.status!=='rejected'&&String(g.passDate).slice(0,7)===m).length};
const GP_STATUS={pending_hod:['t-wait','With HOD'],pending_hr:['t-wait','With HR'],pending_gate:['t-prog','Cleared — show the gate'],out:['t-hold','Out'],closed:['t-ok','Closed'],rejected:['t-bad','Declined']};
const gpTag=g=>{const x=GP_STATUS[g.status]||['t-wait',g.status];return '<span class="tag '+x[0]+'">'+x[1]+'</span>'};

/* ---------- org structure: departments, their divisions, and the ALDS auto-hierarchies ---------- */
const DEPT_DIV={
  'ALDS':['O&M','Project','Retail','Transport'],
  'PCD':['Project','Operation','Purchase'],
  'HO':['Admin','HO-CNG'],
  'CNG':['Maintenance','Logistics','Project','IT Department','Accounts','Operation','Sales & Marketing','Store','Liaison']
};
const DEPTS=Object.keys(DEPT_DIV);
/* the data-wall departments (home "unit"): from the units table, falling back to
   the built-in list before the table has loaded. ALDS is always first. */
const WALL_DEPTS=()=>{const t=(DB.units&&DB.units.length?DB.units.slice():DEPTS.slice());
  if(t.indexOf('ALDS')<0) t.unshift('ALDS'); return t.sort((a,b)=>a==='ALDS'?-1:b==='ALDS'?1:a.localeCompare(b));};
/* optional sub-categories under the indent Category. Leave a category's list
   empty and no sub-category dropdown shows. Add more here any time. */
const SUBCATEGORIES={
  'O&M':['Marketing & Branding','Automation'],
  'Project':[]
};
/* the approver chain (after the requester) for an ALDS indent/work order, keyed by who raises it */
const ORG_HIERARCHY={
  'manish kamdi':['Sanjay Palod','Chetan Bhoskar','Jatin Vora','Hardik','Jai Singhal','Jinesh Khara','Chetan Bhoskar','Jatin Vora','Jai Singhal','Prachi Khara','Manish Kamdi','Sanjay Palod','Jai Singhal'],
  'minakshi vyas':['Rakesh Sharma','Chetan Bhoskar','Jatin Vora','Hardik','Jai Singhal','Jinesh Khara','Chetan Bhoskar','Jatin Vora','Jai Singhal','Prachi Khara','Minakshi Vyas','Rakesh Sharma','Jai Singhal']
};
function findUserByName(name){
  const n=String(name||'').trim().toLowerCase(); if(!n) return null;
  let u=DB.users.find(x=>x.active&&x.name.trim().toLowerCase()===n);
  if(u) return u;
  const toks=n.split(/\s+/);
  return DB.users.find(x=>{const xn=x.name.trim().toLowerCase();return x.active&&toks.every(t=>xn.includes(t))})||null;
}

/* ---------- usage ---------- */
const statsOf=u=>u.stats||(u.stats={lastLogin:null,logins:0,activeMs:0,daily:{}});
const dayKey=off=>{const d=new Date(Date.now()-off*864e5);return d.toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'})};
const spanMs=(u,days)=>{const st=statsOf(u);let t=0;for(let i=0;i<days;i++)t+=st.daily[dayKey(i)]||0;return t};
const monthMs=u=>{const st=statsOf(u),pre=DAY().slice(0,7);let t=0;Object.keys(st.daily).forEach(k=>{if(k.indexOf(pre)===0)t+=st.daily[k]});return t};
const hms=ms=>{ms=Math.max(0,Math.round((ms||0)/1000));const h=Math.floor(ms/3600),m=Math.floor(ms%3600/60),x=ms%60;
  return String(h).padStart(2,'0')+'h '+String(m).padStart(2,'0')+'m '+String(x).padStart(2,'0')+'s'};
const activeToday=u=>(statsOf(u).daily[DAY()]||0)>0;
function workOf(u){ let raised=0,acted=0,tasks=0;
  DB.requests.forEach(r=>{ if(r.requesterId===u.id) raised++;
    r.chain.forEach(st=>{ if(st.userId===u.id&&st.actedAt&&st.status!=='pending'&&st.status!=='waiting') acted++;
      tasksOf(st).forEach(t=>{if(t.userId===u.id&&t.status!=='open')tasks++}) }) });
  return {raised,acted,tasks} }
const BEAT=30000;
setInterval(()=>{ if(ME&&document.visibilityState==='visible'&&navigator.onLine) SB.rpc('heartbeat',{p_ms:BEAT}) },BEAT);

/* ============================================================
   PDF reading — identical to the prototype, verified on both ERP documents
   ============================================================ */
if(window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
function groupLines(items){
  const sorted=items.slice().sort((a,b)=>a.y-b.y||a.x-b.x);
  const lines=[]; let cur=null;
  for(const it of sorted){
    if(!cur||Math.abs(it.y-cur.y)>3.5){ cur={y:it.y,items:[it]}; lines.push(cur) } else cur.items.push(it);
  }
  lines.forEach(l=>{ l.items.sort((a,b)=>a.x-b.x); l.text=l.items.map(i=>i.str).join(' ').replace(/\s+/g,' ').trim() });
  return lines.filter(l=>l.text);
}
const findLine=(lines,re)=>lines.find(l=>re.test(l.text));
function grab(lines,re,g){const l=findLine(lines,re);if(!l)return '';const m=l.text.match(re);return m?String(m[g||1]||'').trim():''}
function grabUntilGap(lines,lineRe,labelRe){
  const l=findLine(lines,lineRe); if(!l) return '';
  const its=l.items; let start=-1;
  for(let i=0;i<its.length;i++){ if(labelRe.test(String(its[i].str).trim())) start=i }
  if(start<0) return '';
  const out=[]; let prevEnd=null;
  for(let i=start+1;i<its.length;i++){
    const it=its[i], s=String(it.str).trim();
    if(!s) continue;
    if(s===':'){prevEnd=it.x+(it.w||0);continue}
    if(prevEnd!==null && it.x-prevEnd>26) break;
    if(/^[\d.,]+$/.test(s)&&out.length) break;
    if(/^Total\b/i.test(s)) break;
    out.push(s.replace(/^:\s*/,'')); prevEnd=it.x+(it.w||0);
  }
  return out.join(' ').replace(/\s+/g,' ').trim();
}
async function readPdf(blob){
  const pdf=await pdfjsLib.getDocument({data:await blob.arrayBuffer()}).promise;
  const page=await pdf.getPage(1), vp=page.getViewport({scale:1}), tc=await page.getTextContent();
  const items=tc.items.filter(i=>i.str&&i.str.trim()).map(i=>({str:i.str,x:i.transform[4],y:vp.height-i.transform[5],w:i.width||0}));
  const split=vp.width*0.49;
  return {all:groupLines(items),left:groupLines(items.filter(i=>i.x<split)),right:groupLines(items.filter(i=>i.x>=split)),width:vp.width};
}
const cutRight=s=>String(s||'').split(/\s+(?:Approved\s*Date|Indent\s*Date|Indent\s*No|Created\s*Date|Order\s*No|Amend\s*No|Party\s*Ref|Stock\s*Type|Delivery\s*Address)\b/i)[0].replace(/[,\s]+$/,'').trim();
function resolveSite(raw){
  if(!raw) return null;
  const code=(String(raw).match(/\(([A-Za-z]{2}\d{3})\)/)||[])[1];
  if(code&&byCode.has(code.toUpperCase())){const s=byCode.get(code.toUpperCase());return {code:s.code,name:s.name,state:s.state,how:'code',conf:'hi'}}
  const bare=String(raw).replace(/^\s*ALDS\s+STATION\s*-\s*/i,'').replace(/\s*\([^)]*\)\s*/g,'').replace(/[,\s]+$/,'').trim();
  const exact=byName.get(bare.toLowerCase());
  if(exact) return {code:exact.code,name:exact.name,state:exact.state,how:'name',conf:'hi'};
  const near=STATIONS.filter(x=>x.name.toLowerCase().includes(bare.toLowerCase())||bare.toLowerCase().includes(x.name.toLowerCase()));
  if(near.length===1) return {code:near[0].code,name:near[0].name,state:near[0].state,how:'near',conf:'mid'};
  return {code:'',name:bare,state:'',how:near.length>1?'ambiguous':'unmatched',conf:'mid'};
}
/* map an ERP division label to the SETU Department/Division taxonomy */
function detectOrg(out,conf,dept,rawDiv){
  const list=DEPT_DIV[dept]||[]; const key=String(rawDiv||'').toLowerCase().replace(/\s+/g,' ').trim();
  const alias={'o&m':'O&M','onm':'O&M','o and m':'O&M','retail':'Retail','project':'Project','transport':'Transport'};
  let div=list.find(x=>x.toLowerCase()===key)||alias[key]||list.find(x=>key.indexOf(x.toLowerCase())>-1);
  if(div&&list.indexOf(div)>-1){ out.department=dept; out.division=div; conf.department='hi'; conf.division='hi'; }
}
function parseIndent(doc){
  const L=doc.all, out={}, conf={};
  const no=grab(L,/Indent\s*No\.?\s*:?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/i); if(no){out.indentNo=no;conf.indentNo='hi'}
  const dt=grab(L,/Indent\s*Date\s*:?\s*(\d{2}-\d{2}-\d{4})/i); if(dt){out.indentDate=toISO(dt);conf.indentDate='hi'}
  // the ERP preparation stamp — date AND time (e.g. "Created Date : 05-JUN-2026 04:29 PM")
  const cr=grab(L,/Created\s*Date\s*:?\s*(\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}:\d{2}\s*[AP]\.?M\.?)/i);
  if(cr){out.erpCreated=cr.replace(/\s+/g,' ').replace(/\.?M\.?$/i,'M').toUpperCase();conf.erpCreated='hi'}
  // Department / Division off the ERP "Division : ALDS - <X> Division" line
  const dv=grab(L,/Division\s*:?\s*ALDS\s*-\s*([A-Za-z&/ ]+?)\s+Division/i);
  if(dv){ detectOrg(out,conf,'ALDS',dv.trim()); }
  let rm=grabUntilGap(L,/^\s*Remark\s*:/i,/^Remark$/i);
  if(!rm){const rl=findLine(L,/^\s*Remark\s*:/i); if(rl){const m=rl.text.match(/Remark\s*:\s*(.+?)(?=\s+[\d][\d.,]*\s|\s+Total\b|$)/i); if(m) rm=m[1].trim()}}
  if(rm){out.remarks=rm;conf.remarks='hi'}
  const cat=grab(L,/INDENT\s*-\s*ALDS\s+(O&M|Project)/i); if(cat) out.category=/project/i.test(cat)?'Project':'O&M';
  const cp=cutRight(grab(L,/Cost\/Project\s*:?\s*(.+)$/i));
  if(cp){ const site=resolveSite(cp); out._siteRaw=cp;
    if(site){out.siteCode=site.code;out.siteName=site.name;out.siteState=site.state;conf.site=site.conf;out._siteHow=site.how}
    if(!out.category) out.category=/ALDS\s+STATION/i.test(cp)?'O&M':'Project';
    if(out.category==='Project') out.projectName=cp.replace(/^\s*ALDS\s*/i,'ALDS ').trim() }
  return {fields:out,conf};
}
function parseWorkOrder(doc){
  const R=doc.right, Lt=doc.left, A=doc.all, out={}, conf={};
  const no=grab(R.concat(A),/Order\s*No\.?\s*:?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/i); if(no){out.orderNo=no;conf.orderNo='hi'}
  const ordLine=findLine(R,/Order\s*No\.?/i)||findLine(A,/Order\s*No\.?/i);
  if(ordLine){const d=(ordLine.text.match(/Date\s*:?\s*(\d{2}-\d{2}-\d{4})/i)||[])[1]; if(d){out.woDate=toISO(d);conf.woDate='hi'}}
  const wcr=grab(A,/Created\s*Date\s*:?\s*(\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}:\d{2}\s*[AP]\.?M\.?)/i);
  if(wcr){out.erpCreated=wcr.replace(/\s+/g,' ').replace(/\.?M\.?$/i,'M').toUpperCase();conf.erpCreated='hi'}
  const wdv=grab(A,/Division\s*:?\s*ALDS\s*-\s*([A-Za-z&/ ]+?)\s+Division/i);
  if(wdv){ detectOrg(out,conf,'ALDS',wdv.trim()); }
  const fp=cutRight(grab(R.concat(A),/File\/Project\s*:?\s*(.+)$/i));
  if(fp){ out._siteRaw=fp; const site=resolveSite(fp);
    if(site){out.siteCode=site.code;out.siteName=site.name;out.siteState=site.state;conf.site=site.conf;out._siteHow=site.how} }
  const tl=A.find(l=>/^Total\s*:/.test(l.text));
  if(tl){const n=numOf(tl.text.replace(/^Total\s*:?/i,''));if(n!==''){out.amountPre=n;conf.amountPre='hi'}}
  for(const l of A){const m=l.text.match(/Total\s*Order\s*Value\s+([\d,]+\.\d{2})/i); if(m){out.amountPost=numOf(m[1]);conf.amountPost='hi';break}}
  const iSup=Lt.findIndex(l=>/Details\s+of\s+Supplier/i.test(l.text)), iBill=Lt.findIndex(l=>/Billing\s+To\s+Address/i.test(l.text));
  if(iSup>-1){
    const end=iBill>iSup?iBill:Lt.length, blk=Lt.slice(iSup+1,end), addr=[];
    for(const l of blk){ if(/^(State Name|GSTIN|PAN No|Contact Detail)/i.test(l.text)) break; addr.push(l.text) }
    if(addr.length){ out.vendorName=addr[0]; conf.vendorName='hi'; if(addr.length>1){out.vendorAddress=tidy(addr.slice(1).join(' '));conf.vendorAddress='hi'} }
    const bt=blk.map(l=>l.text).join('\n');
    const st=(bt.match(/State\s*Name\s*:?\s*([A-Za-z ]+?)\s*(?:State\s*Code|$)/im)||[])[1]; if(st&&st.trim()){out.vendorState=st.trim();conf.vendorState='hi'}
    const sc=(bt.match(/State\s*Code\s*:?\s*(\d+)/i)||[])[1]; if(sc){out.vendorStateCode=sc;conf.vendorStateCode='hi'}
    const g=(bt.match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b/)||[])[1]; if(g){out.vendorGstin=g;conf.vendorGstin='hi'}
    const p=(bt.match(/PAN\s*No\.?\s*:?\s*([A-Z]{5}\d{4}[A-Z])/i)||[])[1]; if(p){out.vendorPan=p;conf.vendorPan='hi'}
    const c=(bt.match(/Contact\s*Detail\s*:?\s*(.+)/i)||[])[1]; if(c&&c.trim()){out.vendorContact=tidy(c);conf.vendorContact='hi'}
  }
  if(iBill>-1){ const blk=Lt.slice(iBill+1), addr=[];
    for(const l of blk){ if(/^(State Name|GSTIN|PAN No|Contact Detail|Sr\.?$|Description of Goods)/i.test(l.text)) break; addr.push(l.text) }
    if(addr.length){out.billingAddress=tidy(addr.join(' '));conf.billingAddress='hi'} }
  return {fields:out,conf};
}
async function parseDocument(blob,expect){
  const doc=await readPdf(blob), head=doc.all.slice(0,14).map(l=>l.text).join(' ');
  const type=/WORK\s*ORDER/i.test(head)?'workorder':(/\bINDENT\b/i.test(head)?'indent':expect);
  const res=type==='workorder'?parseWorkOrder(doc):parseIndent(doc); res.detected=type; return res;
}

/* ============================================================
   Files: uploaded straight into the person's own folder in the
   private bucket, then referenced by path when the request is made
   ============================================================ */
const extOf=n=>(String(n).split('.').pop()||'').toLowerCase();
const IMG_EXT=['jpg','jpeg','png','webp','heic','heif'], DOC_EXT=['pdf','xlsx','xls','csv','docx','doc'];
const kindOf=n=>{const e=extOf(n);return e==='pdf'?'pdf':(['xlsx','xls','csv'].includes(e)?'xls':(['docx','doc'].includes(e)?'doc':(IMG_EXT.includes(e)?'img':'oth')))};
const MAXMB=12;                       // a PDF, Excel or Word file, as uploaded
const IMG_EDGE=1600, IMG_QUALITY=0.72; // photos are shrunk to this before they leave the phone
const SUPPORT_MAX=10;                  // supporting files per request
const MIME={pdf:'application/pdf',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel',
  csv:'text/csv',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',doc:'application/msword',
  jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp'};
const kb=b=>b>=1048576?(b/1048576).toFixed(1)+' MB':(b/1024).toFixed(0)+' KB';

/* A phone photo is 3–8 MB; nobody needs that to read an invoice. Shrunk to
   1600px on the long edge and re-encoded as JPEG it is usually 150–400 KB —
   an order of magnitude less storage, and it uploads in a second on mobile data. */
async function compressImage(file){
  let bmp;
  try{ bmp=await createImageBitmap(file,{imageOrientation:'from-image'}) }
  catch(e1){ try{ bmp=await createImageBitmap(file) }
  catch(e){ throw new Error(file.name+' could not be read as an image. If it is an iPhone HEIC photo, change the camera setting to "Most compatible" or send it as JPEG.') } }
  const scale=Math.min(1,IMG_EDGE/Math.max(bmp.width,bmp.height));
  const c=document.createElement('canvas'); c.width=Math.round(bmp.width*scale); c.height=Math.round(bmp.height*scale);
  c.getContext('2d').drawImage(bmp,0,0,c.width,c.height); bmp.close&&bmp.close();
  const blob=await new Promise(res=>c.toBlob(res,'image/jpeg',IMG_QUALITY));
  if(!blob||blob.size>=file.size) return file;      // already small: keep the original untouched
  return new File([blob],file.name.replace(/\.[^.]+$/,'')+'.jpg',{type:'image/jpeg'});
}
async function uploadFile(file,kind){
  const original=file.size;
  if(kindOf(file.name)==='img') file=await compressImage(file);
  const safe=file.name.replace(/[^\w.\-]+/g,'_').slice(-80);
  const path=ME.id+'/'+uid()+'-'+safe;
  const {error}=await SB.storage.from('documents').upload(path,file,{contentType:MIME[extOf(file.name)]||file.type,upsert:false});
  if(error) throw error;
  return {id:uid(),name:file.name,path,size:file.size,kind:kind||'primary',original};
}
async function fetchFile(f){
  const {data,error}=await SB.storage.from('documents').download(f.path);
  if(error) throw error; return data;
}
function uploader(mount,list,opts){
  opts=opts||{};
  const support=opts.mode==='support';
  const allowed=support?DOC_EXT.concat(IMG_EXT):DOC_EXT;
  const accept=support?'.pdf,.xlsx,.xls,.csv,.docx,.doc,image/*':'.pdf,.xlsx,.xls,.csv,.docx,.doc';
  const paint=()=>{
    const total=list.reduce((t,f)=>t+f.size,0);
    mount.innerHTML='<div class="drop" tabindex="0" role="button">'+(opts.label||(support?'Add quotations, photos, Excel or Word — several at once is fine':'Attach the ERP document — PDF, Excel or Word'))+'</div>'+
      '<input type="file" class="hide" '+(opts.single?'':'multiple ')+'accept="'+accept+'"'+(support&&!opts.gallery?' capture="environment"':'')+'>'+
      '<div class="filelist">'+list.map(f=>'<div class="filerow"><span class="ft '+kindOf(f.name)+'">'+esc(kindOf(f.name)==='img'?'IMG':extOf(f.name).slice(0,4).toUpperCase())+'</span>'+
        '<div style="min-width:0;flex:1"><div style="font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(f.name)+'</div>'+
        '<div class="hint">'+kb(f.size)+(f.original&&f.original>f.size*1.5?' · shrunk from '+kb(f.original):'')+' · uploaded</div></div>'+
        '<button class="btn sm" data-v="'+f.id+'">View</button><button class="btn sm" data-rm="'+f.id+'">Remove</button></div>').join('')+'</div>'+
      (support&&list.length?'<div class="hint">'+list.length+' of '+SUPPORT_MAX+' files · '+kb(total)+' in total</div>':'');
    const inp=$('input',mount), drop=$('.drop',mount);
    drop.onclick=()=>inp.click();
    drop.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();inp.click()}};
    inp.onchange=async e=>{
      const fs=Array.from(e.target.files||[]); inp.value='';
      drop.classList.add('busy'); drop.innerHTML='<span class="spin"></span> Uploading…';
      for(const file of fs){
        const ext=extOf(file.name), isImg=IMG_EXT.includes(ext)||/^image\//.test(file.type);
        if(!allowed.includes(ext)&&!(support&&isImg)){toast(file.name+(support?' is not a photo, PDF, Excel or Word file.':' is not a PDF, Excel or Word file.'),'bad');continue}
        if(!isImg&&file.size>MAXMB*1048576){toast(file.name+' is over '+MAXMB+' MB.','bad');continue}
        if(support&&list.length>=SUPPORT_MAX){toast('Limit is '+SUPPORT_MAX+' supporting files per request.','bad');break}
        if(opts.single&&list.length>=1){toast('One ERP document per request. Anything else goes under supporting documents.','bad');break}
        try{ const rec=await uploadFile(file,support?'support':'primary'); rec._blob=file; list.push(rec); if(opts.onFile) await opts.onFile(file,rec) }
        catch(err){ fail(err) }
      }
      drop.classList.remove('busy'); paint(); if(opts.onChange)opts.onChange(list);
    };
    $$('[data-v]',mount).forEach(b=>b.onclick=()=>openViewer(list.find(x=>x.id===b.dataset.v)));
    $$('[data-rm]',mount).forEach(b=>b.onclick=()=>{const i=list.findIndex(x=>x.id===b.dataset.rm);if(i>-1)list.splice(i,1);paint();if(opts.onChange)opts.onChange(list)});
  };
  paint();
}
const filesPayload=list=>list.map(f=>({name:f.name,path:f.path,size:f.size,kind:f.kind||'primary'}));
function fileRow(f){
  const img=kindOf(f.name)==='img';
  return '<div class="filerow">'+(img?'<span class="ft img thumb" data-thumb="'+f.id+'">IMG</span>':'<span class="ft '+kindOf(f.name)+'">'+esc(extOf(f.name).slice(0,4).toUpperCase())+'</span>')+
    '<div style="min-width:0;flex:1"><div style="font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(f.name)+'</div><div class="hint">'+kb(f.size)+'</div></div>'+
    '<button class="btn sm" data-view="'+f.id+'">View</button></div>';
}
/* the ERP document first, then whatever was attached in support of it */
function fileListHTML(files){
  if(!files||!files.length) return '';
  const prim=files.filter(f=>f.kind!=='support'), sup=files.filter(f=>f.kind==='support');
  return '<div class="filelist">'+prim.map(fileRow).join('')+
    (sup.length?'<div class="hint" style="margin:6px 0 0">Supporting documents ('+sup.length+')</div>'+sup.map(fileRow).join(''):'')+'</div>';
}
const bindFiles=(scope,all)=>{
  $$('[data-view]',scope).forEach(b=>b.onclick=()=>openViewer(all.find(x=>x.id===b.dataset.view)));
  /* small previews for photos, fetched lazily so a page of PDFs costs nothing extra */
  $$('[data-thumb]',scope).forEach(async el=>{const f=all.find(x=>x.id===el.dataset.thumb); if(!f) return;
    try{ const blob=f._blob||await fetchFile(f); const url=URL.createObjectURL(blob);
      el.innerHTML='<img src="'+url+'" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:7px">'; el.style.padding='0' }catch(e){} });
};

async function openViewer(f){
  if(!f) return;
  const m=modal({title:f.name,cls:'viewer',body:'<div style="color:#fff;padding:40px"><span class="spin"></span> Opening…</div>',
    footer:'<span id="vf" class="hint" style="margin-right:auto"></span><span id="vz"></span><button class="btn sm" data-x>Close</button>'});
  const body=$('.c',m.el), foot=$('#vf',m.el), zone=$('#vz',m.el), k=kindOf(f.name);
  try{
    const blob=f._blob||await fetchFile(f);
    if(k==='pdf'){
      const pdf=await pdfjsLib.getDocument({data:await blob.arrayBuffer()}).promise; let scale=1.35;
      const draw=async()=>{ body.innerHTML='';
        for(let p=1;p<=pdf.numPages;p++){ const pg=await pdf.getPage(p), vp=pg.getViewport({scale});
          const c=document.createElement('canvas'); c.width=vp.width; c.height=vp.height; body.appendChild(c);
          await pg.render({canvasContext:c.getContext('2d'),viewport:vp}).promise } };
      await draw();
      foot.textContent=pdf.numPages+' page'+(pdf.numPages>1?'s':'')+' · viewing only';
      zone.innerHTML='<button class="btn sm" id="zo">−</button> <button class="btn sm" id="zi">+</button>';
      $('#zi',zone).onclick=async()=>{scale=Math.min(3,scale+.25);await draw()};
      $('#zo',zone).onclick=async()=>{scale=Math.max(.5,scale-.25);await draw()};
    } else if(k==='xls'){
      const wb=XLSX.read(await blob.arrayBuffer(),{type:'array'}); body.innerHTML='';
      wb.SheetNames.slice(0,6).forEach(n=>{const d=document.createElement('div');d.className='sheet';
        d.innerHTML='<h3 style="margin-bottom:10px">'+esc(n)+'</h3>'+XLSX.utils.sheet_to_html(wb.Sheets[n]);body.appendChild(d)});
      foot.textContent=wb.SheetNames.length+' sheet(s) · viewing only';
    } else if(k==='img'){
      const url=URL.createObjectURL(blob);
      body.innerHTML='<img src="'+url+'" alt="'+esc(f.name)+'" style="max-width:100%;max-height:80vh;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.35)">';
      foot.textContent=kb(blob.size)+' · viewing only';
    } else if(extOf(f.name)==='docx'&&window.mammoth){
      const r=await mammoth.convertToHtml({arrayBuffer:await blob.arrayBuffer()});
      body.innerHTML='<div class="sheet" style="max-width:760px;line-height:1.6">'+(r.value||'<i>Empty document.</i>')+'</div>';
      foot.textContent='Word document · viewing only';
    } else body.innerHTML='<div class="sheet"><b>No preview for this file type.</b><div class="hint">'+esc(f.name)+'</div></div>';
  }catch(e){ body.innerHTML='<div class="sheet"><b>Could not open this file.</b><div class="hint">'+esc(e.message||'')+'</div></div>' }
}

/* ============================================================
   Sign in / sign up  (Supabase Auth)
   ============================================================ */
let signMode='login', firstAccount=false;
const uniqOf=k=>Array.from(new Set(DB.users.map(u=>(u[k]||'').trim()).filter(Boolean))).sort();
// standard designations offered in the Designation field (plus any already in use)
const DESIGNATIONS=['Deputy Manager','Assistant Manager','Manager','Senior Manager','AGM','GM','State Head','AVP','VP','CMD'];
const lists=()=>'<datalist id="dl-role">'+Array.from(new Set(DESIGNATIONS.concat(uniqOf('role')))).map(d=>'<option value="'+esc(d)+'">').join('')+'</datalist>';
const deptOptions=sel=>'<option value="">Choose a department</option>'+DB.departments.map(d=>'<option '+(sel===d?'selected':'')+'>'+esc(d)+'</option>').join('');
/* excludeId is the person whose entry is being edited — they cannot report to themselves.
   When creating someone new there is nobody to exclude, so every leader, including you, is offered. */
const mgrOptions=(sel,excludeId)=>{
  const pool=managers().filter(m=>!excludeId||m.id!==excludeId);
  const grp=(label,list)=>list.length?'<optgroup label="'+label+'">'+list.map(m=>'<option value="'+m.id+'" '+(sel===m.id?'selected':'')+'>'+esc(m.name)+(m.role?' — '+esc(m.role):'')+(m.dept?', '+esc(m.dept):'')+'</option>').join('')+'</optgroup>':'';
  return '<option value="">Nobody — not under anyone</option>'+
    grp('Super admin',pool.filter(m=>m.owner))+
    grp('Admins',pool.filter(m=>m.admin&&!m.owner))+
    grp('Managers',pool.filter(m=>m.manager&&!m.admin&&!m.owner));
};
const siErr=m=>{const e=$('#si-err');e.textContent=m;e.classList.remove('hide')};

/* Password boxes. Inside the Android app a real <input type="password"> wakes the
   phone's password manager (Chrome ignores autocomplete="off" on password fields), and
   on many phones that closes and reopens the keyboard after EVERY letter. Where the
   browser can mask a normal text box (Android WebView, Chrome, Safari) we use that
   instead: it shows dots but is not a "password field" to Android, so the keyboard
   stays up. Browsers that can't mask keep a normal password box. "Show" reveals it. */
const PW_MASK=(()=>{ try{ return !!(window.CSS&&CSS.supports&&CSS.supports('-webkit-text-security','disc')); }catch(e){ return false; } })();
function pwInput(id,ph){
  return '<span class="pw-wrap"><input id="'+id+'" name="f'+uid()+'" '+(PW_MASK?'type="text" class="pw-mask"':'type="password"')+
    ' autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" data-form-type="other"'+
    (ph?' placeholder="'+esc(ph)+'"':'')+'><button type="button" class="pw-eye" data-pweye="'+id+'" tabindex="-1">Show</button></span>';
}
function wirePwEyes(root){
  $$('[data-pweye]',root||document).forEach(b=>{
    // pressing Show must not take focus from the box, or the keyboard would close
    b.addEventListener('pointerdown',e=>e.preventDefault()); b.addEventListener('mousedown',e=>e.preventDefault());
    b.onclick=e=>{ e.preventDefault(); const i=document.getElementById(b.dataset.pweye); if(!i) return;
      const showing=b.textContent==='Hide';
      if(PW_MASK) i.classList.toggle('pw-show',!showing); else i.type=showing?'password':'text';
      b.textContent=showing?'Show':'Hide'; };
  });
}

async function paintSignIn(){
  try{ const st=await rpc('system_state'); firstAccount=(st&&st.users===0) }catch(e){ firstAccount=false }
  if(firstAccount) signMode='signup';
  const signup=signMode==='signup';
  $('#si-swapwrap').classList.toggle('hide',firstAccount);
  $('#si-err').classList.add('hide');
  $('#si-title').textContent=firstAccount?'Set up the first account':(signup?'Create your account':'Sign in');
  $('#si-sub').textContent=firstAccount?'Nobody is registered yet. This first account runs the system and can register everyone else.'
    :(signup?'Once registered, anyone raising a request can add you to their approval chain.':'Sign in with your Employee ID (or work email) and password.');
  $('#si-go').textContent=firstAccount?'Create account and sign in':(signup?'Create account':'Sign in');
  $('#si-swap-t').textContent=signup?'Already registered?':'New here?';
  $('#si-swap').textContent=signup?'Sign in instead':'Create an account';
  /* department list is public reference data; before sign-in we fall back to the seeded defaults */
  const depts=DB.departments.length?DB.departments:['Indent','Purchase','Billing','Payment','Finance','Administration','Projects','Technology','Maintenance','Leadership'];
  $('#si-fields').innerHTML=signup
    ?'<div class="grid" style="gap:12px"><div><label for="f-name">Full name</label><input id="f-name" type="text" placeholder="Neha Kulkarni"></div>'+
     '<div><label for="f-email">Work email</label><input id="f-email" type="email" placeholder="neha@confidencegroup.in"></div>'+
     '<div class="grid g2"><div><label for="f-role">Designation</label><input id="f-role" type="text" placeholder="Accounts Executive"></div>'+
     '<div><label for="f-dept">Department</label><select id="f-dept"><option value="">Choose a department</option>'+depts.map(d=>'<option>'+esc(d)+'</option>').join('')+'</select></div></div>'+
     '<div><label for="f-pass">Password</label>'+pwInput('f-pass','At least 8 characters')+'</div>'+
     '<div class="hint">You can pick your manager once you are in, from your directory entry.</div></div>'
    :'<div class="grid" style="gap:12px"><div><label for="f-email">Employee ID or work email</label><input id="f-email" name="setu-login-id" type="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="email" placeholder="e.g. 11247 or you@confidencegroup.co"></div>'+
     '<div><label for="f-pass">Password</label>'+pwInput('f-pass')+'</div>'+
     '<div style="text-align:right;margin-top:-4px"><button class="btn ghost sm" id="si-forgot" style="padding:0;font-weight:500">Forgot your password?</button></div></div>';
  $$('#si-fields input').forEach(i=>i.addEventListener('keydown',e=>{if(e.key==='Enter')$('#si-go').click()}));
  wirePwEyes($('#si-fields'));
  if($('#si-forgot')) $('#si-forgot').onclick=forgotDialog;
}
$('#si-swap').onclick=()=>{signMode=signMode==='signup'?'login':'signup';paintSignIn()};
$('#si-go').onclick=async()=>{
  $('#si-err').classList.add('hide');
  const email=(($('#f-email')||{}).value||'').trim().toLowerCase(), pass=(($('#f-pass')||{}).value||'');
  const btn=$('#si-go'); btn.disabled=true;
  try{
    if(signMode==='signup'){
      const name=($('#f-name').value||'').trim(), role=($('#f-role').value||'').trim(), dept=$('#f-dept').value;
      if(name.length<3) return siErr('Enter your full name as colleagues would search for it.');
      if(!/^\S+@\S+\.\S+$/.test(email)) return siErr('Enter a valid work email.');
      if(role.length<2) return siErr('Enter your designation.');
      if(!dept) return siErr('Choose your department.');
      if(pass.length<8) return siErr('Password needs at least 8 characters.');
      // self_signup marks this as a public "Create an account" so the database
      // starts it Gate-Pass-only (admins upgrade later); admin/seed accounts omit it.
      const {data,error}=await SB.auth.signUp({email,password:pass,options:{data:{name,role,dept,self_signup:true}}});
      if(error) return siErr(error.message);
      if(!data.session){ siErr('Account created. Check your email for the confirmation link, then sign in.'); signMode='login'; return }
      return; // onAuthStateChange takes it from here
    }
    // A person may type EITHER their Employee ID or their email. The server maps
    // whatever they typed to the account's real login address (bulk accounts log in
    // as <empid>@setu.local; approvers log in with their email). Falls back to a
    // local guess if the lookup is unavailable.
    let loginId = email.includes('@') ? email : (email.replace(/\s+/g,'') + '@setu.local');
    try{ const {data}=await SB.rpc('auth_login_for',{p_id:email}); if(data) loginId=data; }catch(e){}
    const {error}=await SB.auth.signInWithPassword({email:loginId,password:pass});
    if(error) return siErr(/invalid/i.test(error.message)?'Wrong Employee ID / email or password.':error.message);
  } finally { btn.disabled=false }
};
/* Sign out that always returns to the login screen, even if the network call
   to revoke the session hangs or fails. Local scope avoids the global revoke
   round-trip; a short race + forced leave() guarantees the UI resets. */
async function doSignOut(){
  busy(false);                                   // drop any stuck overlay so the click isn't blocked
  try{ await Promise.race([ SB.auth.signOut({scope:'local'}), new Promise(res=>setTimeout(res,2000)) ]); }catch(e){}
  try{ leave(); }catch(e){ location.reload(); }  // force back to sign-in no matter what
}
$('#signout').onclick=doSignOut;

async function enter(session){
  showSplash('Signing you in…');
  try{
    ME={id:session.user.id};
    // Load only what the first screen needs, so the app opens as soon as this
    // person's own work is ready. People first (it resolves who ME is), then the
    // work lists. The heaviest query — up to 3,000 gate passes — is streamed in
    // afterwards instead of blocking the sign-in for everyone.
    await load(['people']);
    if(!ME.name){ toast('Your directory entry has not been created yet. Try again in a moment.','bad'); hideSplash(); busy(false); return }
    if(!ME.active){ toast('This account is switched off. Ask an administrator.','bad'); await SB.auth.signOut(); hideSplash(); busy(false); return }
    await load(gateScopeOnly()?['gate','notif']:['legacy','flows','notif']);
    $('#signin').classList.add('hide'); $('#app').classList.remove('hide');
    $('#me-av').textContent=inits(ME.name); $('#me-name').textContent=ME.name; $('#me-role').textContent=ME.role;
    pushRegister();
    const pubTag=(location.hash.match(/^#g\/(.+)$/)||[])[1];   // scanned a QR while signed in
    paintPin(); const h=pubTag?null:routeFromHash();
    const base=ASSISTANT()?{name:'assist'}:SUBADMIN()?{name:'people'}:(GATE_ONLY()||HR_HEAD())?{name:'gate'}:{name:'dash'};
    // deep link (from a notification tap): open the target, but keep the home screen
    // beneath it in history so Back returns to the app rather than exiting
    let target=base;
    if(h){ if(h.name==='detail') target=DB.requests.some(r=>r.id===h.id)?h:base; else target=h; }
    if(routeHash(target)!==routeHash(base)){ go(base,true); go(target); } else { go(base,true); }
    subscribe();
    hideSplash();
    if(pubTag){ const id=decodeURIComponent(pubTag); setTimeout(()=>{ if(canUseGaruda()) cngTagPanel(id); else garPublicView(id); },500); }
    Promise.resolve(SB.rpc('record_login')).catch(()=>{});                             // stamp the login once the app is visible (builder isn't a real Promise)
    if(!gateScopeOnly()) load(['gate']).then(()=>reloadSoon(['gate'])).catch(()=>{});   // stream gate passes in behind the first screen
    const incomplete=()=>!ME.role||(!ME.admin&&(!ME.dept||DB.departments.indexOf(ME.dept)<0));
    // gate-only accounts don't approve anything: no PIN, no directory-completion nag, no pending-work popup
    if(ME.mustChange) setTimeout(()=>newPasswordDialog({title:'Choose your own password',intro:'You signed in with a temporary password from your administrator. Pick your own to continue.',
        onDone:async()=>{ try{ await rpc('password_changed') }catch(e){} ME.mustChange=false; if(!restrictedAcct()&&incomplete()) profileDialog(); else if(!restrictedAcct()&&!pinOK(ME)) pinDialog() }}),300);
    else if(restrictedAcct()) {}
    else if(incomplete()) setTimeout(profileDialog,400);
    else if(!pinOK(ME)) setTimeout(pinDialog,450);
    else setTimeout(pendingPopup,500);
  }catch(e){ hideSplash(); fail(e) } finally { busy(false) }
}
/* a nudge on sign-in listing whatever is actually waiting on this person */
function pendingPopup(){
  if($('.veil')) return;                                  // don't stack on another dialog
  const q=myQueue(), tk=myTasks(), st=myStuck();
  const rows=[];
  if(q.length)  rows.push(['queue','Waiting for your approval',q.length]);
  if(tk.length) rows.push(['tasks','Tasks assigned to you',tk.length]);
  if(st.length) rows.push(['stuck','A query / more input needed on your request',st.length]);
  if(!rows.length) return;
  const total=q.length+tk.length+st.length;
  modal({title:'You have '+total+' item'+(total>1?'s':'')+' waiting',
    body:'<div class="sheet-list">'+rows.map(([k,label,n])=>
        '<button data-go="'+k+'" style="display:flex;align-items:center;gap:10px"><span>'+esc(label)+'</span><span class="pill" style="margin-left:auto">'+n+'</span></button>').join('')+'</div>'+
      '<div class="hint" style="margin-top:10px">These are also under Notifications and on your dashboard'+(unread().length?' — '+unread().length+' unread alert'+(unread().length>1?'s':''):'')+'.</div>',
    footer:'<button class="btn primary" data-x>Got it</button>',
    onOpen:(v,close)=>{ $$('[data-go]',v).forEach(b=>b.onclick=()=>{const k=b.dataset.go;close();setTimeout(()=>go({name:k}),0)}); }});
}
function leave(){ hideSplash(); pushForget(); ME=null; unsubscribe(); $('#app').classList.add('hide'); $('#signin').classList.remove('hide'); signMode='login'; paintSignIn() }

/* extend a chain that ran out: append approvers, reopening the request if it had closed */
function extendChainDialog(r){
  const draft=[];
  const inchain=()=>r.chain.map(s=>s.userId).concat(r.requesterId,draft);
  modal({title:'Add the next approvers',
    body:'<p style="margin-top:0"><b>'+esc(docTitle(r))+'</b>'+(r.status==='Approved'?' closed after '+r.chain.length+' approver'+(r.chain.length===1?'':'s')+' because no one else was in the chain. Add who should have come next — it will reopen and move to them.':' — add who should act next.')+'</p>'+
      '<div class="finder" style="margin-top:14px"><label for="ex-find">Add an approver</label><input id="ex-find" type="text" placeholder="Name, email, designation or department" autocomplete="off"><div id="ex-res"></div></div>'+
      '<div id="ex-list" style="margin-top:8px"></div>'+
      '<div style="margin-top:12px"><label for="ex-why">Why</label><input id="ex-why" type="text" placeholder="e.g. chain was raised incomplete"></div>'+
      '<div id="ex-err" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="ex-go">Add and continue</button>',
    onOpen:(v,close)=>{
      const paint=()=>{ const c=$('#ex-list',v);
        c.innerHTML=draft.length?'<div class="picked">'+draft.map((id,i)=>{const u=user(id);
          return '<div class="r"><span class="seq">'+(r.chain.length+i+2)+'</span><div class="av sm">'+inits(u.name)+'</div><div class="who" style="min-width:0;flex:1"><b>'+esc(u.name)+'</b><div class="hint">'+esc(u.role||'')+(u.dept?' · '+esc(u.dept):'')+'</div></div><button class="btn sm" data-rm="'+i+'">Remove</button></div>'}).join('')+'</div>':'';
        $$('[data-rm]',c).forEach(b=>b.onclick=()=>{draft.splice(+b.dataset.rm,1);paint()}); };
      paint();
      const find=$('#ex-find',v), res=$('#ex-res',v);
      find.oninput=()=>{ const q=find.value.trim().toLowerCase(); if(!q){res.innerHTML='';return}
        const ex=inchain();
        const hits=DB.users.filter(u=>u.active&&ex.indexOf(u.id)<0&&(u.name+' '+u.email+' '+(u.dept||'')+' '+(u.role||'')).toLowerCase().includes(q)).slice(0,6);
        res.innerHTML=hits.length?'<div class="results">'+hits.map(u=>'<button data-u="'+u.id+'"><div class="av sm">'+inits(u.name)+'</div><div><b>'+esc(u.name)+'</b><div class="hint">'+esc(u.role||'')+' · '+esc(u.dept||'')+'</div></div></button>').join('')+'</div>':'<div class="results"><div style="padding:10px 12px" class="hint">Nobody matches, or they are already in the chain.</div></div>';
        $$('.results button',res).forEach(b=>b.onclick=()=>{draft.push(b.dataset.u);find.value='';res.innerHTML='';paint();find.focus()});
      };
      $('#ex-go',v).onclick=async()=>{ const why=$('#ex-why',v).value.trim();
        if(!draft.length) return $('#ex-err',v).textContent='Add at least one approver.';
        if(why.length<4) return $('#ex-err',v).textContent='Say why, in a few words.';
        $('#ex-go',v).disabled=true;
        try{ await rpc('extend_chain',{p_request:r.id,p_users:draft,p_why:why}); close(); await load(); toast('Chain extended — now with '+user(draft[0]).name+'.','ok'); go({name:'detail',id:r.id}) }
        catch(e){ $('#ex-go',v).disabled=false; $('#ex-err',v).textContent=(e.message||'').replace(/^.*?: /,'') }
      };
    }});
}
/* an admin resets someone's password: type one or generate, shown once, they must change it at next sign-in */
function resetPasswordDialog(u){
  modal({title:'Reset password for '+u.name,
    body:'<p class="hint" style="margin-top:0">Use this when '+esc(u.name.split(' ')[0])+' is locked out and cannot use the email link. Leave blank to generate one.</p>'+
      '<div style="margin-top:14px"><label for="rp-pw">New temporary password</label><input id="rp-pw" type="text" autocomplete="off" placeholder="At least 8 characters, or blank to generate"></div>'+
      '<div class="hint" style="margin-top:8px">Shown to you once. They must choose their own at their next sign-in.</div>'+
      '<div id="rp-err" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="rp-go">Reset password</button>',
    onOpen:(v,close)=>{ $('#rp-pw',v).focus();
      $('#rp-go',v).onclick=async()=>{
        const pw=$('#rp-pw',v).value.trim();
        if(pw&&pw.length<8) return $('#rp-err',v).textContent='At least 8 characters, or leave blank.';
        $('#rp-go',v).disabled=true;
        const {data,error}=await SB.functions.invoke('admin-create-user',{body:{action:'reset_password',user_id:u.id,password:pw}});
        if(error||!data||data.error){ $('#rp-go',v).disabled=false;
          let msg=(data&&data.error)||(error&&error.message)||'Could not reset the password.';
          try{ if(error&&error.context){const j=await error.context.json(); if(j&&j.error) msg=j.error} }catch(e){}
          return $('#rp-err',v).textContent=msg }
        close(); tempPasswordDialog(data.name,u.email,data.tempPassword);
      };
    }});
}
/* a checklist of the optional pages; the always-on work pages are noted but not listable */
function pagesChecklist(id,selected){
  const set=selected||DEFAULT_PAGES;
  return '<div class="row" style="align-items:center;margin-top:2px"><div class="hint" style="font-weight:600;color:var(--ink-soft)">Page access — tick what this person can open</div>'+
    '<span style="margin-left:auto;display:flex;gap:6px"><button type="button" class="btn ghost sm" data-pgall="'+id+'" style="padding:0 8px">Select all</button><button type="button" class="btn ghost sm" data-pgnone="'+id+'" style="padding:0 8px">Clear</button></span></div>'+
    '<div id="'+id+'" style="display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;margin-top:6px">'+
    OPTIONAL_PAGES.map(pg=>'<label style="display:flex;align-items:center;gap:8px;margin:0;font-size:13.5px"><input type="checkbox" value="'+pg.k+'" style="width:auto" '+(set.indexOf(pg.k)>-1?'checked':'')+'> '+esc(pg.label)+'</label>').join('')+'</div>'+
    '<div class="hint" style="margin-top:6px">Dashboard, Notifications, Waiting on me, Tasks given to me, Needs my input and My requests are always available — they carry the work. Admins always see every page.</div>';
}
const readChecklist=(id,v)=>$$('#'+id+' input:checked',v).map(c=>c.value);
/* wire the Select all / Clear buttons for a pages checklist */
function wirePagesChecklist(id,v){
  const all=$('[data-pgall="'+id+'"]',v), none=$('[data-pgnone="'+id+'"]',v);
  if(all) all.onclick=()=>$$('#'+id+' input',v).forEach(c=>c.checked=true);
  if(none) none.onclick=()=>$$('#'+id+' input',v).forEach(c=>c.checked=false);
}

/* ---------- an administrator creates an account directly ---------- */
function createUserDialog(){
  modal({title:'Create an account',
    body:'<div class="grid" style="gap:12px"><div><label for="cu-name">Full name</label><input id="cu-name" type="text" placeholder="Neha Kulkarni"></div>'+
      '<div><label for="cu-email">Work email</label><input id="cu-email" type="email" placeholder="neha@confidencegroup.in"></div>'+
      '<div class="sep" style="margin:2px 0"></div><div class="hint" style="font-weight:600;color:var(--ink-soft)">System role</div>'+
      '<label style="display:flex;align-items:flex-start;gap:9px;margin:0"><input type="radio" name="cu-sys" value="user" checked style="width:auto;margin-top:4px"> <span><b>User</b><div class="hint">Raises and approves requests. Can be a manager, and can be given work.</div></span></label>'+
      (ME.owner?'<label style="display:flex;align-items:flex-start;gap:9px;margin:0"><input type="radio" name="cu-sys" value="admin" style="width:auto;margin-top:4px"> <span><b>Admin</b><div class="hint">Runs the system: creates accounts, sets access, manages masters, sees every request. Only you can create admins.</div></span></label>'
        :'<div class="hint">Only the system owner can create administrators.</div>')+
      '<div class="sep" style="margin:2px 0"></div><div class="hint" style="font-weight:600;color:var(--ink-soft)">In the process flow</div>'+
      '<div class="grid g2"><div><label for="cu-role">Designation</label><input id="cu-role" type="text" list="dl-role" placeholder="Accounts Executive"></div>'+
      '<div><label for="cu-dept">Department <span class="hint" id="cu-dept-opt"></span></label><select id="cu-dept">'+deptOptions('')+'</select></div></div>'+
      '<div><label for="cu-mgr">Reports to</label><select id="cu-mgr">'+mgrOptions('',null)+'</select><div class="hint">A manager, an admin, or you. Set here, no confirmation needed — they are on that person\'s team from the start.</div></div>'+
      '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="cu-man" style="width:auto"> <span><b>Manager</b><div class="hint">Can hand work to their team inside a request.</div></span></label>'+
      (GRANTS_ROLES()?'<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="cu-see" style="width:auto"> <span><b>Can see every request</b><div class="hint">Oversight without admin rights, e.g. audit.</div></span></label>':'')+
      '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="cu-gateonly" style="width:auto"> <span><b>Gate Pass only</b><div class="hint">Signs in to the Gate Pass page and nothing else.</div></span></label>'+
      '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="cu-hrhead" style="width:auto"> <span><b>HR Head (Gate Pass reports)</b><div class="hint">Views every gate pass + the Reports page. Restricted to those.</div></span></label>'+
      (GRANTS_ROLES()?'<div class="sep" style="margin:2px 0"></div><div class="hint" style="font-weight:600;color:var(--ink-soft)">Sub-admin — user-desk powers without full Admin</div>'+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="cu-cc" style="width:auto"> <span><b>Can create users</b><div class="hint">May add new accounts (ordinary users only, never Admins).</div></span></label>'+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="cu-cm" style="width:auto"> <span><b>Can manage users</b><div class="hint">May edit existing people (not Admins or the owner) and reset their passwords. No access to requests, reports or masters.</div></span></label>':'')+
      '<div class="sep" style="margin:2px 0"></div>'+pagesChecklist('cu-pages',DEFAULT_PAGES)+'<div class="sep" style="margin:2px 0"></div><div class="hint" style="font-weight:600;color:var(--ink-soft)">How they get in</div>'+
      '<label style="display:flex;align-items:flex-start;gap:9px;margin:0"><input type="radio" name="cu-mode" value="password" checked style="width:auto;margin-top:4px"> <span><b>Give them a temporary password</b><div class="hint">They must choose their own at first sign-in.</div></span></label>'+
      '<div id="cu-pw-wrap" style="padding-left:24px"><label for="cu-pw">Temporary password <span class="hint">optional</span></label><input id="cu-pw" type="text" autocomplete="off" placeholder="Leave blank and one is generated for you"><div class="hint">At least 8 characters if you set one. Shown to you once after the account is created.</div></div>'+
      '<label style="display:flex;align-items:flex-start;gap:9px;margin:0"><input type="radio" name="cu-mode" value="invite" style="width:auto;margin-top:4px"> <span><b>Email them an invite link</b><div class="hint">They set their own password from the link. Needs the email setup in the README.</div></span></label>'+
      '</div>'+lists()+'<div id="cu-err" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="cu-go">Create account</button>',
    onOpen:(v,close)=>{
      $('#cu-name',v).focus();
      const sysRole=()=>($('input[name="cu-sys"]:checked',v)||{}).value||'user';
      const syncDept=()=>{ const opt=$('#cu-dept-opt',v); if(opt) opt.textContent=sysRole()==='admin'?'(optional for admins)':''; };
      $$('input[name="cu-sys"]',v).forEach(r=>r.onchange=syncDept); syncDept();
      const syncMode=()=>{const w=$('#cu-pw-wrap',v); if(w) w.classList.toggle('hide',(($('input[name="cu-mode"]:checked',v)||{}).value||'password')!=='password')};
      $$('input[name="cu-mode"]',v).forEach(r=>r.onchange=syncMode); syncMode();
      wirePagesChecklist('cu-pages',v);
      $('#cu-go',v).onclick=async()=>{
        const body={name:$('#cu-name',v).value.trim(),email:$('#cu-email',v).value.trim().toLowerCase(),role:$('#cu-role',v).value.trim(),dept:$('#cu-dept',v).value,
          manager_id:$('#cu-mgr',v).value||null,is_manager:$('#cu-man',v).checked,see_all:($('#cu-see',v)||{}).checked||false,is_admin:sysRole()==='admin',
          can_create_users:($('#cu-cc',v)||{}).checked||false,can_manage_users:($('#cu-cm',v)||{}).checked||false,
          mode:($('input[name="cu-mode"]:checked',v)||{}).value||'password',password:($('#cu-pw',v)||{}).value||'',pages:readChecklist('cu-pages',v)};
        const err=$('#cu-err',v);
        if(body.name.length<3) return err.textContent='Enter the full name.';
        if(!/^\S+@\S+\.\S+$/.test(body.email)) return err.textContent='Enter a valid work email.';
        if(body.role.length<2) return err.textContent='Enter a designation.';
        if(!body.dept&&!body.is_admin) return err.textContent='Choose a department.';
        if(body.mode==='password'&&body.password&&body.password.trim().length<8) return err.textContent='A temporary password needs at least 8 characters, or leave it blank.';
        $('#cu-go',v).disabled=true; err.textContent='';
        const {data,error}=await SB.functions.invoke('admin-create-user',{body});
        if(error||!data||data.error){ $('#cu-go',v).disabled=false;
          let msg=(data&&data.error)||(error&&error.message)||'Could not create the account.';
          try{ if(error&&error.context){ const j=await error.context.json(); if(j&&j.error) msg=j.error } }catch(e){}
          if(/failed to send|fetch/i.test(msg)) msg='The browser could not reach the admin-create-user function. In Supabase → Edge Functions, check it is deployed under exactly that name and that Verify JWT is off; the Logs tab shows the reason.';
          return err.textContent=/not found|404/i.test(msg)?'The admin-create-user function is not deployed yet — see the README.':msg }
        if(data.id&&$('#cu-gateonly',v)&&$('#cu-gateonly',v).checked){ try{ await rpc('set_gate_only',{p_user:data.id,p_on:true}) }catch(e){} }
        if(data.id&&$('#cu-hrhead',v)&&$('#cu-hrhead',v).checked){ try{ await rpc('set_hr_head',{p_user:data.id,p_on:true}) }catch(e){} }
        close(); await load(); render();
        if(data.tempPassword) tempPasswordDialog(body.name,body.email,data.tempPassword);
        else toast('Invite sent to '+body.email+'.','ok');
      };
    }});
}
function tempPasswordDialog(name,email,pw){
  modal({title:'Account created',
    body:'<p style="margin-top:0"><b>'+esc(name)+'</b> can sign in with:</p>'+
      '<div class="kv" style="margin-top:10px"><dt>Email</dt><dd class="num">'+esc(email)+'</dd><dt>Temporary password</dt><dd class="num" style="font-size:18px;letter-spacing:.06em">'+esc(pw)+'</dd></div>'+
      '<p class="hint" style="margin-top:14px">This is shown once. Pass it on by a channel you trust — in person or a direct message. At their first sign-in they must replace it with a password of their own.</p>',
    footer:'<button class="btn" id="tp-copy">Copy details</button><button class="btn primary" data-x>Done</button>',
    onOpen:(v)=>{$('#tp-copy',v).onclick=async()=>{const txt='SETU sign-in\n'+APP_URL+'\nEmail: '+email+'\nTemporary password: '+pw+'\nYou will be asked to choose your own password when you sign in.';
      try{ await navigator.clipboard.writeText(txt); toast('Copied.','ok') }catch(e){ toast('Select and copy the details above.','bad') }}}});
}

/* ---------- owner deletion (testing, and the go-live reset) ---------- */
async function removeObjects(paths){ if(!paths||!paths.length) return 0;
  // gate selfies also have a small list thumbnail — remove it with the photo
  const {error}=await SB.storage.from('documents').remove(withThumbs(paths)); if(error) throw error; return paths.length }
function purgeRequestDialog(r){
  modal({title:'Delete this request',
    body:'<p style="margin-top:0"><b>'+esc(docTitle(r))+'</b> — '+esc(r.ref)+', raised by '+esc(user(r.requesterId).name)+'.</p>'+
      '<p class="hint">Every step, task, note, document and audit row on it goes. This is the one exception to the permanent record, available only to the system owner, and the deletion itself is logged where it cannot be removed.</p>'+
      '<div style="margin-top:14px"><label for="pg-why">Why</label><input id="pg-why" type="text" placeholder="e.g. test entry"></div><div id="pg-err" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
    footer:'<button class="btn" data-x>Keep it</button><button class="btn bad" id="pg-go">Delete request</button>',
    onOpen:(v,close)=>{$('#pg-go',v).onclick=async()=>{const why=$('#pg-why',v).value.trim(); if(why.length<4) return $('#pg-err',v).textContent='Say why, in a few words.';
      $('#pg-go',v).disabled=true;
      try{ const paths=await rpc('request_file_paths',{p_request:r.id}); await removeObjects(paths);
        const res=await rpc('purge_request',{p_request:r.id,p_why:why}); close(); await load(); toast(res.ref+' deleted.','ok'); go({name:'all'}) }
      catch(e){ $('#pg-go',v).disabled=false; $('#pg-err',v).textContent=(e.message||'').replace(/^.*?: /,'') }}}});
}
function purgeAllDialog(){
  const note={all:'Everything — every indent / work order, ALDS flow, gate pass, with all steps, notes, documents, selfies and usage counters.',
    flows:'Indent / Work order only — every chain request and ALDS PO/WO flow, with their steps, notes and documents. Gate passes stay.',
    gate:'Gate passes only — every gate pass and its selfies. Indents, work orders and flows stay.'};
  modal({title:'Reset data (to point zero)',
    body:'<p style="margin-top:0">Choose what to wipe. Accounts, teams, saved hierarchies and masters always stay, and the numbering for whatever you clear restarts at 1001.</p>'+
      '<div style="margin-top:12px"><label for="pa-scope">What to delete</label><select id="pa-scope">'+
        '<option value="all">Everything</option>'+
        '<option value="flows">Indent / Work order only</option>'+
        '<option value="gate">Gate passes only</option></select>'+
        '<div class="hint" id="pa-note" style="margin-top:6px">'+esc(note.all)+'</div></div>'+
      '<p class="hint" style="margin-top:10px">Meant for the end of testing, before real entries. It is logged permanently.</p>'+
      '<div style="margin-top:12px"><label for="pa-c">Type <b>DELETE EVERYTHING</b> to confirm</label><input id="pa-c" type="text" autocomplete="off"></div>'+
      '<div style="margin-top:12px"><label for="pa-why">Why</label><input id="pa-why" type="text" placeholder="e.g. end of testing, going live"></div><div id="pa-err" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn bad" id="pa-go">Delete</button>',
    onOpen:(v,close)=>{
      const sc=$('#pa-scope',v); sc.onchange=()=>{ $('#pa-note',v).textContent=note[sc.value]; };
      $('#pa-go',v).onclick=async()=>{const scope=sc.value, c=$('#pa-c',v).value, why=$('#pa-why',v).value.trim();
        if(c!=='DELETE EVERYTHING') return $('#pa-err',v).textContent='Type it exactly, in capitals.';
        if(why.length<4) return $('#pa-err',v).textContent='Say why.';
        $('#pa-go',v).disabled=true;
        try{ const paths=await rpc('scoped_file_paths',{p_scope:scope}); await removeObjects(paths);
          const res=await rpc('purge_scoped',{p_scope:scope,p_confirm:c,p_why:why}); close(); await load();
          toast('Cleared '+res.requests+' requests, '+res.flows+' flows and '+res.gate_passes+' gate passes. Numbering restarts at 1001.','ok'); go({name:'dash'}); }
        catch(e){ $('#pa-go',v).disabled=false; $('#pa-err',v).textContent=(e.message||'').replace(/^.*?: /,'') }}; }});
}
function purgeUserDialog(u){
  modal({title:'Remove '+u.name,
    body:'<p style="margin-top:0">Removes the account <b>'+esc(u.email)+'</b> entirely. Refused if they still appear on any request — delete those first, or switch the account off instead, which keeps the history.</p>'+
      '<div style="margin-top:14px"><label for="pu-why">Why</label><input id="pu-why" type="text" placeholder="e.g. test account"></div><div id="pu-err" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn bad" id="pu-go">Remove account</button>',
    onOpen:(v,close)=>{$('#pu-go',v).onclick=async()=>{const why=$('#pu-why',v).value.trim(); if(why.length<4) return $('#pu-err',v).textContent='Say why.';
      $('#pu-go',v).disabled=true;
      try{ const res=await rpc('purge_user',{p_user:u.id,p_why:why}); close(); await load(); render();
        toast(res.auth_deleted?res.name+' removed.':res.name+' switched off; remove the sign-in from Supabase → Authentication → Users.',res.auth_deleted?'ok':'bad') }
      catch(e){ $('#pu-go',v).disabled=false; $('#pu-err',v).textContent=(e.message||'').replace(/^.*?: /,'') }}}});
}

/* ---------- notifications ---------- */
const unread=()=>(DB.notifs||[]).filter(x=>!x.read);
const KIND_ICON={landed:'➜',reply:'↩',task:'✎',task_closed:'✓',info:'?',approved:'✓',rejected:'✕',reassigned:'⇄'};
function viewInbox(){
  head('Notifications','Everything that landed on your desk');
  const l=DB.notifs||[];
  if(!l.length) return '<div class="card"><div class="empty"><h3>Nothing yet</h3><p class="hint">When a request reaches you, a task is handed to you, or something you raised moves, it appears here — and on your phone and by email once those are switched on.</p></div></div>';
  const un=unread().length;
  return '<div class="card"><div class="row" style="padding:14px 18px;border-bottom:1px solid var(--line)"><span class="hint">'+(un?un+' unread':'All read')+'</span>'+
    (un?'<button class="btn sm" id="nb-all" style="margin-left:auto">Mark all read</button>':'')+'</div>'+
    l.map(x=>'<div class="filerow" data-n="'+x.id+'" style="border:0;border-bottom:1px solid var(--line);border-radius:0;cursor:pointer;align-items:flex-start;'+(x.read?'':'background:var(--indigo-soft)')+'">'+
      '<span class="av sm" style="'+(x.read?'':'background:var(--indigo);color:#fff;border-color:var(--indigo)')+'">'+(KIND_ICON[x.kind]||'•')+'</span>'+
      '<div style="min-width:0;flex:1"><div style="font-size:14px;'+(x.read?'':'font-weight:700')+'">'+esc(x.title)+'</div>'+
      (x.body?'<div class="hint" style="white-space:pre-line;margin-top:2px">'+esc(x.body)+'</div>':'')+
      '<div class="hint" style="margin-top:3px">'+esc(fmtDT(x.ts))+'</div></div></div>').join('')+'</div>';
}
/* turn a notification's stored route (#detail/… , #flowdetail/… , #gate) into a screen,
   falling back to the legacy request id for older rows */
function notifRoute(x){
  const r=(x&&x.route)||((x&&x.requestId)?'#detail/'+x.requestId:'')||((x&&x.request_id)?'#detail/'+x.request_id:'');
  // safety net: a notification with no real destination ("#dash") that names an ALDS
  // PO/WO ("Reminder: ALDS PO IH26O07-011 needs you") opens that flow
  if((!r||r==='#dash')&&x&&x.title){ const f=flowFromText(x.title); if(f) return {name:'flowdetail',id:f.id}; }
  const m=String(r).match(/^#([a-z]+)(?:\/([\w-]+))?$/); return m?{name:m[1],id:m[2]}:null;
}
function flowFromText(t){
  const m=String(t||'').match(/ALDS (PO|WO) (.+?)(?: needs you| is fully approved| was cancelled)?$/); if(!m) return null;
  const hits=(DB.flows||[]).filter(f=>f.head===m[1]&&(f.title===m[2]||f.ref===m[2]));
  if(!hits.length) return null;
  // prefer one that's on my desk, then a running one, then the newest
  return hits.slice().sort((a,b)=>(flowIsMine(b)-flowIsMine(a))||((b.status==='running')-(a.status==='running'))||(b.createdAt-a.createdAt))[0];
}
function gotoNotif(x){ const r=notifRoute(x); if(r) go(r); else render(); }
function wireInbox(v){
  $$('[data-n]',v).forEach(el=>el.onclick=async()=>{const x=DB.notifs.find(y=>y.id===+el.dataset.n); if(!x) return;
    if(!x.read){ x.read=true; SB.rpc('mark_read',{p_ids:[x.id]}).then(()=>paintNav()) }
    gotoNotif(x);});
  if($('#nb-all',v)) $('#nb-all',v).onclick=async()=>{ await SB.rpc('mark_all_read'); DB.notifs.forEach(x=>x.read=true); paintNav(); render() };
}
/* opening a request settles everything about it */
function readForRequest(id){ const mine=(DB.notifs||[]).filter(x=>x.requestId===id&&!x.read); if(!mine.length) return;
  mine.forEach(x=>x.read=true); SB.rpc('mark_request_read',{p_request:id}).then(()=>paintNav()) }
/* the Median app: tell OneSignal who this is, so pushes reach the right phone */
function pushRegister(){
  try{
    const m=window.median||window.gonative; if(!m||!m.onesignal||!ME) return;
    // Median's login expects the external id as a plain string (not an object);
    // passing an object stored it as {"externalId":"..."} and broke targeting.
    if(m.onesignal.login) m.onesignal.login(ME.id);
    else if(m.onesignal.externalUserId&&m.onesignal.externalUserId.set) m.onesignal.externalUserId.set({externalId:ME.id});
    if(m.onesignal.register) m.onesignal.register();
  }catch(e){}
}
function pushForget(){ try{ const m=window.median||window.gonative; if(m&&m.onesignal&&m.onesignal.logout) m.onesignal.logout() }catch(e){} }

/* ---------- password reset ---------- */
function forgotDialog(){
  const pre=(($('#f-email')||{}).value||'').trim();
  modal({title:'Reset your password',
    body:'<p class="hint" style="margin-top:0">Enter your work email. If it is registered, a link arrives within a minute. Open it on any device — set the new password there, then sign in.</p>'+
      '<div style="margin-top:14px"><label for="fp-email">Work email</label><input id="fp-email" type="email" value="'+esc(pre)+'" autocomplete="username"></div>'+
      '<div id="fp-err" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="fp-go">Send the link</button>',
    onOpen:(v,close)=>{
      $('#fp-email',v).focus(); $('#fp-email',v).addEventListener('keydown',e=>{if(e.key==='Enter')$('#fp-go',v).click()});
      $('#fp-go',v).onclick=async()=>{
        const email=$('#fp-email',v).value.trim().toLowerCase();
        if(!/^\S+@\S+\.\S+$/.test(email)) return $('#fp-err',v).textContent='Enter a valid work email.';
        $('#fp-go',v).disabled=true;
        const {error}=await SB.auth.resetPasswordForEmail(email,{redirectTo:APP_URL});
        if(error){ $('#fp-go',v).disabled=false; return $('#fp-err',v).textContent=/rate|limit/i.test(error.message)?'Too many reset emails in a short time. Try again in a few minutes.':error.message }
        close(); toast('If that address is registered, a reset link is on its way.','ok');
      };
    }});
}
/* shown when someone arrives from a reset link, and also used as "change password" from inside the app */
function newPasswordDialog(opts){
  opts=opts||{};
  const m=modal({title:opts.title||'Set a new password', sticky:!opts.cancellable,
    body:'<p class="hint" style="margin-top:0">'+esc(opts.intro||'Choose a password of at least 8 characters. You stay signed in on this device afterwards.')+'</p>'+
      '<div class="grid" style="gap:12px;margin-top:14px"><div><label for="np1">New password</label>'+pwInput('np1')+'</div>'+
      '<div><label for="np2">Type it again</label>'+pwInput('np2')+'</div></div>'+
      '<div id="np-err" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
    footer:(opts.cancellable?'<button class="btn" data-x>Cancel</button>':'')+'<button class="btn primary" id="np-go">Save password</button>',
    onOpen:(v,close)=>{
      setTimeout(()=>{try{$('#np1',v).focus()}catch(e){}},60); $$('input',v).forEach(i=>i.addEventListener('keydown',e=>{if(e.key==='Enter')$('#np-go',v).click()}));
      wirePwEyes(v);
      $('#np-go',v).onclick=async()=>{
        const a=$('#np1',v).value,b=$('#np2',v).value,err=$('#np-err',v),btn=$('#np-go',v);
        if(a.length<8) return err.textContent='At least 8 characters.';
        if(a!==b) return err.textContent='The two entries do not match.';
        btn.disabled=true; btn.textContent='Saving…'; err.textContent='';
        let res;
        try{
          // the auth call can stall inside the app's webview; cap it so the screen never freezes
          res=await Promise.race([ SB.auth.updateUser({password:a}),
            new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),15000)) ]);
          if(res&&res.error) throw res.error;
        }catch(e){
          btn.disabled=false; btn.textContent='Save password';
          const m=(e&&e.message)||'';
          return err.textContent=/timeout/i.test(m)?'That took too long — check your connection and tap Save again.'
            :/same/i.test(m)?'That is already your password. Pick a different one.'
            :(m||'Could not save the password. Please try again.');
        }
        // success: close the dialog and let the app proceed, whatever the follow-ups do
        close(); toast('Password saved.','ok');
        try{ if(opts.onDone) opts.onDone(); }catch(e){}
      };
    }});
}
let recovering=false;

/* ---------- realtime: refresh when something visible changes ---------- */
let channel=null;
function subscribe(){
  unsubscribe(); subscribe._gap=false;
  // each live change refreshes only its own slice (see load()); gate passes and my
  // notifications are applied straight from the event with no download
  channel=SB.channel('setu-live');
  // gate-only / HR-Head accounts don't listen to request & flow changes at all
  if(!gateScopeOnly()) channel
    .on('postgres_changes',{event:'*',schema:'public',table:'requests'},()=>reloadSoon(['legacy']))
    .on('postgres_changes',{event:'*',schema:'public',table:'steps'},()=>reloadSoon(['legacy']))
    .on('postgres_changes',{event:'*',schema:'public',table:'tasks'},()=>reloadSoon(['legacy']))
    .on('postgres_changes',{event:'*',schema:'public',table:'flow_requests'},p=>flowChanged(p,'flow_requests'))
    .on('postgres_changes',{event:'*',schema:'public',table:'flow_steps'},p=>flowChanged(p,'flow_steps'))
    .on('postgres_changes',{event:'*',schema:'public',table:'flow_step_actors'},p=>flowChanged(p,'flow_step_actors'));
  channel
    .on('postgres_changes',{event:'*',schema:'public',table:'gate_passes'},applyPassChange)
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'notifications',filter:'user_id=eq.'+ME.id},p=>{
      const x=p.new||{}; toast(x.title||'Something landed on your desk.','ok');
      if(x.id){ DB.notifs=[mapNotif(x)].concat(DB.notifs.filter(n=>n.id!==x.id)).slice(0,60); renderSoon(); }
      else reloadSoon(['notif']);
      if(document.visibilityState!=='visible'&&'Notification' in window&&Notification.permission==='granted'){
        try{ const nn=new Notification(x.title||'SETU',{body:(x.body||'').split('\n')[0],icon:'icon-192.png',tag:'setu-'+x.id});
          nn.onclick=()=>{window.focus(); gotoNotif(x); nn.close()} }catch(e){}
      }})
    .subscribe(status=>{
      // if the live connection dropped (phone asleep, network blip) we may have missed
      // changes — catch up once when it reconnects, instead of on every app switch
      if(status==='SUBSCRIBED'){ if(subscribe._gap){ subscribe._gap=false; pendingFlowsAll=true; reloadSoon(DATA_PARTS); } }
      else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED'){ subscribe._gap=true; }
    });
  /* on the web, ask once for browser notifications so a background tab can still be tapped on the shoulder */
  if('Notification' in window&&Notification.permission==='default'&&!(window.median||window.gonative)) setTimeout(()=>{try{Notification.requestPermission()}catch(e){}},4000);
}
function unsubscribe(){ if(channel){ SB.removeChannel(channel); channel=null } }

/* ============================================================
   PIN
   ============================================================ */
function tillMidnight(){const n=new Date(),m=new Date(n.getFullYear(),n.getMonth(),n.getDate()+1),ms=m-n;
  return Math.floor(ms/36e5)+'h '+Math.floor(ms%36e5/6e4)+'m'}
function pinBoxes(id){return '<div class="pinbox" id="'+id+'" style="margin:16px 0 6px">'+[0,1,2,3].map(i=>'<input type="password" inputmode="numeric" maxlength="1" aria-label="Digit '+(i+1)+'">').join('')+'</div>'}
function wirePinBoxes(v,id,onEnter){
  const ins=$$('#'+id+' input',v); ins[0].focus();
  ins.forEach((el,i)=>{el.addEventListener('input',()=>{el.value=el.value.replace(/\D/g,'').slice(-1);
      if(el.value&&ins[i+1]) ins[i+1].focus();
      else if(el.value&&i===ins.length-1&&ins.every(x=>x.value)) { el.blur(); setTimeout(onEnter,80) }   // fourth digit in: go
    });
    el.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!el.value&&ins[i-1])ins[i-1].focus();if(e.key==='Enter')onEnter()})});
  return ()=>ins.map(i=>i.value).join('');
}
function pinDialog(){
  modal({title:pinOK(ME)?"Reset today's PIN":"Set today's PIN",
    body:'<p class="hint" style="margin-top:0">A fresh 4-digit PIN for '+esc(fmtD(Date.now()))+'. It stops working at midnight, about '+tillMidnight()+' from now.</p>'+
      pinBoxes('pb')+'<div class="hint">Yesterday\'s PIN cannot be reused. It is stored hashed on the server and never shown back to you.</div>'+
      '<div id="pe" style="color:var(--stop);font-size:13px;margin-top:9px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="ps">Save PIN</button>',
    onOpen:(v,close)=>{
      const code=wirePinBoxes(v,'pb',()=>$('#ps',v).click());
      $('#ps',v).onclick=async()=>{
        try{ await rpc('set_pin',{p_pin:code()}); await reload(); close(); toast('PIN set for today.','ok') }
        catch(e){ $('#pe',v).textContent=(e.message||'').replace(/^.*?: /,'') }
      };
    }});
}
function paintPin(){ const c=$('#pinchip'); if(!c||!ME) return;
  // gate-pass-only / HR-head accounts never sign anything with a PIN — hide the chip entirely
  if(restrictedAcct()){ c.style.display='none'; return; }
  c.style.display='';
  const narrow=window.innerWidth<900;
  if(pinOK(ME)){c.classList.add('ok');$('#pinchip-txt').textContent=narrow?'PIN · '+tillMidnight():'PIN active · '+tillMidnight()+' left'}
  else{c.classList.remove('ok');$('#pinchip-txt').textContent=narrow?'Set PIN':"Set today's PIN"} }
$('#pinchip').onclick=pinDialog;
/* the PIN is collected here and sent with the decision; the server checks it */
function confirmPin(label,then){
  if(!pinOK(ME)) return modal({title:'Set your PIN first',
    body:'<p style="margin-top:0">Decisions are signed with a daily PIN. You have not set one for '+esc(fmtD(Date.now()))+'.</p>',
    footer:'<button class="btn" data-x>Not now</button><button class="btn primary" id="g">Set PIN</button>',
    onOpen:(v,c)=>{$('#g',v).onclick=()=>{c();pinDialog()}}});
  modal({title:'Confirm with your PIN',
    body:'<p style="margin-top:0">You are about to <b>'+esc(label)+'</b>. Enter today\'s PIN to sign it.</p>'+pinBoxes('cb')+
      '<div id="ce" style="color:var(--stop);font-size:13px;margin-top:8px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="cg">Sign and continue</button>',
    onOpen:(v,close)=>{
      const code=wirePinBoxes(v,'cb',()=>$('#cg',v).click());
      $('#cg',v).onclick=async()=>{
        const c=code(); if(c.length!==4){$('#ce',v).textContent='Enter all four digits.';return}
        $('#cg',v).disabled=true;
        try{ await then(c); close() }
        catch(e){ $('#ce',v).textContent=(e.message||'').replace(/^.*?: /,''); $$('#cb input',v).forEach(i=>i.value=''); $$('#cb input',v)[0].focus() }
        finally{ const b=$('#cg',v); if(b) b.disabled=false }
      };
    }});
}

/* ============================================================
   Navigation
   ============================================================ */
/* pages that can be turned off per person; the rest are always shown when the person has work there */
const OPTIONAL_PAGES=[
  {k:'new',label:'Raise a request'},
  {k:'gate',label:'Gate Pass'},
  {k:'tpl',label:'Saved hierarchies'},
  {k:'team',label:'My team (managers only)'},
  {k:'all',label:'Requests I can see'},
  {k:'report',label:'Reports'},
  {k:'people',label:'People & masters'},
  {k:'usage',label:'Usage'}
];
const DEFAULT_PAGES=['new','gate','tpl','team','all','report'];   // a plain user's standard set
function allowedPages(u){
  if(u.admin||u.owner) return OPTIONAL_PAGES.map(p=>p.k);   // admins run the system: every page
  let set=Array.isArray(u.pages)?u.pages.slice():DEFAULT_PAGES.slice();   // explicit set, else role default
  if((u.canCreateUsers||u.canManageUsers)&&set.indexOf('people')<0) set=set.concat('people');  // sub-admins get the People page
  return set;
}
/* sub-admin = user-desk powers without full Admin (see-all, reports, masters) */
const CAN_CREATE=()=>!!(ME&&(ME.admin||ME.owner||ME.canCreateUsers));
const CAN_MANAGE=()=>!!(ME&&(ME.admin||ME.owner||ME.canManageUsers));
// a sub-admin (user-desk powers only, not a full admin) manages users and nothing else
const SUBADMIN=()=>!!(ME&&(ME.canCreateUsers||ME.canManageUsers)&&!ME.admin&&!ME.owner);
const GRANTS_ROLES=()=>!!(ME&&(ME.admin||ME.owner));   // who may set see-all / admin / sub-admin
// may the signed-in person edit this user? sub-admins cannot touch an Admin or the owner
const canEditUser=u=>{ if(ME.admin||ME.owner) return !u.owner||u.id===ME.id; if(ME.canManageUsers) return !u.admin&&!u.owner; return false; };
// Garuda (CNG stock) is open to anyone who can see CNG, plus anyone granted Garuda access
const canUseGaruda=()=>!!(ME&&(ME.owner||ME.admin||ME.unit==='CNG'||(ME.deptsVisible||[]).indexOf('CNG')>-1||ME.garudaAccess||ME.garudaStore||ME.garudaSite));
const canGarudaStore=()=>!!(ME&&(ME.owner||ME.admin||ME.garudaStore));   // issues out / accepts returns
const canGarudaSite=()=>!!(ME&&(ME.owner||ME.admin||ME.garudaSite));     // allots (fits) / consumes
const canSeePage=k=>{ const set=allowedPages(ME); return set.indexOf(k)>-1 };
const GATE_ONLY=()=>!!(ME&&ME.gateOnly&&!ME.admin&&!ME.owner);   // gate-only accounts see only the Gate Pass page
const ASSISTANT=()=>!!(ME&&ME.assistsId&&!ME.admin&&!ME.owner);  // a proxy who assists one principal
const myPrincipal=()=>ASSISTANT()?user(ME.assistsId):null;
// restricted accounts (gate-only, HR head, or assistant) are limited to their own page(s)
const restrictedAcct=()=>GATE_ONLY()||ASSISTANT()||!!(ME&&ME.hrHead&&!ME.admin&&!ME.owner)||SUBADMIN();
const restrictedPage=k=>{ if(!restrictedAcct()) return true;
  if(ASSISTANT()) return k==='assist'||k==='gate'||k==='detail'||k==='flowdetail';   // worklist + own gate passes + read-only detail
  if(SUBADMIN()) return k==='people'||k==='gate'||k==='gpreport'||k==='inbox'||k==='garuda';   // manage users (+ gate pass as an employee)
  return k==='gate'||k==='gpreport'; };
const PAGES=[
  {k:'dash',label:'Dashboard',grp:'Overview'},
  {k:'assist',label:'Assisting',grp:'Overview',when:()=>ASSISTANT(),badge:()=>assistErpTodo().length},
  {k:'inbox',label:'Notifications',grp:'Overview',badge:()=>unread().length},
  {k:'new',label:'Raise a request',grp:'Overview'},
  {k:'gate',label:'Gate Pass',grp:'Overview',badge:()=>gpBadge()},
  {k:'gpreport',label:'Gate Pass Reports',grp:'Overview',when:()=>canSeeReports()},
  {k:'queue',label:'Waiting on me',grp:'My work',badge:()=>myQueue().length+flowMyTurn().length},
  {k:'tasks',label:'Tasks given to me',grp:'My work',badge:()=>myTasks().length},
  {k:'stuck',label:'Needs my input',grp:'My work',badge:()=>myStuck().length+flowTagged().length},
  {k:'mine',label:'My requests',grp:'My work'},
  {k:'tpl',label:'Saved hierarchies',grp:'My work',badge:()=>myTemplates().length},
  {k:'team',label:'My team',grp:'My work',when:()=>isManager(ME),badge:()=>pendingTeam(ME.id).length},
  {k:'all',label:'Requests I can see',grp:'Records'},
  {k:'report',label:'Reports',grp:'Records'},
  {k:'overview',label:'System overview',grp:'Records',when:()=>ME.owner},
  {k:'people',label:'People & masters',grp:'Records'},
  {k:'garuda',label:'Garuda (CNG stock)',grp:'Records',when:()=>canUseGaruda()},
  {k:'usage',label:'Usage',grp:'Records',when:()=>ME.admin||ME.seeAll}
];
function paintNav(){
  if(!ME) return;
  let h='',g='';
  PAGES.filter(p=>restrictedPage(p.k)).filter(p=>!p.when||p.when()).filter(p=>OPTIONAL_PAGES.every(o=>o.k!==p.k)||canSeePage(p.k)).forEach(p=>{ if(p.grp!==g){g=p.grp;h+='<div class="grp">'+esc(g)+'</div>'}
    const n=p.badge?p.badge():0;
    h+='<button data-k="'+p.k+'" class="'+(ROUTE.name===p.k?'on':'')+'">'+esc(p.label)+(n?'<span class="pill">'+n+'</span>':'')+'</button>'});
  $('#nav').innerHTML=h;
  $$('#nav button').forEach(b=>b.onclick=()=>go({name:b.dataset.k}));
  paintTabbar();
}
/* the five things a phone needs within thumb reach; everything else is under More */
const ICON={
  home:'<svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  desk:'<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  plus:'<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  bell:'<svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0v5l2 3H4l2-3zM10 19a2 2 0 0 0 4 0"/></svg>',
  more:'<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>'};
function paintTabbar(){
  const bar=$('#tabbar'); if(!bar||!ME) return;
  const on=k=>ROUTE.name===k?'on':'';
  if(restrictedAcct()){
    bar.innerHTML='<button data-k="gate" class="raise '+on('gate')+'">'+ICON.plus+'Gate Pass'+(gpBadge()?'<span class="pill">'+gpBadge()+'</span>':'')+'</button>'+
      (canSeeReports()?'<button data-k="gpreport" class="'+on('gpreport')+'">'+ICON.desk+'Reports</button>':'')+
      '<button data-k="more" class="'+(!['gate','gpreport'].includes(ROUTE.name)?'on':'')+'">'+ICON.more+'More</button>';
    $$('button',bar).forEach(b=>b.onclick=()=>{ if(b.dataset.k==='more') moreSheet(); else go({name:b.dataset.k}) });
    return;
  }
  const desk=myQueue().length+myTasks().length+myStuck().length+flowMyTurn().length+flowTagged().length, un=unread().length;
  const inDesk=['queue','tasks','stuck'].includes(ROUTE.name);
  const inMore=!['dash','queue','tasks','stuck','new','inbox'].includes(ROUTE.name);
  bar.innerHTML=
    '<button data-k="dash" class="'+on('dash')+'">'+ICON.home+'Home</button>'+
    '<button data-k="queue" class="'+(inDesk?'on':'')+'">'+ICON.desk+'My desk'+(desk?'<span class="pill">'+desk+'</span>':'')+'</button>'+
    '<button data-k="new" class="raise '+on('new')+'">'+ICON.plus+'Raise</button>'+
    '<button data-k="inbox" class="'+on('inbox')+'">'+ICON.bell+'Alerts'+(un?'<span class="pill">'+un+'</span>':'')+'</button>'+
    '<button data-k="more" class="'+(inMore?'on':'')+'">'+ICON.more+'More</button>';
  $$('button',bar).forEach(b=>b.onclick=()=>{ if(b.dataset.k==='more') moreSheet(); else go({name:b.dataset.k}) });
}
function moreSheet(){
  const items=PAGES.filter(p=>restrictedPage(p.k)).filter(p=>!p.when||p.when()).filter(p=>!['dash','new','inbox'].includes(p.k)).filter(p=>OPTIONAL_PAGES.every(o=>o.k!==p.k)||canSeePage(p.k));
  modal({title:'More',
    body:'<div class="sheet-list">'+items.map(p=>{const b=p.badge?p.badge():0;
        return '<button data-go="'+p.k+'">'+esc(p.label)+(b?'<span class="pill">'+b+'</span>':'')+'</button>'}).join('')+
      (restrictedAcct()?'':'<button data-act="pin">'+(pinOK(ME)?"Reset today's PIN":"Set today's PIN")+'</button>')+
      '<button data-act="me">My directory entry</button><button data-act="pw">Change password</button>'+
      '<button data-act="out" style="color:var(--stop)">Sign out</button></div>'+
      '<div class="hint" style="margin-top:12px;text-align:center">'+esc(ME.name)+' · '+esc(ME.role||'')+'<br>Built by Sunny Gupta</div>',
    onOpen:(v,close)=>{
      $$('[data-go]',v).forEach(b=>b.onclick=()=>{const k=b.dataset.go;close();setTimeout(()=>go({name:k}),0)});
      $$('[data-act]',v).forEach(b=>b.onclick=()=>{close();const a=b.dataset.act;
        if(a==='pin')pinDialog(); else if(a==='me')profileDialog(); else if(a==='pw')newPasswordDialog({title:'Change your password',cancellable:true}); else if(a==='out')doSignOut()});
    }});
}
/* every screen is a history entry, so the Android back button (and the browser's)
   steps back through screens instead of leaving the app */
const routeHash=r=>'#'+r.name+(r.id?'/'+r.id:'');
const go=(r,replace)=>{
  ROUTE=r;
  // navigating always dismisses any open dialog so we never leave a stuck overlay
  try{ $$('.veil').forEach(x=>x.remove()); }catch(e){}
  try{ const url=location.pathname+location.search+routeHash(r);
    if(replace||!history.state) history.replaceState(r,'',url); else if(routeHash(history.state)!==routeHash(r)) history.pushState(r,'',url) }catch(e){}
  paintNav();paintPin();render();window.scrollTo(0,0);
};
window.addEventListener('popstate',e=>{
  if(skipPop){ skipPop=false; return }              // a dialog closed itself and rewound its own entry
  if($('.veil')) return;                            // back pressed with a dialog open: the dialog handles it, the screen stays
  if(ME&&e.state&&e.state.name){ ROUTE=e.state; paintNav(); paintPin(); render(); window.scrollTo(0,0) }
});
/* A link opened while the app is already running (e.g. tapping a push notification)
   may only change the #address. Follow it. Back/forward between our own screens is
   handled by popstate above, which runs first, so this is then a no-op. */
window.addEventListener('hashchange',()=>{ if(!ME) return; const h=routeFromHash(); if(h&&routeHash(h)!==routeHash(ROUTE)) go(h,true); });
/* deep links: opening .../#detail/<id> lands on that request once signed in */
function routeFromHash(){ const m=location.hash.match(/^#([a-z]+)(?:\/([\w-]+))?$/); return m?{name:m[1],id:m[2]}:null }
const head=(t,s)=>{$('#page-title').textContent=t;$('#page-sub').textContent=s||''};
function render(){
  if(!ME) return;
  if(restrictedAcct()&&!restrictedPage(ROUTE.name)) ROUTE=ASSISTANT()?{name:'assist'}:SUBADMIN()?{name:'people'}:{name:'gate'};   // restricted accounts stay within their own pages
  if(ROUTE.name==='gpreport'&&!canSeeReports()) ROUTE={name:GATE_ONLY()||HR_HEAD()?'gate':'dash'};
  if(OPTIONAL_PAGES.some(o=>o.k===ROUTE.name)&&!canSeePage(ROUTE.name)) ROUTE={name:'dash'};
  if(ROUTE.name==='overview'&&!ME.owner) ROUTE={name:'dash'};   // owner-only analytics
  // Garuda takes over the screen (its own top bar + column dropdown); SETU nav hides
  const appEl=document.getElementById('app'); if(appEl) appEl.classList.toggle('garuda-mode', ROUTE.name==='garuda');
  const v=$('#view');
  switch(ROUTE.name){
    case 'dash': v.innerHTML=viewDash(); wireDash(v); break;
    case 'inbox': v.innerHTML=viewInbox(); wireInbox(v); break;
    case 'new': v.innerHTML=viewNew(); wireNew(v); break;
    case 'queue': v.innerHTML=viewList(myQueue(),'Waiting on me','Requests that cannot move until you act.','Nothing is waiting on you','Requests land here the moment the person before you signs off.',(flowMyTurn().length+legacyAwaiting().length+flowAwaitingReply().length)>0)+flowSection('turn')+legacyAwaitingSection()+flowSection('awaiting'); wireList(v); wireFlowRows(v); break;
    case 'tasks': v.innerHTML=viewTasks(); wireList(v); break;
    case 'stuck': v.innerHTML=viewList(myStuck(),'Needs my input','An approver has asked you (or tagged you) for more before they will sign.','No one has asked you for anything','If an approver needs a clarification or tags you, it comes here.',flowTagged().length>0)+flowSection('tagged'); wireList(v); wireFlowRows(v); break;
    case 'mine': v.innerHTML=viewList(DB.requests.filter(r=>r.requesterId===ME.id),'My requests','Everything you have raised.','You have not raised anything yet','Start with Raise a request.',flowMine().length>0)+flowSection('mine'); wireList(v); wireFlowRows(v); break;
    case 'tpl': v.innerHTML=viewTpl(); wireTpl(v); break;
    case 'team': v.innerHTML=viewTeam(); wireTeam(v); break;
    case 'all': v.innerHTML=viewAll()+flowSection('all'); wireList(v); wireFlowRows(v);
      head(ME.admin||ME.seeAll?'All requests':'Requests I can see',ME.admin||ME.seeAll?'You can see every chain in the system':'Only chains you raised, approve, or were given a task in'); break;
    case 'report': v.innerHTML=viewReport(); wireReport(v); head('Reports','Filter the record and download it'); break;
    case 'usage': ensureUsage(); v.innerHTML=viewUsage(); wireUsage(v); break;
    case 'overview': ensureUsage(); v.innerHTML=viewOverview(); wireOverview(v); break;
    case 'assist': v.innerHTML=viewAssist(); wireAssist(v); break;
    case 'people': v.innerHTML=viewPeople(); wirePeople(v); head('People & masters','Directory, station master and the permanence rule'); break;
    case 'garuda': if(!canUseGaruda()){ROUTE={name:'dash'};return render();} v.innerHTML=viewGaruda(); wireGaruda(v); head('Garuda — CNG stock','Item & station masters, and processed GRNs with QR codes'); break;
    case 'detail': v.innerHTML=viewDetail(ROUTE.id); wireDetail(v); break;
    case 'gate': v.innerHTML=viewGate(); wireGate(v); break;
    case 'gpreport': v.innerHTML=viewGpReport(); wireGpReport(v); break;
    case 'flowdetail': v.innerHTML=viewFlowDetail(ROUTE.id); wireFlowDetail(v); break;
  }
}

/* ============================================================
   Dashboard
   ============================================================ */
const stat=(k,v,s,acc,nav)=>'<div class="card stat'+(nav?' tap':'')+'"'+(nav?' data-navk="'+esc(nav)+'" role="button" tabindex="0"':'')+' style="--acc:'+(acc||'var(--indigo)')+'"><div class="k">'+esc(k)+'</div><div class="v num">'+esc(String(v))+'</div><div class="hint">'+esc(s||'')+'</div></div>';
function tagFor(r){
  const m={'In Progress':['t-prog','In progress'],'Approved':['t-ok','Approved'],'Rejected':['t-bad','Rejected'],'Info Requested':['t-hold','More details needed']};
  const x=m[r.status]||['t-wait',r.status]; return '<span class="tag '+x[0]+'">'+x[1]+'</span>';
}
function viewDash(){
  head('Dashboard','Good to see you, '+ME.name.split(' ')[0]);
  const all=visible(), mine=all.filter(r=>r.requesterId===ME.id), q=myQueue(), st=myStuck(), tk=myTasks();
  const open=all.filter(r=>r.status==='In Progress'||r.status==='Info Requested');
  const counts={'In Progress':all.filter(r=>r.status==='In Progress').length,'Info Requested':all.filter(r=>r.status==='Info Requested').length,
    'Approved':all.filter(r=>r.status==='Approved').length,'Rejected':all.filter(r=>r.status==='Rejected').length};
  const tot=Math.max(1,all.length), aged=open.filter(r=>daysBetween(r.createdAt,Date.now())>=7).length;
  const bars=Object.entries(counts).map(([k,v])=>{const c=k==='Approved'?'var(--seal)':k==='Rejected'?'var(--stop)':k==='Info Requested'?'var(--hold)':'var(--indigo)';
    return '<div style="margin-bottom:12px"><div class="row" style="justify-content:space-between;font-size:13px;margin-bottom:5px"><span>'+k+'</span><b class="num">'+v+'</b></div>'+
      '<div class="bar"><i style="width:'+Math.round(v/tot*100)+'%;background:'+c+'"></i></div></div>'}).join('');
  const line=r=>'<tr data-r="'+r.id+'"><td><b>'+esc(docTitle(r))+'</b><div class="hint">'+esc(typeLabel(r))+' · '+esc(r.ref)+' · '+esc(user(r.requesterId).name)+'</div></td>'+
    '<td class="hint num meta">'+daysBetween(r.createdAt,Date.now())+'d open</td><td class="meta">'+tagFor(r)+'</td></tr>';
  const warn=!pinOK(ME)?'<div class="banner hold"><div><b>Your PIN is not set for today.</b><div class="hint" style="color:var(--hold)">You cannot approve, reject or send anything back until you set it.</div></div><button class="btn hold sm" style="margin-left:auto" id="d-pin">Set PIN</button></div>':'';
  const flowTurn=flowMyTurn().length;
  // recent activity merges the legacy request trail and the ALDS flow trail
  const flowFeed=[]; DB.flows.forEach(f=>f.audit.forEach(a=>flowFeed.push({ts:a.ts,actorName:a.actorName,action:a.action,detail:a.detail,ref:f.ref,flowId:f.id})));
  const feed=DB.audit.map(a=>({ts:a.ts,actorName:a.actorName,action:a.action,detail:a.detail,ref:a.ref,reqId:a.reqId}))
    .concat(flowFeed).sort((a,b)=>b.ts-a.ts).slice(0,16);
  return warn+'<div class="grid g4">'+
    stat('Waiting on me',q.length+flowTurn,(q.length+flowTurn)?'Act to unblock the chain':'You are all clear','var(--indigo)','queue')+
    stat('Tasks given to me',tk.length,tk.length?'Close these to unblock a manager':'No task assigned to you','var(--cyan)','tasks')+
    stat('Needs my input',st.length+flowTagged().length,(st.length+flowTagged().length)?'Someone asked or tagged you':'Nothing sent back to you','var(--hold)','stuck')+
    stat('Open beyond 7 days',aged,'Out of '+open.length+' open requests',aged?'var(--stop)':'var(--seal)','all')+'</div>'+
  flowDashCard()+
  flowSection('tagged')+legacyAwaitingSection()+flowSection('awaiting')+
  (q.length||st.length
    ?'<div class="grid g2" style="margin-top:14px;align-items:start">'+
      (q.length?'<div class="card"><div class="row" style="padding:14px 18px;border-bottom:1px solid var(--line)"><h3>Waiting on me</h3><span class="tag t-prog" style="margin-left:auto">'+q.length+'</span></div><table class="cards"><tbody>'+q.map(line).join('')+'</tbody></table></div>':'')+
      (st.length?'<div class="card"><div class="row" style="padding:14px 18px;border-bottom:1px solid var(--line)"><h3>Sent back to me</h3><span class="tag t-hold" style="margin-left:auto">'+st.length+'</span></div><table class="cards"><tbody>'+st.map(r=>'<tr data-r="'+r.id+'"><td><b>'+esc(docTitle(r))+'</b><div class="hint">Stuck at step '+(r.infoStep+2)+' with '+esc(user(r.chain[r.infoStep].userId).name)+'</div></td></tr>').join('')+'</tbody></table></div>':'')+
     '</div>'
    :'<div class="card" style="margin-top:14px"><div class="empty" style="padding:26px 16px"><h3>Your desk is clear</h3><p class="hint">Requests appear here the moment the person before you signs off, and anything sent back to you lands here too.</p></div></div>')+
  '<div class="grid g2" style="margin-top:18px;align-items:start">'+
   '<div class="card pad"><h3 style="margin-bottom:14px">Where everything stands</h3>'+bars+'<div class="sep"></div><div class="row" style="justify-content:space-between"><span class="hint">'+all.length+' requests · '+mine.length+' raised by you</span>'+
     '<button class="btn ghost sm" id="d-all">Open all requests</button></div></div>'+
   '<div class="card"><div class="row" style="padding:16px 18px;border-bottom:1px solid var(--line)"><h3>Recent activity</h3></div>'+
     (feed.length?'<div style="max-height:330px;overflow:auto">'+feed.map(a=>'<div style="padding:11px 18px;border-bottom:1px solid var(--line);display:flex;gap:11px"><div class="av sm">'+inits(a.actorName)+'</div>'+
       '<div style="min-width:0"><div style="font-size:13.5px"><b>'+esc(a.actorName)+'</b> '+esc(a.action.toLowerCase())+' <a href="#" '+(a.flowId?'data-flowgo="'+a.flowId+'"':'data-r="'+a.reqId+'"')+'>'+esc(a.ref)+'</a></div>'+
       '<div class="hint">'+esc(fmtDT(a.ts))+(a.detail?' · '+esc(a.detail):'')+'</div></div></div>').join('')+'</div>'
      :'<div class="empty"><h3>No activity yet</h3><p class="hint">Raise the first request to start the record.</p></div>')+'</div></div>';
}
/* ALDS flows on the dashboard — visible to everyone, so the landing page reflects
   live flow activity even for people not sitting in a legacy approval chain. */
let dashQ='';   // dashboard quick-search text (flows + legacy by any number / file no.)
function flowDashCard(){
  const running=DB.flows.filter(f=>f.status==='running').sort((a,b)=>b.createdAt-a.createdAt);
  const turn=flowMyTurn().length, recent=running.slice(0,8);
  return '<div class="card" style="margin-top:14px"><div class="row" style="padding:14px 18px;border-bottom:1px solid var(--line)"><h3>ALDS PO / WO flows</h3>'+
    '<span class="tag t-prog" style="margin-left:auto">'+running.length+' in progress</span>'+(turn?'<span class="tag t-wait" style="margin-left:6px">'+turn+' waiting on you</span>':'')+'</div>'+
    '<div class="row" style="padding:10px 16px;border-bottom:1px solid var(--line);gap:8px;flex-wrap:wrap"><input id="d-flowq" type="search" placeholder="Search a number — indent / PO / WO / uploaded file no." style="flex:1;min-width:200px" value="'+esc(dashQ||'')+'"><span class="hint" id="d-flowcount" style="align-self:center"></span></div><div id="d-flowres"></div>'+
    (recent.length?'<table class="cards"><tbody>'+recent.map(f=>{
      return '<tr data-flowgo="'+f.id+'"><td><b>'+esc(f.ref)+'</b> <span class="hint">'+esc(flowHeadLabel(f.head))+' · '+esc(f.division)+'</span>'+
        '<div class="hint">'+esc(f.title||'(no number)')+' · by '+esc(user(f.requesterId).name)+'</div></td>'+
        '<td class="hint meta">'+esc(flowWhere(f))+'</td><td class="meta">'+(flowActionableByMe(f)?'<span class="tag t-prog">Your turn</span>':flowTaggedToMe(f)?'<span class="tag t-hold">Your input needed</span>':flowAwaitingMyReply(f)?'<span class="tag t-wait">Awaiting reply</span>':(flowCanEscalate(f)?'<span class="tag t-hold">Can escalate</span>':'<span class="tag t-wait">In progress</span>'))+'</td></tr>';}).join('')+'</tbody></table>'+
      (running.length>recent.length?'<div class="row" style="padding:10px 18px"><button class="btn ghost sm" id="d-flows" style="margin-left:auto">See all '+running.length+' flows</button></div>':'')
    :'<div class="empty" style="padding:22px 16px"><h3>No active flows</h3><p class="hint">ALDS indents and work orders appear here as they are raised — everyone can see them.</p></div>')+'</div>';
}
function wireDash(v){
  if($('#d-pin',v)) $('#d-pin',v).onclick=pinDialog;
  if($('#d-all',v)) $('#d-all',v).onclick=()=>go({name:'all'});
  if($('#d-flows',v)) $('#d-flows',v).onclick=()=>go({name:'all'});
  // tappable summary tiles jump straight into their list
  $$('[data-navk]',v).forEach(b=>{ b.onclick=()=>go({name:b.dataset.navk});
    b.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); go({name:b.dataset.navk}); } }; });
  // quick search on the flows card — find any flow or request by number/file, jump straight to it
  const fq=$('#d-flowq',v), fres=$('#d-flowres',v);
  if(fq&&fres){
    const run=()=>{ const s=fq.value.trim().toLowerCase(); dashQ=fq.value; const c=$('#d-flowcount',v);
      if(s.length<2){ fres.innerHTML=''; if(c)c.textContent=''; return; }
      const fl=DB.flows.filter(f=>_flowHay(f).includes(s)).slice(0,8)
        .map(f=>({k:'flowdetail',id:f.id,ref:f.ref,sub:flowHeadLabel(f.head)+' · '+(f.title||'(no number)')+' · '+flowWhere(f)}));
      const lg=DB.requests.filter(r=>_legHay(r).includes(s)).slice(0,6)
        .map(r=>({k:'detail',id:r.id,ref:r.ref,sub:typeLabel(r)+' · '+docTitle(r)}));
      const hits=fl.concat(lg).slice(0,10);
      if(c) c.textContent=hits.length?(hits.length+' match'+(hits.length===1?'':'es')):'No match';
      fres.innerHTML=hits.length?'<div class="results" style="padding:6px 10px;gap:4px">'+hits.map(h=>'<button data-gk="'+h.k+'" data-gid="'+esc(h.id)+'" style="text-align:left;width:100%"><div style="min-width:0"><b>'+esc(h.ref)+'</b><div class="hint">'+esc(h.sub)+'</div></div></button>').join('')+'</div>':'';
      $$('[data-gk]',fres).forEach(b=>b.onclick=()=>go({name:b.dataset.gk,id:b.dataset.gid}));
    };
    fq.oninput=run; if(dashQ) run();
  }
  $$('tr[data-r]',v).forEach(t=>t.onclick=()=>go({name:'detail',id:t.dataset.r}));
  $$('a[data-r]',v).forEach(a=>a.onclick=e=>{e.preventDefault();go({name:'detail',id:a.dataset.r})});
  $$('tr[data-flowgo]',v).forEach(t=>t.onclick=()=>go({name:'flowdetail',id:t.dataset.flowgo}));
  $$('a[data-flowgo]',v).forEach(a=>a.onclick=e=>{e.preventDefault();go({name:'flowdetail',id:a.dataset.flowgo})});
  wireFlowRows(v);   // the tagged / awaiting-reply flow sections on the dashboard
}

/* ============================================================
   Raise a request
   ============================================================ */
let draft=null, formTab='indent';
/* ALDS fixed-flow routing: when an ALDS request's division maps to a flow division
   (O&M / Project / Retail), the request is a fixed PO/WO flow — no approver chain is
   picked; the company hierarchy is applied automatically. ALDS Transport and every
   other department stay on the free-form chain. */
const FLOW_DIV_MAP={'ONM':'O&M','O&M':'O&M','Project':'Project','Retail':'Retail'};
const flowDivOf=d=>FLOW_DIV_MAP[d]||null;
const isFlowDraft=()=>!!(draft&&draft.f&&((draft.f.department==='ALDS'&&flowDivOf(draft.f.division))||draft.f.department==='CNG'));
function viewNew(){
  head('Raise a request','Attach the ERP document, check what was read from it, then set the chain. ALDS O&M / Project / Retail follow their fixed flow automatically.');
  if(!draft||draft.type!==formTab) draft={type:formTab,files:[],support:[],chain:[],f:{category:'O&M'},conf:{},meta:{}};
  return '<div class="tabs"><button data-t="indent" class="'+(formTab==='indent'?'on':'')+'">Indent</button>'+
    '<button data-t="workorder" class="'+(formTab==='workorder'?'on':'')+'">Work order</button></div>'+
    '<div id="form-body">'+(formTab==='indent'?indentForm():woForm())+'</div>'+
    '<div class="row form-actions" style="margin-top:18px;gap:10px;flex-wrap:wrap"><button class="btn primary" id="n-send">Send for approval</button>'+
    '<button class="btn" id="n-clear">Clear form</button><span class="hint" id="n-note"></span></div>';
}
const txt=(id,label,val,conf,ph)=>'<div class="auto '+(conf||'')+'"><label for="'+id+'">'+esc(label)+(conf?'<span class="flag '+conf+'">'+(conf==='hi'?'from PDF':'check this')+'</span>':'')+'</label>'+
  '<input id="'+id+'" type="text" value="'+esc(val||'')+'"'+(ph?' placeholder="'+esc(ph)+'"':'')+'></div>';
const area=(id,label,val,conf,ph)=>'<div class="auto '+(conf||'')+'"><label for="'+id+'">'+esc(label)+(conf?'<span class="flag '+conf+'">from PDF</span>':'')+'</label>'+
  '<textarea id="'+id+'"'+(ph?' placeholder="'+esc(ph)+'"':'')+'>'+esc(val||'')+'</textarea></div>';
/* Department and Division — mandatory, Division cascades from Department */
function orgFields(){
  const f=draft.f, divs=f.department?(DEPT_DIV[f.department]||[]):[];
  const req='<span style="color:var(--stop)">*</span>';
  // Division is mandatory only for ALDS (it selects the fixed flow); optional elsewhere.
  const divReq=f.department==='ALDS'?req:'<span class="hint" style="font-weight:400">optional</span>';
  return '<div class="grid g2">'+
    '<div><label for="o-dept">Department '+req+'</label><select id="o-dept"><option value="">Choose…</option>'+
      DEPTS.map(d=>'<option '+(f.department===d?'selected':'')+'>'+esc(d)+'</option>').join('')+'</select></div>'+
    '<div><label for="o-div">Division '+divReq+'</label><select id="o-div"'+(f.department?'':' disabled')+'><option value="">'+(f.department?(f.department==='ALDS'?'Choose…':'Choose… (optional)'):'Pick a department first')+'</option>'+
      divs.map(x=>'<option '+(f.division===x?'selected':'')+'>'+esc(x)+'</option>').join('')+'</select></div></div>';
}
const uploadCard=()=>'<div class="card pad"><h3>The ERP document</h3><p class="hint" style="margin-top:5px">The indent or work order PDF the ERP generated. The fields below fill in from it — every one of them stays editable.</p><div id="n-files" style="margin-top:14px"></div></div>'+
  '<div class="card pad" id="n-supp-card"><h3>Supporting documents <span class="hint" style="font-weight:400">optional</span></h3>'+
  '<p class="hint" style="margin-top:5px">Quotations, comparison sheets, photos of the site or the equipment, a signed note — anything an approver would want alongside the ERP document. Photos are shrunk before upload, so send them straight from the phone.</p>'+
  '<div id="n-support" style="margin-top:14px"></div></div>';
function chainCard(){
  const tpl=myTemplates();
  return '<div class="card pad"><h3>Who signs it off</h3><p class="hint" style="margin-top:5px">Search anyone registered and add them in order. Each person gets it only once the one above has finished.</p>'+
  '<div style="margin-top:14px"><label for="n-tpl">Use a saved hierarchy</label>'+
  (tpl.length?'<select id="n-tpl"><option value="">Build it from scratch</option>'+tpl.map(t=>'<option value="'+t.id+'">'+esc(t.name)+' ('+t.steps.length+' step'+(t.steps.length===1?'':'s')+')'+(t.shared?' · shared':'')+'</option>').join('')+'</select><div class="hint">Manage these under Saved hierarchies.</div>'
    :'<div class="hint" style="margin-top:0">You have none saved yet. Build the chain below and a save button appears, or set them up under <button class="btn ghost sm" id="n-tpl-go" style="padding:0">Saved hierarchies</button>.</div>')+'</div>'+
  '<div class="finder" style="margin-top:14px"><label for="n-find">Add an approver</label><input id="n-find" type="text" placeholder="Name, email, designation or department" autocomplete="off"><div id="n-res"></div></div>'+
  '<div id="n-chain"></div><div id="n-tplsave" class="hide" style="margin-top:12px"><button class="btn sm" id="n-save-tpl">Save this chain as a hierarchy</button></div></div>';
}
/* the right column: the approver chain for a normal request, or — for an ALDS
   PO/WO flow — a note explaining the fixed hierarchy (no chain to build). */
function rightCol(){
  if(isFlowDraft()){
    if(draft.f.department==='CNG'){
      return '<div class="card pad"><h3>Fixed approval flow</h3>'+
        '<p class="hint" style="margin-top:5px">This is a <b>CNG</b> indent, so it follows the company\'s fixed <b>CNG</b> approval flow — indent approval, PO/WO approval, then GRN. You do not pick approvers here.</p>'+
        '<div class="hint" style="margin-top:10px">When you send it, the whole chain is built automatically and step 1 is signed with your daily PIN. Each approver can Approve or Hold; a Hold pauses it in place until it is resumed.</div></div>';
    }
    const hd=formTab==='indent'?'ALDS PO':'ALDS WO', div=flowDivOf(draft.f.division);
    return '<div class="card pad"><h3>Fixed approval flow</h3>'+
      '<p class="hint" style="margin-top:5px">This is an <b>'+esc(hd)+'</b> request in the <b>'+esc(div)+'</b> division, so it follows the company\'s fixed '+esc(hd)+' hierarchy. You do not pick approvers here.</p>'+
      '<div class="hint" style="margin-top:10px">When you send it, the whole chain is built automatically and step 1 is signed with your daily PIN. Everyone can watch its progress; each person acts only at their own point.</div></div>';
  }
  return chainCard();
}
function indentForm(){
  const f=draft.f,c=draft.conf;
  return '<div class="detail-grid"><div class="grid" style="gap:16px">'+uploadCard()+
   '<div class="card pad"><h3>Indent details</h3><div class="grid" style="gap:14px;margin-top:14px">'+
     orgFields()+
     '<div class="grid g2">'+txt('i-no','Indent number',f.indentNo,c.indentNo,'IH26605-007')+
       '<div><label for="i-cat">Category</label><select id="i-cat">'+['O&M','Project'].map(x=>'<option '+(f.category===x?'selected':'')+'>'+x+'</option>').join('')+'</select></div></div>'+
     '<div id="i-subcatwrap"></div>'+
     '<div id="i-sitewrap"></div>'+
     '<div class="grid g2"><div class="auto '+(c.indentDate||'')+'"><label for="i-date">Date of indent'+(c.indentDate?'<span class="flag hi">from PDF</span>':'')+'</label><input id="i-date" type="date" value="'+esc(f.indentDate||'')+'"></div>'+
       txt('i-erp','ERP prepared on (date & time)',f.erpCreated,c.erpCreated,'e.g. 05-JUN-2026 04:29 PM')+'</div>'+
     area('i-rem','Remarks',f.remarks,c.remarks,'What this indent is for.')+'</div></div></div><div>'+rightCol()+'</div></div>';
}
function woForm(){
  const f=draft.f,c=draft.conf;
  return '<div class="detail-grid"><div class="grid" style="gap:16px">'+uploadCard()+
   '<div class="card pad"><h3>Work order details</h3><div class="grid" style="gap:14px;margin-top:14px">'+
     orgFields()+
     '<div class="grid g2">'+txt('w-no','Work order number',f.orderNo,c.orderNo,'WW25121-001')+
       '<div class="auto '+(c.woDate||'')+'"><label for="w-date">Work order date'+(c.woDate?'<span class="flag hi">from PDF</span>':'')+'</label><input id="w-date" type="date" value="'+esc(f.woDate||'')+'"></div></div>'+
     txt('w-erp','ERP prepared on (date & time)',f.erpCreated,c.erpCreated,'e.g. 05-JUN-2026 04:29 PM')+
     '<div id="w-sitewrap"></div><div class="sep"></div><h4 style="font-size:12.5px;color:var(--steel);font-weight:600">VENDOR</h4>'+
     txt('w-vn','Vendor name',f.vendorName,c.vendorName)+area('w-va','Vendor address',f.vendorAddress,c.vendorAddress)+
     '<div class="grid g3">'+txt('w-vs','State',f.vendorState,c.vendorState)+txt('w-vsc','State code',f.vendorStateCode,c.vendorStateCode)+txt('w-vp','PAN',f.vendorPan,c.vendorPan)+'</div>'+
     '<div class="grid g2">'+txt('w-vg','GSTIN',f.vendorGstin,c.vendorGstin)+txt('w-vc','Contact',f.vendorContact,c.vendorContact)+'</div>'+
     '<div class="sep"></div>'+area('w-ba','Billing address',f.billingAddress,c.billingAddress)+
     '<div class="grid g3"><div class="auto '+(c.amountPre||'')+'"><label for="w-ap">Amount before GST'+(c.amountPre?'<span class="flag hi">from PDF</span>':'')+'</label><input id="w-ap" type="number" step="0.01" value="'+esc(f.amountPre)+'"></div>'+
       '<div class="auto '+(c.amountPost||'')+'"><label for="w-aq">Amount after GST'+(c.amountPost?'<span class="flag hi">from PDF</span>':'')+'</label><input id="w-aq" type="number" step="0.01" value="'+esc(f.amountPost)+'"></div>'+
       '<div><label>GST (derived)</label><input type="text" id="w-gst" readonly style="background:var(--surface-2)"></div></div><div id="w-gstwarn" class="hint"></div>'+
     '<div><label for="w-rem">Remarks</label><textarea id="w-rem" placeholder="Why this work order needs approval.">'+esc(f.remarks||'')+'</textarea><div class="hint">Work orders carry no remark field, so this one is yours to write.</div></div>'+
   '</div></div></div><div>'+rightCol()+'</div></div>';
}
function paintSubcat(mount){
  if(!mount) return;
  const f=draft.f, opts=(SUBCATEGORIES[f.category]||[]);
  if(!opts.length){ mount.innerHTML=''; f.subCategory=''; return; }
  mount.innerHTML='<div><label for="i-subcat">Sub-category <span class="hint" style="font-weight:400">optional</span></label>'+
    '<select id="i-subcat"><option value="">— none —</option>'+opts.map(x=>'<option '+(f.subCategory===x?'selected':'')+'>'+esc(x)+'</option>').join('')+'</select>'+
    '<div class="hint">Pick one only if it applies — leave as “none” otherwise.</div></div>';
  $('#i-subcat',mount).onchange=e=>{f.subCategory=e.target.value};
}
function paintSite(mount){
  if(!mount) return;
  const f=draft.f, isProj=draft.type==='indent'&&f.category==='Project';
  if(isProj){
    mount.innerHTML='<label for="s-proj">Project</label><input id="s-proj" type="text" list="dl-proj" value="'+esc(f.projectName||'ALDS Project')+'" placeholder="ALDS Project">'+
      '<datalist id="dl-proj">'+DB.projects.map(p=>'<option value="'+esc(p)+'">').join('')+'</datalist><div class="hint">Type a new project name and the system remembers it for next time.</div>';
    if(!f.projectName) f.projectName='ALDS Project';
    $('#s-proj',mount).oninput=e=>{f.projectName=e.target.value}; return;
  }
  const c=draft.conf.site, how=draft.meta.siteHow;
  const note=how==='code'?'Matched on the ERP code printed on the document.':how==='name'?'Matched by name against the station master.'
    :how==='near'?'Close match only — confirm this is the right station.':how==='ambiguous'?'The document name matched more than one station. Pick the right one.'
    :how==='unmatched'?'Not found in the master. Kept as typed and flagged for the master.':'Search the station master, or type a station that is not in it yet.';
  mount.innerHTML='<div class="auto '+(c||'')+'"><label for="s-site">Site name'+(c?'<span class="flag '+c+'">'+(c==='hi'?'from PDF':'check this')+'</span>':'')+'</label>'+
    '<input id="s-site" type="text" list="dl-st" value="'+esc(f.siteName||'')+'" placeholder="Start typing a station name">'+
    '<datalist id="dl-st">'+STATIONS.map(s=>'<option value="'+esc(s.name)+'">'+esc(s.code+' · '+s.state)+'</option>').join('')+'</datalist>'+
    '<div class="hint" id="s-note">'+esc(note)+(f.siteCode?' — '+esc(f.siteCode)+(f.siteState?', '+esc(f.siteState):''):'')+'</div></div>';
  $('#s-site',mount).oninput=e=>{const v=e.target.value.trim(); f.siteName=v; const m=byName.get(v.toLowerCase());
    if(m){f.siteCode=m.code;f.siteState=m.state;$('#s-note',mount).textContent='Matched to '+m.code+', '+m.state+'.'}
    else{f.siteCode='';f.siteState='';$('#s-note',mount).textContent='Not in the master — saved as typed and flagged.'}};
}
function wireNew(v){
  $$('.tabs button',v).forEach(b=>b.onclick=()=>{formTab=b.dataset.t;draft=null;render()});
  const body=$('#form-body',v), f=draft.f;
  uploader($('#n-files',body),draft.files,{single:true,label:'Attach the indent or work order PDF',
    onChange:()=>{ if(typeof syncSupport==='function') syncSupport() },
    onFile:async(file)=>{
    if(extOf(file.name)!=='pdf') return;
    try{
      const res=await parseDocument(file,draft.type);
      if(res.detected&&res.detected!==draft.type) toast('That looks like '+(res.detected==='workorder'?'a work order':'an indent')+'. Switch tabs if this is the wrong page.','bad');
      Object.assign(draft.f,res.fields); Object.assign(draft.conf,res.conf); draft.meta.siteHow=res.fields._siteHow;
      if(!draft.f.remarks){const base=file.name.replace(/\.[^.]+$/,'').replace(/^[A-Za-z]{2}\d+-\d+-?/,'').replace(/[_-]+/g,' ').trim();
        if(base) draft.f.remarks=base.charAt(0).toUpperCase()+base.slice(1).toLowerCase()}
      const hits=Object.keys(res.conf).length;
      toast(hits?hits+' field'+(hits>1?'s':'')+' read from the document — check them before sending.':'Nothing could be read from that PDF. Fill the fields in by hand.',hits?'ok':'bad');
      render();
    }catch(e){ toast('Could not read that PDF. Fill the fields in by hand.','bad') }
  }});
  uploader($('#n-support',body),draft.support,{mode:'support'});
  /* supporting files wait for the ERP document, but the card is always visible so people know it exists */
  const syncSupport=()=>{ const d=$('#n-support .drop',body); if(!d) return; const ok=draft.files.length>0;
    d.classList.toggle('disabled',!ok);
    if(!ok) d.textContent='Attach the ERP document above first, then add quotations, photos, Excel or Word here'; };
  syncSupport();
  paintSite($('#i-sitewrap',body)||$('#w-sitewrap',body));
  paintSubcat($('#i-subcatwrap',body));
  const bind=(id,key,num)=>{const el=$(id,body);if(el)el.oninput=()=>{f[key]=num?(el.value===''?'':Number(el.value)):el.value}};
  bind('#i-no','indentNo');bind('#i-date','indentDate');bind('#i-rem','remarks');bind('#w-no','orderNo');bind('#w-date','woDate');bind('#w-vn','vendorName');bind('#w-va','vendorAddress');
  bind('#w-vs','vendorState');bind('#w-vsc','vendorStateCode');bind('#w-vp','vendorPan');bind('#w-vg','vendorGstin');bind('#w-vc','vendorContact');bind('#w-ba','billingAddress');bind('#w-rem','remarks');
  bind('#w-ap','amountPre',1);bind('#w-aq','amountPost',1);bind('#i-erp','erpCreated');bind('#w-erp','erpCreated');
  const cat=$('#i-cat',body); if(cat) cat.onchange=()=>{f.category=cat.value;f.subCategory='';paintSite($('#i-sitewrap',body));paintSubcat($('#i-subcatwrap',body))};
  // preload the ALDS hierarchy for this requester (editable), at most once per draft
  const tryAutoHierarchy=()=>{
    if(f.department!=='ALDS'||draft._autoApplied||isFlowDraft()) return;
    const spec=ORG_HIERARCHY[(ME.name||'').trim().toLowerCase()]; if(!spec) return;
    const ids=[], missing=[];
    spec.forEach(nm=>{ const u=findUserByName(nm); if(u) ids.push(u.id); else missing.push(nm); });
    if(!ids.length) return;
    draft.chain=ids; draft._autoApplied=true; paintChain();
    toast(missing.length
      ? 'Loaded your ALDS hierarchy. Not registered yet: '+missing.join(', ')+' — add them once their account exists.'
      : 'Loaded your ALDS hierarchy — edit if this one differs.', missing.length?'':'ok');
  };
  // Department → Division cascade
  const odept=$('#o-dept',body), odiv=$('#o-div',body);
  // re-render on change so the right column switches between the chain builder and the
  // fixed-flow note the moment an ALDS flow division is chosen (or cleared).
  if(odiv) odiv.onchange=()=>{ f.division=odiv.value; render(); };
  if(odept) odept.onchange=()=>{ f.department=odept.value; f.division=''; render(); };
  const gst=()=>{const g=$('#w-gst',body); if(!g) return; const a=Number(f.amountPre)||0,b=Number(f.amountPost)||0; g.value=(a&&b)?money(b-a):'—';
    const w=$('#w-gstwarn',body); w.textContent=(a&&b&&b<a)?'The after-GST amount is lower than the before-GST amount. Check both figures.':''; w.style.color=(a&&b&&b<a)?'var(--stop)':''};
  ['#w-ap','#w-aq'].forEach(s=>{const e=$(s,body);if(e)e.addEventListener('input',gst)}); gst();

  const find=$('#n-find',body), res=$('#n-res',body), tplSave=$('#n-tplsave',body);
  const showSave=()=>{if(tplSave)tplSave.classList.toggle('hide',draft.chain.length===0)};
  const paintChain=()=>{
    const c=$('#n-chain',body); if(!c) return; showSave();
    if(!draft.chain.length){c.innerHTML='<div class="empty" style="padding:26px 12px"><h3>No approvers yet</h3><p class="hint">A request needs at least one.</p></div>';return}
    c.innerHTML='<div class="picked"><div class="r" style="background:var(--surface-2)"><span class="seq">1</span><div class="av sm">'+inits(ME.name)+'</div><div><b>'+esc(ME.name)+'</b><div class="hint">You — raising this request</div></div></div>'+
      draft.chain.map((id,i)=>{const u=user(id);return '<div class="r"><span class="seq">'+(i+2)+'</span><div class="av sm">'+inits(u.name)+'</div><div class="who" style="min-width:0;flex:1"><b>'+esc(u.name)+'</b><div class="hint">'+esc(u.role)+(u.dept?' · '+esc(u.dept):'')+'</div></div>'+
        '<span class="acts"><button class="btn sm" data-up="'+i+'" '+(i===0?'disabled':'')+'>↑</button><button class="btn sm" data-dn="'+i+'" '+(i===draft.chain.length-1?'disabled':'')+'>↓</button><button class="btn sm" data-rm="'+i+'">Remove</button></span></div>'}).join('')+'</div>';
    $$('[data-up]',c).forEach(b=>b.onclick=()=>{const i=+b.dataset.up;[draft.chain[i-1],draft.chain[i]]=[draft.chain[i],draft.chain[i-1]];paintChain()});
    $$('[data-dn]',c).forEach(b=>b.onclick=()=>{const i=+b.dataset.dn;[draft.chain[i+1],draft.chain[i]]=[draft.chain[i],draft.chain[i+1]];paintChain()});
    $$('[data-rm]',c).forEach(b=>b.onclick=()=>{draft.chain.splice(+b.dataset.rm,1);paintChain()});
  };
  paintChain();
  tryAutoHierarchy();   // if the PDF (or a kept draft) already set department = ALDS, preload the chain
  const tplSel=$('#n-tpl',body);
  if(tplSel) tplSel.onchange=()=>{const t=DB.templates.find(x=>x.id===tplSel.value); if(t){applyTemplate(t);paintChain();toast('Applied “'+t.name+'”. Adjust it if this one is different.','ok')}};
  if($('#n-tpl-go',body)) $('#n-tpl-go',body).onclick=()=>go({name:'tpl'});
  if($('#n-save-tpl',body)) $('#n-save-tpl',body).onclick=()=>saveTemplateDialog(draft.chain,()=>render());
  if(find) find.oninput=()=>{
    const q=find.value.trim().toLowerCase(); if(!q){res.innerHTML='';return}
    const hits=DB.users.filter(u=>u.active&&u.id!==ME.id&&!draft.chain.includes(u.id)&&(u.name+' '+u.email+' '+u.dept+' '+u.role).toLowerCase().includes(q)).slice(0,7);
    const mark=t=>{const s=String(t||''),i=s.toLowerCase().indexOf(q);return i<0?esc(s):esc(s.slice(0,i))+'<mark style="background:#FCEFB4">'+esc(s.slice(i,i+q.length))+'</mark>'+esc(s.slice(i+q.length))};
    res.innerHTML=hits.length?'<div class="results">'+hits.map(u=>'<button data-u="'+u.id+'"><div class="av sm">'+inits(u.name)+'</div><div style="min-width:0"><b>'+mark(u.name)+'</b><div class="hint">'+mark(u.role)+' | '+mark(u.dept)+'</div><div class="hint" style="font-size:12px">'+mark(u.email)+'</div></div></button>').join('')+'</div>'
      :'<div class="results"><div style="padding:12px 14px" class="hint">Nobody registered matches that.</div></div>';
    $$('.results button',res).forEach(b=>b.onclick=()=>{draft.chain.push(b.dataset.u);find.value='';res.innerHTML='';paintChain();find.focus()});
  };
  $('#n-clear',v).onclick=()=>{draft=null;render()};
  $('#n-send',v).onclick=()=>submit($('#n-note',v));
}
async function submit(note){
  const f=draft.f, t=draft.type; note.style.color='var(--stop)';
  if(!f.department) return note.textContent='Choose a department.';
  // Division is only required for ALDS (it decides the fixed PO/WO flow vs Transport).
  // For every other department the request is a custom chain, so Division is optional.
  if(f.department==='ALDS'&&!f.division) return note.textContent='Choose a division for the ALDS request.';
  if(isFlowDraft()) return flowRaiseSubmit(note);
  if(t==='indent'){ if(!f.indentNo) return note.textContent='Indent number is needed.'; if(!f.indentDate) return note.textContent='Date of indent is needed.';
    if(f.category==='Project'){ if(!f.projectName) f.projectName='ALDS Project' } else if(!f.siteName) return note.textContent='Site name is needed.'; }
  else { if(!f.orderNo) return note.textContent='Work order number is needed.'; if(!f.woDate) return note.textContent='Work order date is needed.';
    if(!f.vendorName) return note.textContent='Vendor name is needed.'; if(!(Number(f.amountPost)>0)) return note.textContent='Amount after GST is needed.'; }
  if(!draft.files.length) return note.textContent='Attach the ERP document before sending.';
  if(!draft.chain.length) return note.textContent='Add at least one approver.';
  note.textContent='';
  const send=async()=>{
    busy(true);
    try{
      const id=await rpc('create_request',{p_type:t,p_fields:f,p_chain:draft.chain,p_files:filesPayload(draft.files).concat(filesPayload(draft.support))});
      await load(); draft=null; toast('Sent to '+user(DB.requests.find(r=>r.id===id).chain[0].userId).name+' for approval.','ok'); go({name:'detail',id});
    }catch(e){ fail(e) } finally{ busy(false) }
  };
  let dup=null;
  try{ dup=await rpc('doc_exists',{p_type:t,p_docno:String(t==='indent'?f.indentNo:f.orderNo)}) }catch(e){}
  if(dup&&dup.exists) return modal({title:'That number already exists',
    body:'<p style="margin-top:0"><b>'+esc(t==='indent'?f.indentNo:f.orderNo)+'</b> has already been raised'+(dup.visible?' as '+esc(dup.ref)+' by '+esc(dup.requester):' by someone else')+' on '+esc(fmtD(dup.created_at))+'.</p>'+
      '<p class="hint">Raising it twice puts two chains on one document. Continue only if that is intended.</p>',
    footer:'<button class="btn" data-x>Go back</button><button class="btn primary" id="dg">Raise it anyway</button>',
    onOpen:(v,c)=>{$('#dg',v).onclick=()=>{c();send()}}});
  send();
}
/* Raise an ALDS PO/WO fixed flow from the Raise-a-request form: same uploaded ERP
   document and read fields, but it creates the flow and signs step 1 (with the PIN)
   instead of building a chain. */
async function flowRaiseSubmit(note){
  const f=draft.f, t=draft.type; note.style.color='var(--stop)';
  const cng=f.department==='CNG';
  const head=cng?'CNG':(t==='indent'?'PO':'WO'), div=cng?(f.division||''):flowDivOf(f.division);
  const title=(t==='indent'?f.indentNo:f.orderNo)||'';
  if(t==='indent'){ if(!f.indentNo) return note.textContent='Indent number is needed.'; }
  else { if(!f.orderNo) return note.textContent='Work order number is needed.'; }
  if(!draft.files.length) return note.textContent='Attach the ERP document before sending.';
  note.textContent='';
  const files=filesPayload(draft.files).concat(filesPayload(draft.support));
  const run=async()=>{
    busy(true);
    try{
      const id=await rpc('flow_create',{p_head:head,p_div:div,p_title:title.trim(),p_fields:f});
      await load();
      const flow=DB.flows.find(x=>x.id===id), step1=flow&&flow.steps.find(s=>s.status==='pending');
      if(step1){ await rpc('flow_act',{p_step:step1.id,p_kind:'act',p_remark:'',p_pin:flowCall._pin,p_files:files,p_datetime:null,p_data:null}); await load(); }
      draft=null; toast((cng?'CNG':'ALDS '+head)+' flow created and signed at step 1.','ok'); go({name:'flowdetail',id});
    }catch(e){ fail(e) } finally{ busy(false) }
  };
  flowPinThen(run);
}

/* ============================================================
   Lists
   ============================================================ */
function stepLabel(r){
  if(r.status==='Approved') return 'Cleared all '+r.chain.length+' approvers';
  if(r.status==='Rejected'){const i=r.chain.findIndex(s=>s.status==='rejected');return i>-1?'Closed by '+user(r.chain[i].userId).name:'Closed'}
  if(r.status==='Info Requested') return user(r.chain[r.infoStep].userId).name+' asked for more';
  return 'Step '+(r.current+2)+' of '+(r.chain.length+1)+' — with '+user(r.chain[r.current].userId).name;
}
function rowsHTML(list){
  return '<table class="cards"><thead><tr><th>Request</th><th>Type</th><th>Amount</th><th>Raised</th><th>Status</th><th>Position</th></tr></thead><tbody>'+
   list.map(r=>'<tr data-r="'+r.id+'"><td><b>'+esc(docTitle(r))+'</b> <span class="tag t-wait" style="font-size:10.5px">Custom chain</span><div class="hint">'+esc(r.ref)+' · '+esc(user(r.requesterId).name)+'</div></td><td class="hint meta">'+esc(typeLabel(r))+'</td>'+
   '<td class="num meta">'+(r.type==='workorder'?money(r.f.amountPost):'—')+'</td><td class="hint num meta">'+esc(fmtD(r.createdAt))+'</td><td class="meta">'+tagFor(r)+'</td><td class="hint pos">'+esc(stepLabel(r))+'</td></tr>').join('')+'</tbody></table>';
}
function viewList(list,t,s,et,es,hideEmpty){ head(t,s);
  // hideEmpty: the page has ALDS flow items below, so an "empty" message here would be misleading
  if(!list.length) return hideEmpty?'':'<div class="card"><div class="empty"><h3>'+esc(et)+'</h3><p class="hint">'+esc(es)+'</p></div></div>';
  return '<div class="card">'+rowsHTML(list.slice().sort((a,b)=>b.createdAt-a.createdAt))+'</div>'; }
const wireList=v=>$$('tr[data-r]',v).forEach(t=>t.onclick=()=>go({name:'detail',id:t.dataset.r}));
function viewTasks(){
  head('Tasks given to me','Work a manager has assigned you inside a request');
  const l=myTasks();
  if(!l.length) return '<div class="card"><div class="empty"><h3>No tasks assigned to you</h3><p class="hint">When a manager breaks their step into pieces, your piece lands here.</p></div></div>';
  return '<div class="card"><table class="cards"><thead><tr><th>Request</th><th>Given by</th><th>Given</th><th>The task</th></tr></thead><tbody>'+
    l.map(r=>{const m=myOpenTask(r);return '<tr data-r="'+r.id+'"><td><b>'+esc(docTitle(r))+'</b><div class="hint">'+esc(typeLabel(r))+' · '+esc(r.ref)+'</div></td><td class="hint meta">from '+esc(user(m.step.userId).name)+'</td><td class="hint num meta">'+esc(fmtD(m.task.assignedAt))+'</td><td class="pos">'+esc(m.task.task)+'</td></tr>'}).join('')+'</tbody></table></div>';
}
let allF={q:'',status:'',type:'',month:'',date:'',pendWith:''};
// IST calendar day of a timestamp, as YYYY-MM-DD (matches the <input type=date>/month values)
const istDay=t=>t?new Date(t).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}):'';
// shared month/date filter used by BOTH engines on the All requests page
const dateMatch=createdAt=>{ if(allF.date) return istDay(createdAt)===allF.date;
  if(allF.month) return istDay(createdAt).slice(0,7)===allF.month; return true; };
function viewAll(){
  const base=visible();
  let l=base.slice().sort((a,b)=>b.createdAt-a.createdAt);
  if(allF.status) l=l.filter(r=>r.status===allF.status); if(allF.type) l=l.filter(r=>r.type===allF.type);
  l=l.filter(r=>dateMatch(r.createdAt));
  if(allF.pendWith) l=l.filter(r=>r.status==='In Progress'&&r.chain[r.current]&&r.chain[r.current].userId===allF.pendWith);
  if(allF.q){const q=allF.q.toLowerCase();l=l.filter(r=>(docTitle(r)+' '+r.ref+' '+user(r.requesterId).name+' '+(r.f.remarks||'')).toLowerCase().includes(q))}
  // tell apart "no legacy requests at all" from "none match the filter" — the
  // ALDS PO/WO flows render in their own section just below this one.
  const empty = base.length===0
    ? '<div class="card"><div class="empty"><h3>No custom-chain requests</h3><p class="hint">These filters cover REQ-I / REQ-W custom-chain requests. ALDS PO / WO flows are shown below and have their own filter.</p></div></div>'
    : '<div class="card"><div class="empty"><h3>Nothing matches that</h3></div></div>';
  const pendIds=[...new Set(base.filter(r=>r.status==='In Progress'&&r.chain[r.current]).map(r=>r.chain[r.current].userId))].sort((a,b)=>user(a).name.localeCompare(user(b).name));
  if(allF.pendWith&&pendIds.indexOf(allF.pendWith)<0) allF.pendWith='';
  const anyF=allF.q||allF.status||allF.type||allF.month||allF.date||allF.pendWith;
  return '<div class="card pad" style="margin-bottom:16px"><div class="row filters-row" style="flex-wrap:wrap;gap:12px"><div style="flex:1;min-width:220px"><input id="a-q" type="text" placeholder="Search any number (FLOW-, PO/WO no. e.g. 001), site, vendor, requester or remark" value="'+esc(allF.q)+'"></div>'+
    '<select id="a-ty" style="width:auto"><option value="">Both types</option><option value="indent" '+(allF.type==='indent'?'selected':'')+'>Indent</option><option value="workorder" '+(allF.type==='workorder'?'selected':'')+'>Work order</option></select>'+
    '<select id="a-st" style="width:auto"><option value="">Every status</option>'+['In Progress','Info Requested','Approved','Rejected'].map(s=>'<option '+(allF.status===s?'selected':'')+'>'+s+'</option>').join('')+'</select>'+
    '<input id="a-mo" type="month" title="Filter by month raised" value="'+esc(allF.month)+'" style="width:auto">'+
    '<input id="a-dt" type="date" title="Filter by exact date raised" value="'+esc(allF.date)+'" style="width:auto">'+
    (pendIds.length?'<select id="a-pw" title="Legacy: who it is pending with now" style="width:auto"><option value="">Pending with (anyone)</option>'+pendIds.map(id=>'<option value="'+id+'" '+(allF.pendWith===id?'selected':'')+'>'+esc(user(id).name)+'</option>').join('')+'</select>':'')+
    (anyF?'<button class="btn ghost sm" id="a-clear">Clear filters</button>':'')+'</div></div>'+
    (l.length?'<div class="card">'+rowsHTML(l)+'</div>':empty);
}
document.addEventListener('input',e=>{if(e.target.id==='a-q'){allF.q=e.target.value;const p=e.target.selectionStart;render();const n=$('#a-q');if(n){n.focus();n.setSelectionRange(p,p)}}});
document.addEventListener('change',e=>{if(e.target.id==='a-st'){allF.status=e.target.value;render()} if(e.target.id==='a-ty'){allF.type=e.target.value;render()}
  if(e.target.id==='a-mo'){allF.month=e.target.value;if(allF.month)allF.date='';render()}
  if(e.target.id==='a-dt'){allF.date=e.target.value;if(allF.date)allF.month='';render()}
  if(e.target.id==='a-pw'){allF.pendWith=e.target.value;render()}});
document.addEventListener('click',e=>{if(e.target.id==='a-clear'){allF={q:'',status:'',type:'',month:'',date:'',pendWith:''};render()}});

/* ============================================================
   Detail — the chain, sub-branches, decisions
   ============================================================ */
function subBranchHTML(r,s){
  const tsk=tasksOf(s); if(!tsk.length) return ''; const open=openTasks(s).length, first=user(s.userId).name.split(' ')[0];
  return '<div class="sub"><div class="sub-h">'+esc(first)+' split this step into '+tsk.length+' task'+(tsk.length===1?'':'s')+(open?' — '+open+' still open, so the chain cannot move':' — all closed, waiting for '+esc(first)+' to approve')+'</div>'+
    tsk.map(t=>{const u=user(t.userId);const tg={open:'<span class="tag t-prog">Working on it</span>',done:'<span class="tag t-ok">Done</span>',cannot:'<span class="tag t-bad">Could not do it</span>',withdrawn:'<span class="tag t-wait">Withdrawn</span>'}[t.status]||'';
      return '<div class="subrow"><div class="av sm">'+inits(u.name)+'</div><div style="min-width:0;flex:1"><div class="row" style="gap:8px"><b style="font-size:13.5px">'+esc(u.name)+'</b><span class="hint">'+esc(u.role||'')+'</span><span style="margin-left:auto">'+tg+'</span></div>'+
        '<div style="font-size:13.5px;margin-top:2px">'+esc(t.task)+'</div><div class="hint">Given '+esc(fmtDT(t.assignedAt))+(t.closedAt?' · closed '+esc(fmtDT(t.closedAt)):'')+'</div>'+
        (t.note?'<div class="said" style="margin-top:6px">'+esc(t.note)+'</div>':'')+fileListHTML(t.files)+'</div></div>'}).join('')+'</div>';
}
function viewDetail(id){
  const r=DB.requests.find(x=>x.id===id);
  if(!r) return '<div class="card"><div class="empty"><h3>That request is not visible to you</h3><p class="hint">It may have been raised in a chain you are not part of.</p></div></div>';
  head(docTitle(r),'Custom chain · '+typeLabel(r)+' · '+r.ref+' · raised by '+user(r.requesterId).name+' on '+fmtD(r.createdAt));
  const mine=isMyTurn(r), info=needsMyInfo(r), f=r.f, mt=myOpenTask(r);
  const mayExtend=(r.requesterId===ME.id||ME.admin||ME.owner)&&r.status!=='Rejected';
  let banner='';
  if(mayExtend&&r.status==='Approved') banner='<div class="banner hold"><div><b>This closed after only '+r.chain.length+' approver'+(r.chain.length>1?'s':'')+'.</b><div class="hint" style="color:var(--hold)">If more people still need to sign, add them — the request reopens and moves to the next one. Reopening is recorded.</div></div><button class="btn hold sm" style="margin-left:auto" id="d-extend">Add approvers</button></div>';
  else if(mayExtend&&r.status==='In Progress'&&!holder(r)) banner='<div class="banner hold"><div><b>This request has no one left to act on it.</b><div class="hint" style="color:var(--hold)">Add the next approver(s) to keep it moving.</div></div><button class="btn hold sm" style="margin-left:auto" id="d-extend">Add approvers</button></div>';
  if(mt) banner='<div class="banner live"><div><b>You have a task on this request.</b><div class="hint">Close it below and it goes back to '+esc(user(r.chain[mt.stepIndex].userId).name)+'.</div></div></div>';
  else if(mine) banner='<div class="banner live"><div><b>This is with you.</b><div class="hint">Everyone after you is locked out until you act. Open the attached document before signing.</div></div></div>';
  else if(info) banner='<div class="banner hold"><div><b>'+esc(user(r.chain[r.infoStep].userId).name)+' has asked you for more.</b><div class="hint">Reply at step '+(r.infoStep+2)+' below. The chain picks up where it stopped.</div></div></div>';
  else if(r.status==='Info Requested'&&r.chain[r.infoStep]&&r.chain[r.infoStep].userId===ME.id){ const tg=infoTargets(r), who=tg.length?tg.map(id=>user(id).name).join(', '):user(r.requesterId).name, done=(r.infoReplies||[]).length;
    banner='<div class="banner hold"><div><b>You asked '+esc(who)+' for more.</b><div class="hint">'+(tg.length>1?done+' of '+tg.length+' have replied. ':'')+'It comes back to you once '+(tg.length>1?'everyone has':'they have')+' responded.</div></div></div>'; }
  else if(r.status==='In Progress') banner='<div class="banner live"><div><b>With '+esc(user(r.chain[r.current].userId).name)+' at step '+(r.current+2)+'.</b><div class="hint">You can follow the whole chain, but only the holder can act.</div></div></div>';

  let nodes='<div class="node done"><div class="dot">1</div><div class="body"><div class="row"><div><h4>'+esc(user(r.requesterId).name)+'</h4><div class="meta">'+esc(user(r.requesterId).role)+(user(r.requesterId).dept?' · '+esc(user(r.requesterId).dept):'')+' — raised this request</div></div>'+
    '<span class="tag t-ok" style="margin-left:auto">Raised</span></div><div class="meta" style="margin-top:6px">'+esc(fmtDT(r.createdAt))+'</div>'+fileListHTML(r.files)+'</div></div>';
  r.chain.forEach((s,i)=>{
    const u=user(s.userId), prevDept=deptAt(r,i-1), thisDept=deptAt(r,i);
    if(thisDept&&prevDept&&thisDept!==prevDept) nodes+='<div class="handover"><span>'+esc(prevDept)+'</span><i></i><b>'+esc(thisDept)+'</b></div>';
    const live=(r.status==='In Progress'&&i===r.current)||(r.status==='Info Requested'&&i===r.infoStep);
    // 'info' = this approver asked for more: it's with the tagged person / requester now, so
    // show this node muted ("parked") and say clearly who it's pending with
    const cls=s.status==='approved'?'done':s.status==='conditional'?'done cond':s.status==='rejected'?'stop':s.status==='info'?'parked':live?'live':s.status==='waiting'?'locked':'';
    let parkedWith='';
    if(s.status==='info'){ const h=holder(r); parkedWith='<div class="pending-with tagged" style="margin-top:7px">Pending with <b>'+esc(h?h.name:'the requester')+'</b> <span class="pw-sub">· asked by '+esc(u.name)+'</span></div>'+legacyTagChain(r)+legacyReplyThread(r); }
    let tag={approved:'<span class="tag t-ok">Approved</span>',conditional:'<span class="tag t-ok">Approved with a condition</span>',rejected:'<span class="tag t-bad">Rejected</span>',info:'<span class="tag t-wait">Asked for more — waiting</span>',
      pending:stepBlocked(s)?'<span class="tag t-hold">Work given out</span>':'<span class="tag t-prog">Holding it now</span>',waiting:'<span class="tag t-wait">Waiting turn</span>'}[s.status]||'';
    if(s.systemApproved) tag='<span class="tag t-ok" style="background:var(--indigo);color:#fff">System Approved — by super admin</span>';
    if(s.erpDone) tag+=' <span class="tag t-ok">ERP ✓</span>';
    const dot=(s.status==='approved'||s.status==='conditional')?'✓':s.status==='rejected'?'✕':s.status==='info'?'?':String(i+2);
    let ownerLegacyBtn='';
    if(ME.owner&&(r.status==='In Progress'||r.status==='Info Requested')&&(s.status==='pending'||s.status==='waiting'||s.status==='info'))
      ownerLegacyBtn='<button class="btn ghost sm" data-sys="'+i+'" style="color:var(--indigo);padding:2px 9px">⚡ System-approve to here</button>';
    else if(ME.owner&&(s.status==='approved'||s.status==='conditional'||s.status==='rejected'))
      ownerLegacyBtn='<button class="btn ghost sm" data-rwd="'+i+'" style="color:var(--hold);padding:2px 9px">↩ Reopen from here</button>';
    const sysBtn=ownerLegacyBtn?'<div style="margin-top:8px">'+ownerLegacyBtn+'</div>':'';
    nodes+='<div class="node '+cls+'" id="step-'+i+'"><div class="dot">'+dot+'</div><div class="body"><div class="row"><div><h4>'+esc(u.name)+(isManager(u)?' <span class="hint" style="font-weight:400">· manager</span>':'')+'</h4><div class="meta">'+esc(u.role)+(u.dept?' · '+esc(u.dept):'')+'</div></div><span style="margin-left:auto">'+tag+'</span></div>'+
      parkedWith+(s.actedAt?'<div class="meta" style="margin-top:6px">'+esc(fmtDT(s.actedAt))+'</div>':'')+(s.condition?'<div class="said"><b>Condition:</b> '+esc(s.condition)+'</div>':'')+(s.remark&&!s.systemApproved?'<div class="said">'+esc(s.remark)+'</div>':'')+
      (s.status==='waiting'?'<div class="meta" style="margin-top:6px">Opens once step '+(i+1)+' is done.</div>':'')+
      (s.erpDone?'<div class="meta" style="margin-top:6px;color:var(--seal)">ERP entered'+(s.erpDoneBy?' by '+esc(user(s.erpDoneBy).name):'')+(s.erpDoneAt?' · '+esc(fmtDT(s.erpDoneAt)):'')+'</div>':'')+
      fileListHTML(s.files)+subBranchHTML(r,s)+sysBtn+'</div></div>';
  });
  const notes=r.notes.length?'<div class="card pad" style="margin-top:16px"><h3>Notes</h3>'+r.notes.map(n=>'<div style="display:flex;gap:11px;padding:11px 0;border-bottom:1px solid var(--line)"><div class="av sm">'+inits(user(n.userId).name)+'</div><div><div style="font-size:13.5px"><b>'+esc(user(n.userId).name)+'</b> <span class="hint">'+esc(fmtDT(n.ts))+'</span></div><div style="white-space:pre-wrap">'+esc(n.text)+'</div></div></div>').join('')+'</div>':'';

  let panel='';
  if(mt){
    panel='<div class="card pad" style="border-color:var(--indigo)"><h3>Your task</h3><p class="hint" style="margin-top:5px">'+esc(user(r.chain[mt.stepIndex].userId).name)+' gave you this. It is not an approval — when you close it, it goes back to them.</p>'+
      '<div class="said" style="margin:12px 0 0;border-left-color:var(--indigo)">'+esc(mt.task.task)+'</div><div style="margin-top:14px"><label for="k-note">What you did, or why you cannot</label><textarea id="k-note" placeholder="Keep it short but specific."></textarea></div>'+
      '<div style="margin-top:12px"><label>Attach anything</label><div id="k-files"></div></div><div class="sep"></div><div class="grid" style="gap:9px"><button class="btn ok" id="k-done">Mark it done</button><button class="btn bad" id="k-cant">I cannot do this</button></div>'+
      '<div class="hint" style="margin-top:11px">No PIN needed — only the approval itself is signed.</div></div>';
  } else if(mine){
    const step=r.chain[r.current], blocked=stepBlocked(step), team=teamOf(ME.id), closed=tasksOf(step).filter(t=>t.status!=='open'&&t.status!=='withdrawn').length, given=tasksOf(step).filter(t=>t.status!=='withdrawn').length;
    panel='<div class="card pad"><h3>Your decision</h3><p class="hint" style="margin-top:5px">'+(r.current+1===r.chain.length?'You are the last approver. Approving closes this out.':'Approving passes it to '+esc(user(r.chain[r.current+1].userId).name)+'.')+'</p>'+
      (isManager(ME)?'<div class="sep"></div><div class="row" style="justify-content:space-between"><div><b style="font-size:13.5px">Your team</b><div class="hint">'+(given?closed+' of '+given+' tasks closed':'Hand out the internal work before you sign.')+'</div></div>'+
        '<button class="btn sm" id="a-assign" '+(team.length?'':'disabled title="Confirm your team first"')+'>Give work to someone</button></div>'+(team.length?'':'<div class="hint" style="color:var(--hold);margin-top:8px">Nobody is on your team yet. Add them under My team.</div>'):'')+
      (blocked?'<div class="banner hold" style="margin-top:14px"><div><b>'+openTasks(step).length+' task still open.</b><div class="hint" style="color:var(--hold)">You can approve once your team has closed everything you gave out.</div></div></div>':'')+
      '<div style="margin-top:14px"><label for="d-rem">Remarks</label><textarea id="d-rem" placeholder="What you checked and what you are relying on."></textarea></div><div style="margin-top:12px"><label>Attach anything</label><div id="d-files"></div></div><div class="sep"></div>'+
      '<div class="grid" style="gap:9px"><button class="btn ok" id="a-ok" '+(blocked?'disabled':'')+'>Approve and pass on</button><button class="btn" id="a-cond" '+(blocked?'disabled':'')+'>Approve with a condition</button>'+
      '<button class="btn hold" id="a-info">Ask the requester for more</button><button class="btn bad" id="a-no">Reject and close</button></div>'+
      '<div class="hint" style="margin-top:11px">The ERP document cannot be changed from here. If it is wrong, reject it and have it reissued.</div></div>';
  } else if(info){
    const tg=infoTargets(r), idx=tg.indexOf(ME.id), more=tg.length>1&&idx>-1&&idx<tg.length-1, asker=user(r.chain[r.infoStep].userId);
    panel='<div class="card pad" style="border-color:var(--hold)"><h3>'+(tg.length>1?'You were tagged to check':'Reply to step '+(r.infoStep+2))+'</h3>'+
      '<p class="hint" style="margin-top:5px">'+esc(asker.name)+' asked:</p><div class="banner hold" style="margin-top:8px"><div>'+esc(r.chain[r.infoStep].remark||'—')+'</div></div>'+
      legacyTagChain(r)+legacyReplyThread(r)+
      '<div style="margin-top:14px"><label for="i-reply">Your reply</label><textarea id="i-reply" placeholder="Answer what was asked."></textarea></div><div style="margin-top:12px"><label>Add documents</label><div id="i-files"></div></div>'+
      '<div class="hint" style="margin-top:10px">'+(more?'After you reply it goes to the next person in the order above.':'You are last — after you reply it goes back to '+esc(asker.name)+'. Earlier approvals stand.')+'</div>'+
      '<button class="btn primary" id="i-send" style="width:100%;margin-top:12px">Send reply</button></div>';
  } else if(legacyTagged(r)){
    const active=legacyActiveTag(r);
    panel='<div class="card pad"><h3>You are tagged — not your turn yet</h3>'+
      '<p class="hint" style="margin-top:5px">'+esc(user(r.chain[r.infoStep].userId).name)+' asked: <b>'+esc(r.chain[r.infoStep].remark||'')+'</b></p>'+legacyTagChain(r)+legacyReplyThread(r)+
      '<p class="hint" style="margin-top:10px">'+(active?'It comes to you after <b>'+esc(user(active).name)+'</b> replies. You will get a notification.':'You have already replied.')+'</p></div>';
  } else {
    const h=holder(r);
    panel='<div class="card pad"><h3>'+(h?'Sitting with '+esc(h.name):'Closed')+'</h3><p class="hint" style="margin-top:6px">'+(h?'Nothing for you to do until it reaches you.':(r.status==='Approved'?'Approved by everyone in the chain on '+esc(fmtD(r.closedAt))+'.':'Closed on '+esc(fmtD(r.closedAt))+'. Raise a fresh request if the document is reissued.'))+'</p>'+
      ((r.requesterId===ME.id||ME.admin||ME.owner)&&r.status==='Approved'?'<div class="sep"></div><button class="btn sm" id="d-extend2">Add more approvers</button>':'')+
      (inChain(r)||ME.admin?'<div class="sep"></div><label for="nt">Leave a note</label><textarea id="nt" placeholder="A comment for the chain. It does not move the request."></textarea><button class="btn sm" id="ntb" style="margin-top:9px">Post note</button>':'')+'</div>';
  }
  const facts='<div class="card pad" style="margin-bottom:16px">'+(r.type==='workorder'?'<div class="amount num">'+money(f.amountPost)+'</div><div class="hint">'+money(f.amountPre)+' before GST'+(f.amountPre&&f.amountPost?' · GST '+money(f.amountPost-f.amountPre):'')+'</div>':'<div class="amount num">'+esc(docNo(r))+'</div>')+
    '<div style="margin:8px 0 14px">'+tagFor(r)+'</div><dl class="kv"><dt>Reference</dt><dd class="num">'+esc(r.ref)+'</dd><dt>Type</dt><dd>'+esc(typeLabel(r))+'</dd>'+(f.department?'<dt>Department</dt><dd>'+esc(f.department)+'</dd>':'')+(f.division?'<dt>Division</dt><dd>'+esc(f.division)+'</dd>':'')+(f.erpCreated?'<dt>ERP prepared</dt><dd>'+esc(f.erpCreated)+'</dd>':'')+
    (r.type==='indent'?'<dt>Category</dt><dd>'+esc(f.category||'—')+(f.subCategory?' · '+esc(f.subCategory):'')+'</dd><dt>'+(f.category==='Project'?'Project':'Site')+'</dt><dd>'+esc(f.category==='Project'?(f.projectName||'—'):(f.siteName||'—'))+(f.siteCode?' ('+esc(f.siteCode)+')':'')+'</dd><dt>Indent date</dt><dd>'+esc(fmtD(f.indentDate))+'</dd>'
      :'<dt>Order date</dt><dd>'+esc(fmtD(f.woDate))+'</dd><dt>Site</dt><dd>'+esc(f.siteName||'—')+(f.siteCode?' ('+esc(f.siteCode)+')':'')+'</dd><dt>Vendor</dt><dd>'+esc(f.vendorName||'—')+'</dd>'+
       (f.vendorAddress?'<dt>Address</dt><dd>'+esc(f.vendorAddress)+'</dd>':'')+(f.vendorState?'<dt>State</dt><dd>'+esc(f.vendorState)+(f.vendorStateCode?' ('+esc(f.vendorStateCode)+')':'')+'</dd>':'')+
       (f.vendorGstin?'<dt>GSTIN</dt><dd class="num">'+esc(f.vendorGstin)+'</dd>':'')+(f.vendorPan?'<dt>PAN</dt><dd class="num">'+esc(f.vendorPan)+'</dd>':'')+(f.vendorContact?'<dt>Contact</dt><dd>'+esc(f.vendorContact)+'</dd>':'')+(f.billingAddress?'<dt>Billing to</dt><dd>'+esc(f.billingAddress)+'</dd>':''))+
    '<dt>Raised</dt><dd>'+esc(fmtD(r.createdAt))+'</dd><dt>Approvers</dt><dd>'+r.chain.length+' in sequence</dd></dl>'+(f.remarks?'<div class="sep"></div><div class="hint" style="margin-bottom:5px">Remarks</div><div style="white-space:pre-wrap">'+esc(f.remarks)+'</div>':'')+
    ((r.requesterId===ME.id||ME.admin)&&r.status!=='Rejected'&&r.status!=='Info Requested'&&!isMyTurn(r)?'<div class="sep"></div><button class="btn sm" id="d-extend" style="width:100%">'+(r.status==='Approved'?'Reopen and add the next approver':'Add the next approver')+'</button>':'')+
    (ME.owner?'<div class="sep"></div><button class="btn ghost sm" id="d-purge" style="color:var(--stop);padding:0">Delete this request (owner only)</button>':'')+'</div>';
  return '<button class="btn ghost sm" id="d-back" style="margin-bottom:12px">Back</button>'+banner+'<div class="detail-grid"><div><div class="card pad"><h3 style="margin-bottom:16px">The chain</h3><div class="rail">'+nodes+'</div></div>'+notes+'</div><div>'+facts+panel+'</div></div>';
}
/* Super-admin override (legacy chain): system-approve up to and including a position */
function sysApproveTo(position){
  const r=DB.requests.find(x=>x.id===ROUTE.id); if(!r||!ME.owner) return;
  const s=r.chain[position]; if(!s) return;
  let span=0; for(let i=r.current;i<=position;i++){ const st=r.chain[i]; if(st&&(st.status==='pending'||st.status==='waiting'||st.status==='info')) span++; }
  const next=r.chain[position+1];
  modal({title:'System-approve as super admin',
    body:'<p style="margin-top:0">Approve every step up to and including <b>'+esc(user(s.userId).name)+'</b> (step '+(position+2)+') in one go.</p>'+
      '<div class="banner" style="margin-top:8px"><div class="hint"><b>'+span+' step'+(span===1?'':'s')+'</b> will be marked <b style="color:var(--indigo)">System Approved — by super admin</b> and locked. '+
      (next?('It then sits live with <b>'+esc(user(next.userId).name)+'</b> at step '+(position+3)+', whose action buttons go active.'):'This <b>closes the request as Approved</b>.')+'</div></div>'+
      '<p class="hint" style="margin-top:8px">The full chain stays visible to everyone. Signed with your PIN.</p>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="sa-go">System-approve</button>',
    onOpen:(mv,cl)=>{ $('#sa-go',mv).onclick=()=>{ cl();
      confirmPin('system-approve '+docNo(r)+' to step '+(position+2),async pin=>{
        await rpc('owner_approve_to',{p_request:r.id,p_position:position,p_pin:pin});
        await load(); toast('System-approved by super admin.','ok'); go({name:'detail',id:r.id});
      }); }; }});
}
/* Super-admin step-back (legacy chain): reopen a position, clear everything onward */
function rewindTo(position){
  const r=DB.requests.find(x=>x.id===ROUTE.id); if(!r||!ME.owner) return;
  const s=r.chain[position]; if(!s) return;
  let cleared=0; for(let i=position;i<r.chain.length;i++){ const st=r.chain[i]; if(st&&st.status!=='waiting') cleared++; }
  modal({title:'Reopen as super admin',
    body:'<p style="margin-top:0">Step back to <b>'+esc(user(s.userId).name)+'</b> (step '+(position+2)+') and make it live again.</p>'+
      '<div class="banner hold" style="margin-top:8px"><div class="hint">This clears <b>'+cleared+' decision'+(cleared===1?'':'s')+'</b> from this step onward — <b>system approvals and ordinary ones alike</b> — so the chain runs again from here. '+
      'It then sits live with <b>'+esc(user(s.userId).name)+'</b>, whose buttons go active.'+(r.status==='Approved'||r.status==='Rejected'?' The closed request reopens.':'')+'</div></div>'+
      '<p class="hint" style="margin-top:8px">Attached documents stay in place. Signed with your PIN.</p>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn hold" id="rw-go">Reopen from here</button>',
    onOpen:(mv,cl)=>{ $('#rw-go',mv).onclick=()=>{ cl();
      confirmPin('reopen '+docNo(r)+' from step '+(position+2),async pin=>{
        await rpc('owner_rewind_to',{p_request:r.id,p_position:position,p_pin:pin});
        await load(); toast('Reopened from this step.','ok'); go({name:'detail',id:r.id});
      }); }; }});
}
function wireDetail(v){
  const r=DB.requests.find(x=>x.id===ROUTE.id); if(!r) return;
  $('#d-back',v).onclick=()=>{ if(history.length>1) history.back(); else go({name:'all'}); };
  $$('[data-sys]',v).forEach(b=>b.onclick=()=>sysApproveTo(+b.dataset.sys));
  $$('[data-rwd]',v).forEach(b=>b.onclick=()=>rewindTo(+b.dataset.rwd));
  if($('#d-purge',v)) $('#d-purge',v).onclick=()=>purgeRequestDialog(r);
  if($('#d-extend',v)) $('#d-extend',v).onclick=()=>extendChainDialog(r);
  if($('#d-extend2',v)) $('#d-extend2',v).onclick=()=>extendChainDialog(r);
  if($('#d-extend',v)) $('#d-extend',v).onclick=()=>extendChainDialog(r);
  if($('#d-extend2',v)) $('#d-extend2',v).onclick=()=>extendChainDialog(r);
  let allFiles=r.files.slice(); r.chain.forEach(s=>{allFiles=allFiles.concat(s.files||[]);tasksOf(s).forEach(t=>{allFiles=allFiles.concat(t.files||[])})});
  bindFiles(v,allFiles);
  readForRequest(r.id);
  if(needsMyInfo(r)){const n=$('#step-'+r.infoStep,v);if(n){n.classList.add('flash');setTimeout(()=>n.scrollIntoView({behavior:'smooth',block:'center'}),120)}}
  const after=async(msg)=>{await load();toast(msg,'ok');go({name:'detail',id:r.id})};

  const mt=myOpenTask(r);
  if(mt){
    const kf=[]; uploader($('#k-files',v),kf,{mode:'support',label:'Attach photos or files that show the work'});
    const close=async(st)=>{const note=$('#k-note',v).value.trim(); if(!note){toast(st==='done'?'Say briefly what you did.':'Say why you cannot do it.','bad');$('#k-note',v).focus();return}
      busy(true); try{ await rpc('close_task',{p_task:mt.task.id,p_status:st,p_note:note,p_files:filesPayload(kf)}); await after('Sent back to '+user(mt.step.userId).name+'.') }catch(e){fail(e)} finally{busy(false)} };
    $('#k-done',v).onclick=()=>close('done'); $('#k-cant',v).onclick=()=>close('cannot');
  }
  if(isMyTurn(r)){
    const files=[]; uploader($('#d-files',v),files,{mode:'support',label:'Attach photos or files behind your decision'});
    const rem=()=>$('#d-rem',v).value.trim();
    const act=(action,label,extra)=>confirmPin(label,async pin=>{
      await rpc('act_on_step',{p_request:r.id,p_action:action,p_remark:rem(),p_condition:(extra&&extra.condition)||'',p_pin:pin,p_files:filesPayload(files)});
      await after({approve:'Approved.',conditional:'Approved with a condition.',info:'Sent back to '+user(r.requesterId).name+'.',reject:'Rejected and closed.'}[action]);
    });
    const asg=$('#a-assign',v);
    if(asg) asg.onclick=()=>{
      const step=r.chain[r.current], busyIds=openTasks(step).map(t=>t.userId), pick=teamOf(ME.id).filter(u=>busyIds.indexOf(u.id)<0);
      if(!pick.length) return toast('Everyone on your team already has an open task on this step.','bad');
      modal({title:'Give work to your team',body:'<p class="hint" style="margin-top:0">Pick one or more people and write exactly what each of them has to do. The request stays parked on your step until every task is closed, and everyone in the chain can see where it is sitting.</p>'+
          '<div style="margin-top:14px">'+pick.map(u=>'<div class="filerow" style="align-items:flex-start;flex-direction:column;gap:8px"><label style="display:flex;align-items:center;gap:9px;margin:0;width:100%"><input type="checkbox" data-u="'+u.id+'" style="width:auto"><span class="av sm">'+inits(u.name)+'</span><span><b>'+esc(u.name)+'</b> <span class="hint">'+esc(u.role||'')+'</span></span></label>'+
            '<input type="text" data-t="'+u.id+'" placeholder="What exactly must '+esc(u.name.split(' ')[0])+' do?" disabled></div>').join('')+'</div><div id="asg-e" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
        footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="asg-g">Assign</button>',
        onOpen:(mv,cl)=>{
          $$('input[data-u]',mv).forEach(cb=>cb.onchange=()=>{const t=$('input[data-t="'+cb.dataset.u+'"]',mv);t.disabled=!cb.checked;if(cb.checked)t.focus()});
          $('#asg-g',mv).onclick=async()=>{
            const rows=$$('input[data-u]',mv).filter(c=>c.checked).map(c=>({user_id:c.dataset.u,task:$('input[data-t="'+c.dataset.u+'"]',mv).value.trim()}));
            if(!rows.length) return $('#asg-e',mv).textContent='Pick at least one person.';
            const blank=rows.find(x=>x.task.length<4); if(blank) return $('#asg-e',mv).textContent='Write the task for '+user(blank.user_id).name+'.';
            try{ await rpc('assign_tasks',{p_request:r.id,p_tasks:rows}); cl(); await after('Assigned to '+rows.length+' '+(rows.length===1?'person':'people')+'. The chain stays here until they finish.') }
            catch(e){ $('#asg-e',mv).textContent=(e.message||'').replace(/^.*?: /,'') }
          }}});
    };
    $('#a-ok',v).onclick=()=>{
      const last=r.current+1===r.chain.length;
      const nxt=last?null:user(r.chain[r.current+1].userId);
      modal({title:'Before you approve',
        body:'<p style="margin-top:0">'+(last
              ? 'You are the last approver. Approving <b>closes '+esc(docNo(r))+'</b>.'
              : 'After you, '+esc(docNo(r))+' goes to:')+'</p>'+
          (nxt?'<div class="filerow" style="margin-top:10px"><div class="av sm">'+inits(nxt.name)+'</div><div><b>'+esc(nxt.name)+'</b><div class="hint">'+esc(nxt.role||'')+(nxt.dept?' · '+esc(nxt.dept):'')+'</div></div></div>':'')+
          '<div id="ins-wrap" style="margin-top:14px"><button class="btn sm" id="ins-add">Add someone before '+(nxt?esc(nxt.name.split(" ")[0]):'closing')+'</button></div>'+
          '<div id="ins-find-wrap" class="hide" style="margin-top:10px"><label for="ins-find">Who should act next</label><div class="finder"><input id="ins-find" type="text" placeholder="Name, email, designation or department" autocomplete="off"><div id="ins-res"></div></div><div id="ins-picked" class="hint" style="margin-top:6px"></div></div>',
        footer:'<button class="btn" data-x>Cancel</button><button class="btn ok" id="ins-go">Approve'+(nxt?' and pass on':' and close')+'</button>',
        onOpen:(mv,close)=>{
          let chosen=null;
          $('#ins-add',mv).onclick=()=>{ $('#ins-find-wrap',mv).classList.remove('hide'); $('#ins-wrap',mv).classList.add('hide'); $('#ins-find',mv).focus() };
          const find=$('#ins-find',mv), res=$('#ins-res',mv);
          find.oninput=()=>{ const q=find.value.trim().toLowerCase(); if(!q){res.innerHTML='';return}
            const inchain=r.chain.map(s=>s.userId);
            const hits=DB.users.filter(u=>u.active&&u.id!==ME.id&&inchain.indexOf(u.id)<0&&(u.name+' '+u.email+' '+(u.dept||'')+' '+(u.role||'')).toLowerCase().includes(q)).slice(0,6);
            res.innerHTML=hits.length?'<div class="results">'+hits.map(u=>'<button data-u="'+u.id+'"><div class="av sm">'+inits(u.name)+'</div><div><b>'+esc(u.name)+'</b><div class="hint">'+esc(u.role||'')+' · '+esc(u.dept||'')+'</div></div></button>').join('')+'</div>':'<div class="results"><div style="padding:10px 12px" class="hint">Nobody matches, or they are already in the chain.</div></div>';
            $$('.results button',res).forEach(b=>b.onclick=()=>{chosen=b.dataset.u;find.value=user(chosen).name;res.innerHTML='';$('#ins-picked',mv).textContent='They will act next; '+(nxt?nxt.name.split(' ')[0]+' comes after':'then it closes')+'.'});
          };
          $('#ins-go',mv).onclick=async()=>{
            $('#ins-go',mv).disabled=true;
            try{ if(chosen) await rpc('insert_next_approver',{p_request:r.id,p_user:chosen}); close(); act('approve','approve '+docNo(r)); }
            catch(e){ $('#ins-go',mv).disabled=false; toast((e.message||'').replace(/^.*?: /,''),'bad') }
          };
        }});
    };
    $('#a-cond',v).onclick=()=>modal({title:'Approve with a condition',body:'<p class="hint" style="margin-top:0">The ERP document cannot be changed from here, so record what must happen instead. The condition travels with the request and every later approver sees it.</p><div style="margin-top:14px"><label for="cd">The condition</label><textarea id="cd" placeholder="e.g. Release only after the revised quote is received."></textarea></div>',
      footer:'<button class="btn" data-x>Cancel</button><button class="btn ok" id="cg">Approve with this condition</button>',
      onOpen:(mv,close)=>{$('#cg',mv).onclick=()=>{const cond=$('#cd',mv).value.trim(); if(cond.length<5) return toast('Write the condition out in full.','bad'); close(); act('conditional','approve '+docNo(r)+' with a condition',{condition:cond})}}});
    $('#a-info',v).onclick=()=>{ const state={text:'',tagIds:[]};
      modal({title:'Ask for more / tag people',
        body:'<p style="margin-top:0" class="hint">Send <b>'+esc(docNo(r))+'</b> back without rejecting — earlier approvals stand. Type <b>@</b> to tag one or more people to check it (it parks until everyone tagged replies); leave it untagged to send to the requester.</p>'+
          '<div style="margin-top:12px"><label for="ai">What do you need? <span class="hint">type @ to tag — add as many as you like</span></label>'+
          '<div style="position:relative"><textarea id="ai" placeholder="e.g. @Name @Other please re-check the rate"></textarea><div id="ai-sug" style="position:absolute;z-index:6;left:0;right:0;display:none"></div></div>'+
          '<div id="ai-tags" class="row" style="gap:6px;flex-wrap:wrap;margin-top:6px"></div></div>'+
          '<div id="ai-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>',
        footer:'<button class="btn" data-x>Cancel</button><button class="btn hold" id="ai-go">Send</button>',
        onOpen:(mv,cl)=>{ wireMention(mv,'#ai','#ai-sug','#ai-tags',state);
          $('#ai-go',mv).onclick=()=>{ const t=(state.text||$('#ai',mv).value).trim(); if(t.length<3) return $('#ai-err',mv).textContent='Say what you need.'; cl();
            const tos=state.tagIds.length?state.tagIds:null;
            confirmPin('send '+docNo(r)+' back for more',async pin=>{ await rpc('act_on_step',{p_request:r.id,p_action:'info',p_remark:t,p_condition:'',p_pin:pin,p_files:filesPayload(files),p_tos:tos});
              await after(tos?('Tagged '+tos.map(id=>user(id).name).join(', ')+' to check.'):'Sent back to '+user(r.requesterId).name+'.'); }); }; }});
    };
    $('#a-no',v).onclick=()=>{if(!rem()){toast('Say why you are rejecting it before you close it.','bad');$('#d-rem',v).focus();return} act('reject','reject '+docNo(r))};
  }
  if(needsMyInfo(r)){
    const files=[]; uploader($('#i-files',v),files,{mode:'support',label:'Add the photos or documents that were asked for'});
    $('#i-send',v).onclick=async()=>{const t=$('#i-reply',v).value.trim(); if(!t&&!files.length){toast('Add a reply or at least one document.','bad');return}
      busy(true); try{ await rpc('reply_info',{p_request:r.id,p_text:t,p_files:filesPayload(files)}); await after('Reply sent.') }catch(e){fail(e)} finally{busy(false)} };
  }
  const nb=$('#ntb',v);
  if(nb) nb.onclick=async()=>{const t=$('#nt',v).value.trim(); if(!t){toast('Write something first.','bad');return}
    try{ await rpc('add_note',{p_request:r.id,p_text:t}); await after('Note posted.') }catch(e){fail(e)} };
}

/* ============================================================
   Saved hierarchies
   ============================================================ */
function applyTemplate(t){
  const gone=t.steps.filter(id=>{const u=DB.users.find(x=>x.id===id);return !u||!u.active});
  draft.chain=t.steps.filter(id=>{const u=DB.users.find(x=>x.id===id);return u&&u.active});
  if(gone.length) toast(gone.length+' person in that hierarchy is no longer active and was left out. Add a replacement.','bad');
}
function saveTemplateDialog(steps,onDone){
  if(!steps.length) return toast('Add some approvers first.','bad');
  modal({title:'Save this hierarchy',body:'<p class="hint" style="margin-top:0">'+steps.map((id,i)=>(i+1)+'. '+esc(user(id).name)).join('<br>')+'</p><div style="margin-top:14px"><label for="tn">Name it</label><input id="tn" type="text" placeholder="Site indent — manager, finance, director"></div>'+
      (isManager(ME)||ME.admin?'<label style="display:flex;align-items:center;gap:8px;margin-top:12px"><input type="checkbox" id="ts" style="width:auto"> Share with everyone</label>':'')+'<div id="te" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="tg">Save</button>',
    onOpen:(v,close)=>{$('#tn',v).focus();$('#tg',v).onclick=async()=>{const n=$('#tn',v).value.trim(); if(n.length<3) return $('#te',v).textContent='Give it a name you will recognise later.';
      const {error}=await SB.from('templates').insert({name:n,owner_id:ME.id,shared:!!($('#ts',v)||{}).checked,steps});
      if(error) return $('#te',v).textContent=/unique/i.test(error.message)?'You already have a hierarchy with that name.':error.message;
      await load(); close(); toast('Saved. Pick it by name when you raise a request.','ok'); if(onDone)onDone()}}});
}
let tplDraft=null;
function viewTpl(){
  head('Saved hierarchies','Set up the chains you use again and again');
  if(!tplDraft) tplDraft={id:null,name:'',shared:false,steps:[]};
  const editing=!!tplDraft.id, mine=DB.templates.filter(t=>t.ownerId===ME.id), shared=DB.templates.filter(t=>t.shared&&t.ownerId!==ME.id);
  const card=t=>{const own=t.ownerId===ME.id;
    return '<div class="filerow" style="flex-direction:column;align-items:stretch;gap:8px"><div class="row" style="gap:8px"><b style="font-size:14px">'+esc(t.name)+'</b>'+(t.shared?'<span class="tag t-ok">Shared</span>':'')+'<span class="hint" style="margin-left:auto">'+t.steps.length+' step'+(t.steps.length===1?'':'s')+'</span></div>'+
      '<div class="hint" style="margin:0">'+t.steps.map((id,i)=>{const u=DB.users.find(x=>x.id===id);return (i+1)+'. '+(u?esc(u.name)+(u.active?'':' <span class="tag t-bad">inactive</span>'):'<span class="tag t-bad">removed user</span>')}).join(' &nbsp;→&nbsp; ')+'</div>'+
      (own?'':'<div class="hint" style="margin:0">Shared by '+esc(user(t.ownerId).name)+'</div>')+'<div class="row" style="gap:7px">'+(own||ME.admin?'<button class="btn sm" data-ed="'+t.id+'">Edit</button>':'')+'<button class="btn sm" data-cp="'+t.id+'">Copy to mine</button>'+(own||ME.admin?'<button class="btn sm" data-del="'+t.id+'">Delete</button>':'')+'</div></div>'};
  return '<div class="detail-grid"><div class="card pad"><h3>'+(editing?'Edit this hierarchy':'Build a new hierarchy')+'</h3><p class="hint" style="margin-top:5px">Add people in the order they should sign. When you raise a request you pick this by name and the whole chain fills in.</p>'+
    '<div style="margin-top:14px"><label for="tp-name">Name it</label><input id="tp-name" type="text" value="'+esc(tplDraft.name)+'" placeholder="Site indent — manager, finance, director"></div>'+
    (isManager(ME)||ME.admin?'<label style="display:flex;align-items:center;gap:9px;margin-top:12px"><input type="checkbox" id="tp-share" style="width:auto" '+(tplDraft.shared?'checked':'')+'><span>Share with everyone<div class="hint">One official version instead of everyone building their own.</div></span></label>':'')+
    '<div class="finder" style="margin-top:14px"><label for="tp-find">Add an approver</label><input id="tp-find" type="text" placeholder="Name, email, designation or department" autocomplete="off"><div id="tp-res"></div></div><div id="tp-chain"></div>'+
    '<div class="row" style="gap:9px;margin-top:16px"><button class="btn primary" id="tp-save">'+(editing?'Save changes':'Save hierarchy')+'</button>'+(editing?'<button class="btn" id="tp-new">Start a new one</button>':'')+'<span class="hint" id="tp-note"></span></div></div>'+
    '<div><div class="card pad" style="margin-bottom:16px"><h3>Yours</h3>'+(mine.length?'<div class="filelist">'+mine.map(card).join('')+'</div>':'<p class="hint" style="margin-top:6px">Nothing saved yet.</p>')+'</div>'+
    '<div class="card pad"><h3>Shared with everyone</h3>'+(shared.length?'<div class="filelist">'+shared.map(card).join('')+'</div>':'<p class="hint" style="margin-top:6px">None yet. A manager or admin can publish one for the whole company.</p>')+'</div></div></div>';
}
function wireTpl(v){
  const paint=()=>{const c=$('#tp-chain',v);
    if(!tplDraft.steps.length){c.innerHTML='<div class="empty" style="padding:24px 12px"><h3>No approvers yet</h3><p class="hint">Search above and add the first one.</p></div>';return}
    c.innerHTML='<div class="picked">'+tplDraft.steps.map((id,i)=>{const u=user(id);return '<div class="r"><span class="seq">'+(i+1)+'</span><div class="av sm">'+inits(u.name)+'</div><div class="who" style="min-width:0;flex:1"><b>'+esc(u.name)+'</b><div class="hint">'+esc(u.role||'')+(u.dept?' · '+esc(u.dept):'')+'</div></div>'+
      '<span class="acts"><button class="btn sm" data-up="'+i+'" '+(i===0?'disabled':'')+'>↑</button><button class="btn sm" data-dn="'+i+'" '+(i===tplDraft.steps.length-1?'disabled':'')+'>↓</button><button class="btn sm" data-rm="'+i+'">Remove</button></span></div>'}).join('')+'</div><div class="hint" style="margin-top:9px">The person raising a request is always the first node, so this list starts at their first approver.</div>';
    $$('[data-up]',c).forEach(b=>b.onclick=()=>{const i=+b.dataset.up;[tplDraft.steps[i-1],tplDraft.steps[i]]=[tplDraft.steps[i],tplDraft.steps[i-1]];paint()});
    $$('[data-dn]',c).forEach(b=>b.onclick=()=>{const i=+b.dataset.dn;[tplDraft.steps[i+1],tplDraft.steps[i]]=[tplDraft.steps[i],tplDraft.steps[i+1]];paint()});
    $$('[data-rm]',c).forEach(b=>b.onclick=()=>{tplDraft.steps.splice(+b.dataset.rm,1);paint()})};
  paint();
  const find=$('#tp-find',v), res=$('#tp-res',v);
  find.oninput=()=>{const q=find.value.trim().toLowerCase(); if(!q){res.innerHTML='';return}
    const hits=DB.users.filter(u=>u.active&&u.id!==ME.id&&tplDraft.steps.indexOf(u.id)<0&&(u.name+' '+u.email+' '+u.dept+' '+u.role).toLowerCase().includes(q)).slice(0,7);
    res.innerHTML=hits.length?'<div class="results">'+hits.map(u=>'<button data-u="'+u.id+'"><div class="av sm">'+inits(u.name)+'</div><div style="min-width:0"><b>'+esc(u.name)+'</b><div class="hint">'+esc(u.role||'')+' | '+esc(u.dept||'')+'</div></div></button>').join('')+'</div>':'<div class="results"><div style="padding:12px 14px" class="hint">Nobody registered matches that.</div></div>';
    $$('.results button',res).forEach(b=>b.onclick=()=>{tplDraft.steps.push(b.dataset.u);find.value='';res.innerHTML='';paint();find.focus()})};
  $('#tp-name',v).oninput=e=>{tplDraft.name=e.target.value};
  if($('#tp-share',v)) $('#tp-share',v).onchange=e=>{tplDraft.shared=e.target.checked};
  if($('#tp-new',v)) $('#tp-new',v).onclick=()=>{tplDraft=null;render()};
  $('#tp-save',v).onclick=async()=>{const note=$('#tp-note',v); note.style.color='var(--stop)'; const n=tplDraft.name.trim();
    if(n.length<3) return note.textContent='Give it a name you will recognise later.'; if(!tplDraft.steps.length) return note.textContent='Add at least one approver.';
    const row={name:n,shared:tplDraft.shared,steps:tplDraft.steps};
    const {error}=tplDraft.id?await SB.from('templates').update(row).eq('id',tplDraft.id):await SB.from('templates').insert(Object.assign({owner_id:ME.id},row));
    if(error) return note.textContent=/unique/i.test(error.message)?'You already have a hierarchy with that name.':error.message;
    await load(); tplDraft=null; toast('Saved.','ok'); render()};
  $$('[data-ed]',v).forEach(b=>b.onclick=()=>{const t=DB.templates.find(x=>x.id===b.dataset.ed);tplDraft={id:t.id,name:t.name,shared:t.shared,steps:t.steps.slice()};render();window.scrollTo(0,0)});
  $$('[data-cp]',v).forEach(b=>b.onclick=()=>{const t=DB.templates.find(x=>x.id===b.dataset.cp);tplDraft={id:null,name:t.name+' (my copy)',shared:false,steps:t.steps.slice()};render();window.scrollTo(0,0);toast('Copied into the editor. Adjust it and save.','ok')});
  $$('[data-del]',v).forEach(b=>b.onclick=()=>{const t=DB.templates.find(x=>x.id===b.dataset.del);
    modal({title:'Delete this hierarchy',body:'<p style="margin-top:0">Delete <b>'+esc(t.name)+'</b>? Requests already raised with it are unaffected.</p>',footer:'<button class="btn" data-x>Keep it</button><button class="btn bad" id="dg">Delete</button>',
      onOpen:(mv,cl)=>{$('#dg',mv).onclick=async()=>{const {error}=await SB.from('templates').delete().eq('id',t.id); if(error) return fail(error); await load(); cl(); if(tplDraft&&tplDraft.id===t.id)tplDraft=null; render(); toast('Deleted.','ok')}}})});
}

/* ============================================================
   Team
   ============================================================ */
function viewTeam(){
  head('My team',(ME.owner?'As super admin':ME.admin?'As an admin':'As a manager')+' you can hand work to anyone who reports to you');
  const team=teamOf(ME.id), pend=pendingTeam(ME.id);
  const load2=u=>DB.requests.reduce((n,r)=>n+r.chain.reduce((m,s)=>m+tasksOf(s).filter(t=>t.userId===u.id&&t.status==='open').length,0),0);
  return (pend.length?'<div class="card pad" style="margin-bottom:16px;border-color:var(--hold)"><h3>Waiting for you to confirm</h3><p class="hint" style="margin-top:5px">These people picked you as their manager. Confirm only the ones who really report to you — an unconfirmed person cannot be assigned work.</p><div style="margin-top:12px">'+
    pend.map(u=>'<div class="filerow"><div class="av sm">'+inits(u.name)+'</div><div style="min-width:0;flex:1"><b>'+esc(u.name)+'</b><div class="hint">'+esc(u.role)+' · '+esc(u.dept||'')+'</div></div><button class="btn sm ok" data-yes="'+u.id+'">Confirm</button><button class="btn sm" data-no="'+u.id+'">Not my team</button></div>').join('')+'</div></div>':'')+
   '<div class="card pad" style="margin-bottom:16px"><div class="row" style="flex-wrap:wrap"><div><h3>'+team.length+' confirmed team member'+(team.length===1?'':'s')+'</h3><p class="hint" style="margin-top:4px">You can hand any of them a task when a request reaches your step.</p></div><button class="btn primary" id="t-add" style="margin-left:auto">Add someone to my team</button></div></div>'+
   (team.length?'<div class="card"><table class="cards"><thead><tr><th>Name</th><th>Designation</th><th>Department</th><th>Open tasks</th><th></th></tr></thead><tbody>'+team.map(u=>'<tr><td><div class="row" style="gap:10px"><div class="av sm">'+inits(u.name)+'</div><div><b>'+esc(u.name)+'</b><div class="hint">'+esc(u.email)+'</div></div></div></td><td class="meta">'+esc(u.role||'')+'</td><td class="hint meta">'+esc(u.dept||'')+'</td><td class="num meta">'+(load2(u)?load2(u)+' open task'+(load2(u)===1?'':'s'):'no open tasks')+'</td><td class="acts" style="text-align:right"><button class="btn sm" data-rm="'+u.id+'">Remove</button></td></tr>').join('')+'</tbody></table></div>'
    :'<div class="card"><div class="empty"><h3>Nobody on your team yet</h3><p class="hint">Add people here, or wait for them to pick you as their manager in their directory entry.</p></div></div>');
}
function wireTeam(v){
  const doit=async(fn,args,msg)=>{try{await rpc(fn,args);await load();render();paintNav();toast(msg,'ok')}catch(e){fail(e)}};
  $$('[data-yes]',v).forEach(b=>b.onclick=()=>doit('confirm_team',{p_user:b.dataset.yes,p_accept:true},user(b.dataset.yes).name+' is on your team.'));
  $$('[data-no]',v).forEach(b=>b.onclick=()=>doit('confirm_team',{p_user:b.dataset.no,p_accept:false},'Removed from your pending list.'));
  $$('[data-rm]',v).forEach(b=>b.onclick=()=>doit('remove_team_member',{p_user:b.dataset.rm},user(b.dataset.rm).name+' removed from your team.'));
  const add=$('#t-add',v);
  if(add) add.onclick=()=>modal({title:'Add someone to your team',body:'<p class="hint" style="margin-top:0">Pick anyone registered. They are added straight away — you are vouching for them.</p><div style="margin-top:14px"><label for="ta">Person</label><select id="ta"><option value="">Choose…</option>'+
      DB.users.filter(u=>u.active&&u.id!==ME.id&&u.managerId!==ME.id).map(u=>'<option value="'+u.id+'">'+esc(u.name)+' — '+esc(u.role||'')+', '+esc(u.dept||'')+'</option>').join('')+'</select></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="tg">Add to my team</button>',
    onOpen:(mv,close)=>{$('#tg',mv).onclick=async()=>{const id=$('#ta',mv).value; if(!id) return toast('Pick someone first.','bad'); close(); doit('add_team_member',{p_user:id},user(id).name+' added to your team.')}}});
}

/* ============================================================
   Reports
   ============================================================ */
let rep={from:'',to:'',status:'',type:'',requester:'',approver:''};
function repList(){
  let l=visible().sort((a,b)=>b.createdAt-a.createdAt);
  if(rep.from) l=l.filter(r=>r.createdAt>=new Date(rep.from+'T00:00:00').getTime()); if(rep.to) l=l.filter(r=>r.createdAt<=new Date(rep.to+'T23:59:59').getTime());
  if(rep.status) l=l.filter(r=>r.status===rep.status); if(rep.type) l=l.filter(r=>r.type===rep.type);
  if(rep.requester) l=l.filter(r=>r.requesterId===rep.requester); if(rep.approver) l=l.filter(r=>r.chain.some(s=>s.userId===rep.approver));
  return l;
}
function viewReport(){
  const l=repList(), ok=l.filter(r=>r.status==='Approved'), avg=ok.length?(ok.reduce((s,r)=>s+(r.closedAt-r.createdAt),0)/ok.length/864e5).toFixed(1):'—';
  const val=l.filter(r=>r.type==='workorder').reduce((s,r)=>s+(Number(r.f.amountPost)||0),0), opts=DB.users.map(u=>'<option value="'+u.id+'">'+esc(u.name)+'</option>').join('');
  return '<div class="card pad" style="margin-bottom:16px"><div class="grid filters">'+
    '<div><label for="r-f">From</label><input id="r-f" type="date" value="'+rep.from+'"></div><div><label for="r-t">Until</label><input id="r-t" type="date" value="'+rep.to+'"></div>'+
    '<div><label for="r-ty">Type</label><select id="r-ty"><option value="">Both</option><option value="indent" '+(rep.type==='indent'?'selected':'')+'>Indent</option><option value="workorder" '+(rep.type==='workorder'?'selected':'')+'>Work order</option></select></div>'+
    '<div><label for="r-s">Status</label><select id="r-s"><option value="">All</option>'+['In Progress','Info Requested','Approved','Rejected'].map(s=>'<option '+(rep.status===s?'selected':'')+'>'+s+'</option>').join('')+'</select></div>'+
    '<div><label for="r-rq">Raised by</label><select id="r-rq"><option value="">Anyone</option>'+opts+'</select></div><div><label for="r-ap">Approver</label><select id="r-ap"><option value="">Anyone</option>'+opts+'</select></div></div>'+
    '<div class="row actions" style="margin-top:14px;flex-wrap:wrap"><button class="btn primary" id="r-x">Download spreadsheet</button><button class="btn ghost sm" id="r-cl">Clear filters</button>'+
    '<span class="hint summary" style="margin-left:auto">'+l.length+' requests · work order value '+money(val||0)+' · average clearance '+avg+' days</span></div></div>'+
    (l.length?'<div class="card">'+rowsHTML(l)+'</div>':'<div class="card"><div class="empty"><h3>Nothing in that range</h3></div></div>')+
    '<div class="card pad" style="margin-top:16px"><h3>What comes out in the file</h3><p class="hint" style="margin-top:6px">Four sheets — every request with its outcome, every approval step with remarks and conditions, every task a manager handed to their team, and the audit trail. You get what you are allowed to see; an admin gets everything.</p></div>';
}
function repRows(){
  const l=repList();
  const A=[['Reference','Type','Document No','Category','Sub-category','Site / Project','Site code','Date on document','Vendor','Vendor GSTIN','Amount before GST','Amount after GST','Remarks','Raised by','Department','Raised on','Status','Currently with','Approval chain','Closed on','Days taken','Documents']];
  l.forEach(r=>{const u=user(r.requesterId),h=holder(r),f=r.f;
    A.push([r.ref,typeLabel(r),docNo(r),f.category||'',f.subCategory||'',f.category==='Project'?(f.projectName||''):(f.siteName||''),f.siteCode||'',fmtD(r.type==='indent'?f.indentDate:f.woDate),f.vendorName||'',f.vendorGstin||'',f.amountPre||'',f.amountPost||'',String(f.remarks||'').replace(/\n+/g,' '),u.name,u.dept||'',fmtD(r.createdAt),r.status,h?h.name:'—',r.chain.map(s=>user(s.userId).name).join(' > '),r.closedAt?fmtD(r.closedAt):'',r.closedAt?((r.closedAt-r.createdAt)/864e5).toFixed(1):'',r.files.map(x=>x.name).join('; ')])});
  A.push([]); A.push(['Generated '+fmtDT(Date.now())+' by '+ME.name+' · System designed and developed by Sunny Gupta']);
  const B=[['Reference','Step','Approver','Designation','Outcome','Condition','Remarks','Acted on']];
  l.forEach(r=>r.chain.forEach((s,i)=>{const u=user(s.userId);const o={approved:'Approved',conditional:'Approved with a condition',rejected:'Rejected',info:'Asked for more details',pending:'Holding now',waiting:'Waiting turn'}[s.status]||s.status;
    B.push([r.ref,i+2,u.name,u.role||'',o,s.condition||'',String(s.remark||'').replace(/\n+/g,' '),s.actedAt?fmtDT(s.actedAt):''])}));
  const D=[['Reference','Step','Manager','Assigned to','Task','Outcome','Their note','Given','Closed']];
  l.forEach(r=>r.chain.forEach((s,i)=>tasksOf(s).forEach(t=>{const o={open:'Open',done:'Done',cannot:'Could not do it',withdrawn:'Withdrawn'}[t.status]||t.status;
    D.push([r.ref,i+2,user(s.userId).name,user(t.userId).name,t.task,o,String(t.note||'').replace(/\n+/g,' '),fmtDT(t.assignedAt),t.closedAt?fmtDT(t.closedAt):''])})));
  const refs={}; l.forEach(r=>refs[r.ref]=1);
  const C=[['When','Reference','Who','Action','Detail']]; DB.audit.filter(a=>refs[a.ref]).forEach(a=>C.push([fmtDT(a.ts),a.ref,a.actorName,a.action,a.detail]));
  return {A,B,C,D};
}
function wireReport(v){
  const set=(id,k)=>{const e=$(id,v);if(!e)return;if(rep[k])e.value=rep[k];e.onchange=()=>{rep[k]=e.value;render()}};
  set('#r-f','from');set('#r-t','to');set('#r-ty','type');set('#r-s','status');set('#r-rq','requester');set('#r-ap','approver');
  $('#r-cl',v).onclick=()=>{rep={from:'',to:'',status:'',type:'',requester:'',approver:''};render()};
  $('#r-x',v).onclick=()=>{const R=repRows(), wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(R.A),'Requests');XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(R.B),'Approval steps');
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(R.D),'Assigned tasks');XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(R.C),'Audit trail');
    XLSX.writeFile(wb,'setu-report-'+new Date().toISOString().slice(0,10)+'.xlsx'); toast('Spreadsheet downloaded.','ok')};
  wireList(v);
}

/* ============================================================
   Usage
   ============================================================ */
let usageSort='today', usageQ='', storageInfo=null;
/* ============================================================
   Assistant / proxy — read-only mirror of a principal's work + ERP stamp
   ============================================================ */
const _legFiles=r=>(r.files||[]).map(fl=>fl.name).join(' ');
const _flowFiles=f=>{ const n=[]; (f.steps||[]).forEach(s=>(s.files||[]).forEach(fl=>n.push(fl.name))); (f._files||[]).forEach(fl=>n.push(fl.name)); return n.join(' '); };
const _legHay=r=>(r.ref+' '+docNo(r)+' '+docTitle(r)+' '+_legFiles(r)+' '+(r.type==='indent'?'ind indent':'wo work order')).toLowerCase();
const _flowHay=(f,lbl)=>(f.ref+' '+(lbl||'')+' '+(f.title||'')+' '+f.head+' '+f.division+' '+_flowFiles(f)+' '+(f.head==='PO'?'po purchase indent':'wo work order advice')).toLowerCase();
// document type for the status/type filter: indent | po | advice | wo
function _flowDtype(f,stage){ if(/advice/i.test(stage||'')) return 'advice'; return f.head==='PO'?(/indent/i.test(stage||'')?'indent':'po'):'wo'; }
function assistErpList(doneWanted){
  const pid=ME.assistsId, out=[]; if(!pid) return out;
  DB.requests.forEach(r=>r.chain.forEach(s=>{
    if(s.userId===pid && (s.status==='approved'||s.status==='conditional') && (!!s.erpDone===!!doneWanted))
      out.push({engine:'legacy',reqId:r.id,stepId:s.id,ref:r.ref,title:docTitle(r),doc:docNo(r),when:s.actedAt,erpAt:s.erpDoneAt,hay:_legHay(r),dtype:r.type==='indent'?'indent':'wo'});
  }));
  DB.flows.forEach(f=>f.steps.forEach(s=>{
    if(s.actedBy===pid && s.status==='done' && !String(s.remark||'').startsWith('Rejected') && (s.action==='approve'||s.action==='confirm') && (!!s.erpDone===!!doneWanted))
      out.push({engine:'flow',reqId:f.id,stepId:s.id,ref:f.ref,title:(f.title||flowHeadLabel(f.head)+' · '+f.division),doc:s.label,when:s.actedAt,erpAt:s.erpDoneAt,hay:_flowHay(f,s.label),dtype:_flowDtype(f,s.stage)});
  }));
  out.sort((a,b)=>(b.when||0)-(a.when||0));
  return out;
}
const assistErpTodo=()=>(ME&&ME.assistsId)?assistErpList(false):[];
function assistPending(){
  const pid=ME.assistsId, out=[]; if(!pid) return out;
  DB.requests.forEach(r=>{ if(r.status==='In Progress'&&r.chain[r.current]&&r.chain[r.current].userId===pid)
    out.push({engine:'legacy',id:r.id,ref:r.ref,title:docTitle(r),doc:docNo(r),hay:_legHay(r),dtype:r.type==='indent'?'indent':'wo'}); });
  DB.flows.forEach(f=>{ const s=flowLive(f); if(s&&s.actors.indexOf(pid)>-1)
    out.push({engine:'flow',id:f.id,ref:f.ref,title:(f.title||flowHeadLabel(f.head)+' · '+f.division),doc:s.label,hay:_flowHay(f,s.label),dtype:_flowDtype(f,s.stage)}); });
  return out;
}
let assistQ='', assistStatus='all', assistType='all';
const assistMatch=(x,q)=>(!q||(x.hay||'').includes(q))&&(assistType==='all'||x.dtype===assistType);
function viewAssist(){
  const p=myPrincipal();
  head('Assisting '+(p?p.name:''), p?('See what is on '+p.name.split(' ')[0]+', and mark ERP entries once they approve'):'');
  if(!p) return '<div class="card pad"><h3>No principal set</h3><p class="hint" style="margin-top:6px">Your assistant link has not been set up. Ask an administrator to set who you assist.</p></div>';
  const fn=p.name.split(' ')[0];
  const allPending=assistPending(), allTodo=assistErpList(false), allDone=assistErpList(true);
  const q=assistQ.trim().toLowerCase();
  const pending=allPending.filter(x=>assistMatch(x,q)), todo=allTodo.filter(x=>assistMatch(x,q)), done=allDone.filter(x=>assistMatch(x,q));
  const showApproved=assistStatus==='all'||assistStatus==='approved';
  const showPending =assistStatus==='all'||assistStatus==='pending';
  const openAttr=x=>'data-open="'+x.engine+':'+(x.reqId||x.id)+'"';
  let h='<div class="grid g3">'+
    stat('Pending on '+fn,allPending.length,'Waiting for their decision','var(--hold)')+
    stat('To enter in ERP',allTodo.length,'Approved — do the ERP entry','var(--indigo)')+
    stat('ERP entries done',allDone.length,'Marked by you','var(--seal)')+'</div>';
  h+='<div class="row" style="gap:10px;flex-wrap:wrap;margin:16px 0 0">'+
    '<input id="as-q" type="text" placeholder="Search by uploaded file number — e.g. WW26O03-003" value="'+esc(assistQ)+'" style="flex:1;min-width:220px">'+
    '<select id="as-status" style="max-width:220px">'+[['all','Any status'],['approved','Approved by '+fn],['pending','Pending with '+fn]].map(o=>'<option value="'+o[0]+'" '+(assistStatus===o[0]?'selected':'')+'>'+esc(o[1])+'</option>').join('')+'</select>'+
    '<select id="as-type" style="max-width:180px">'+[['all','All documents'],['indent','Indent'],['po','PO'],['advice','Advice'],['wo','Work order']].map(o=>'<option value="'+o[0]+'" '+(assistType===o[0]?'selected':'')+'>'+esc(o[1])+'</option>').join('')+'</select>'+
    (q||assistStatus!=='all'||assistType!=='all'?'<button class="btn ghost sm" id="as-clear">Clear</button>':'')+'</div>';
  if(showApproved) h+='<div class="card" style="margin-top:14px"><div class="row" style="padding:13px 16px;border-bottom:1px solid var(--line)"><h3>To enter in ERP</h3><span class="hint" style="margin-left:auto">'+todo.length+'</span></div>'+
    (todo.length?todo.map(x=>'<div class="filerow"><div style="min-width:0;flex:1;cursor:pointer" class="assist-open" '+openAttr(x)+'><b>'+esc(x.doc||x.title)+'</b><div class="hint">'+esc(x.ref)+' · '+esc(x.title)+' · approved '+esc(fmtDT(x.when))+(x.engine==='flow'?' · Fixed flow':' · Custom chain')+'</div></div>'+
      '<button class="btn ok sm" data-erp="'+x.engine+':'+x.stepId+'">ERP entry done</button></div>').join('')
     :'<div class="empty" style="padding:24px 12px"><h3>'+(q?'No match':'Nothing to enter')+'</h3><p class="hint">'+(q?'No approved item matches your search.':'When '+esc(fn)+' approves something, it appears here to enter in ERP.')+'</p></div>')+'</div>';
  if(showPending) h+='<div class="card" style="margin-top:16px"><div class="row" style="padding:13px 16px;border-bottom:1px solid var(--line)"><h3>Waiting on '+esc(p.name)+'</h3><span class="hint" style="margin-left:auto">'+pending.length+'</span></div>'+
    (pending.length?pending.map(x=>'<div class="filerow assist-open" style="cursor:pointer" '+openAttr(x)+'><div style="min-width:0;flex:1"><b>'+esc(x.doc||x.title)+'</b><div class="hint">'+esc(x.ref)+' · '+esc(x.title)+(x.engine==='flow'?' · Fixed flow':' · Custom chain')+'</div></div><span class="tag t-prog">With '+esc(fn)+'</span></div>').join('')
     :'<div class="empty" style="padding:24px 12px"><h3>'+(q?'No match':'Nothing pending')+'</h3><p class="hint">'+(q?'No pending item matches your search.':'Nothing is sitting on '+esc(fn)+' right now.')+'</p></div>')+'</div>';
  if(showApproved&&done.length) h+='<div class="card" style="margin-top:16px"><div class="row" style="padding:13px 16px;border-bottom:1px solid var(--line)"><h3>ERP entries done</h3><span class="hint" style="margin-left:auto">'+done.length+'</span></div>'+
    done.slice(0,60).map(x=>'<div class="filerow assist-open" style="cursor:pointer" '+openAttr(x)+'><div style="min-width:0;flex:1"><b>'+esc(x.doc||x.title)+'</b><div class="hint">'+esc(x.ref)+' · '+esc(x.title)+' · entered '+esc(fmtDT(x.erpAt))+'</div></div><span class="tag t-ok">ERP done</span></div>').join('')+'</div>';
  h+='<p class="hint" style="margin-top:14px">You can open any item to read it, but only '+esc(fn)+' can approve. “ERP entry done” just records that you entered it in ERP — it never changes the approval. You can also raise your own gate passes from the Gate Pass page.</p>';
  return h;
}
function wireAssist(v){
  $$('.assist-open',v).forEach(el=>el.onclick=()=>{ const parts=el.dataset.open.split(':'); go({name:parts[0]==='flow'?'flowdetail':'detail',id:parts[1]}); });
  $$('[data-erp]',v).forEach(b=>b.onclick=async()=>{ const parts=b.dataset.erp.split(':'); b.disabled=true;
    try{ await rpc(parts[0]==='flow'?'flow_erp_mark':'erp_mark',{p_step:parts[1],p_done:true}); await load(); toast('Marked as entered in ERP.','ok'); render(); }
    catch(e){ b.disabled=false; fail(e); } });
  if($('#as-q',v)) $('#as-q',v).oninput=()=>{ assistQ=$('#as-q',v).value; const pos=$('#as-q',v).selectionStart; render(); const n=$('#as-q'); if(n){ n.focus(); try{n.setSelectionRange(pos,pos)}catch(e){} } };
  if($('#as-status',v)) $('#as-status',v).onchange=()=>{ assistStatus=$('#as-status',v).value; render(); };
  if($('#as-type',v)) $('#as-type',v).onchange=()=>{ assistType=$('#as-type',v).value; render(); };
  if($('#as-clear',v)) $('#as-clear',v).onclick=()=>{ assistQ=''; assistStatus='all'; assistType='all'; render(); };
}
/* ============================================================
   System overview — owner-only analytics across the whole system
   ============================================================ */
function ovBars(items){
  const max=Math.max(1,...items.map(i=>i.value||0));
  return '<div style="display:flex;flex-direction:column;gap:10px;margin-top:4px">'+items.map(i=>
    '<div><div class="row" style="justify-content:space-between;font-size:13px;margin-bottom:4px"><span>'+esc(i.label)+'</span><b class="num">'+(i.value||0)+'</b></div>'+
    '<div style="height:9px;background:var(--surface-2);border-radius:999px;overflow:hidden"><div style="height:100%;width:'+Math.round((i.value||0)/max*100)+'%;background:'+(i.color||'var(--indigo)')+';border-radius:999px;min-width:'+((i.value||0)?'4px':'0')+'"></div></div></div>').join('')+'</div>';
}
function ovCard(title,inner){ return '<div class="card pad"><h3>'+esc(title)+'</h3>'+inner+'</div>'; }
function viewOverview(){
  head('System overview','Everything SETU has processed, at a glance');
  const us=DB.users.slice(), teamMs=f=>us.reduce((t,u)=>t+f(u),0);
  const onlineNow=us.filter(u=>{const l=statsOf(u).lastLogin;return l&&Date.now()-l<15*60000}).length;
  const totalWork=us.reduce((t,u)=>{const w=workOf(u);return t+w.acted+w.tasks},0);
  // ---- documents: both engines (legacy custom chain + ALDS fixed flow) ----
  const reqs=DB.requests, flows=DB.flows;
  const legIndent=reqs.filter(r=>r.type==='indent').length, legWO=reqs.filter(r=>r.type==='workorder').length;
  const flowPO=flows.filter(f=>f.head==='PO').length, flowWO=flows.filter(f=>f.head==='WO').length;
  const totalDocs=reqs.length+flows.length;
  const indentTotal=legIndent+flowPO, woTotal=legWO+flowWO;
  const approved=reqs.filter(r=>r.status==='Approved').length+flows.filter(f=>f.status==='completed').length;
  const inprog =reqs.filter(r=>r.status==='In Progress'||r.status==='Info Requested').length+flows.filter(f=>f.status==='running').length;
  const rejected=reqs.filter(r=>r.status==='Rejected').length+flows.filter(f=>f.status==='cancelled').length;
  // ---- gate passes ----
  const gp=DB.passes;
  const gpBy=k=>gp.filter(g=>g.kind===k).length, gpSt=s=>gp.filter(g=>g.status===s).length;
  const half1=gp.filter(g=>g.kind==='halfday'&&g.halfPart==='1st').length,
        half2=gp.filter(g=>g.kind==='halfday'&&g.halfPart==='2nd').length,
        halfNA=gpBy('halfday')-half1-half2;
  const divCount=d=>flows.filter(f=>f.division===d).length;

  const cards1='<div class="grid g4">'+
    stat('People',us.length,us.filter(u=>u.active).length+' active · '+onlineNow+' online now','var(--indigo)')+
    stat('Indents & work orders',totalDocs,approved+' approved · '+inprog+' in progress','var(--seal)')+
    stat('Gate passes',gp.length,gpSt('closed')+' closed · '+(gpSt('pending_hod')+gpSt('pending_hr')+gpSt('pending_gate')+gpSt('out'))+' open','var(--cyan)')+
    stat('Decisions & tasks',totalWork,'Actions recorded across every request','var(--hold)')+'</div>';
  const cards2='<div class="grid g3" style="margin-top:14px">'+
    stat('System time — today',hms(teamMs(u=>spanMs(u,1))),us.filter(activeToday).length+' people active today','var(--indigo)')+
    stat('System time — this month',hms(teamMs(monthMs)),'Whole team, calendar month','var(--indigo)')+
    stat('System time — all time',hms(teamMs(u=>statsOf(u).activeMs)),'Since the first sign-in','var(--indigo)')+'</div>';

  const docBreak='<div class="grid g2" style="margin-top:16px;align-items:start">'+
    ovCard('Indents & work orders — breakdown',
      '<div class="hint" style="margin-bottom:8px">By document</div>'+ovBars([
        {label:'Indents / PO',value:indentTotal,color:'var(--indigo)'},
        {label:'Work orders / WO',value:woTotal,color:'var(--seal)'}])+
      '<div class="sep"></div><div class="hint" style="margin-bottom:8px">By status</div>'+ovBars([
        {label:'Approved / completed',value:approved,color:'var(--seal)'},
        {label:'In progress',value:inprog,color:'var(--hold)'},
        {label:'Rejected / cancelled',value:rejected,color:'var(--stop)'}])+
      '<div class="sep"></div><div class="hint" style="margin-bottom:8px">By engine</div>'+ovBars([
        {label:'Custom chain (legacy)',value:reqs.length,color:'var(--cyan)'},
        {label:'Fixed flow (ALDS)',value:flows.length,color:'var(--indigo)'}])+
      (flows.length?'<div class="sep"></div><div class="hint" style="margin-bottom:8px">ALDS flow by division</div>'+ovBars([
        {label:'O&M',value:divCount('O&M'),color:'var(--indigo)'},
        {label:'Project',value:divCount('Project'),color:'var(--seal)'},
        {label:'Retail',value:divCount('Retail'),color:'var(--cyan)'}]):''))+
    ovCard('Gate passes — breakdown',
      '<div class="hint" style="margin-bottom:8px">By type</div>'+ovBars([
        {label:'Early going',value:gpBy('early'),color:'var(--indigo)'},
        {label:'Half day leave',value:gpBy('halfday'),color:'var(--seal)'},
        {label:'Outpass',value:gpBy('official'),color:'var(--cyan)'}])+
      (gpBy('halfday')?'<div class="sep"></div><div class="hint" style="margin-bottom:8px">Half-day — which half</div>'+ovBars([
        {label:'1st half',value:half1,color:'var(--indigo)'},
        {label:'2nd half',value:half2,color:'var(--seal)'}].concat(halfNA>0?[{label:'Not specified',value:halfNA,color:'var(--line)'}]:[])):'')+
      '<div class="sep"></div><div class="hint" style="margin-bottom:8px">By status</div>'+ovBars([
        {label:'With HOD',value:gpSt('pending_hod'),color:'var(--hold)'},
        {label:'With HR',value:gpSt('pending_hr'),color:'var(--hold)'},
        {label:'At the gate',value:gpSt('pending_gate'),color:'var(--seal)'},
        {label:'Out',value:gpSt('out'),color:'var(--cyan)'},
        {label:'Closed',value:gpSt('closed'),color:'var(--seal)'},
        {label:'Declined',value:gpSt('rejected'),color:'var(--stop)'}]))+
    '</div>';

  return cards1+cards2+docBreak+
    // item 11: gate photo 7-day deletion — what's stored, and a log of every cleanup run
    '<div class="card" style="margin-top:16px"><div class="row" style="padding:14px 18px;border-bottom:1px solid var(--line);gap:10px;flex-wrap:wrap"><h3>Gate photos — 7-day deletion</h3>'+
      '<button class="btn sm" id="ov-purge-run" style="margin-left:auto">Run cleanup now</button></div><div id="ov-purge" style="padding:12px 18px"><span class="spin sm"></span> Loading…</div></div>'+
    '<div class="row" style="margin-top:16px;gap:10px;flex-wrap:wrap"><button class="btn primary" id="ov-dl">Download overview (Excel)</button>'+
    '<button class="btn" id="ov-usage">Open per-person usage</button>'+
    '<span class="hint">Live figures from the whole system. Usage time counts only while the app is open and in front, added up across each person\'s devices.</span></div>';
}
/* item 11: owner's view of the gate-photo deletion: stored now, overdue, and every run */
async function paintPurge(v){
  const box=$('#ov-purge',v); if(!box) return;
  try{
    const [st,lg]=await Promise.all([ rpc('gp_photo_stats'), SB.from('photo_purge_log').select('*').order('ran_at',{ascending:false}).limit(30) ]);
    if(lg.error) throw lg.error;
    const log=lg.data||[], last=log[0], mb=b=>(Number(b||0)/1048576).toFixed(1)+' MB';
    const overdue=Number(st&&st.overdue||0);
    box.innerHTML='<div class="grid g4" style="gap:10px">'+
        stat('Gate photos stored',(st&&st.stored)||0,mb(st&&st.bytes)+' · selfies + thumbnails','var(--indigo)')+
        stat('Past 7 days, not yet deleted',overdue,overdue?'Deleted at the next run':'Nothing overdue',overdue?'var(--hold)':'var(--seal)')+
        stat('Last cleanup',last?fmtDT(ts(last.ran_at)):'Not run yet',last?(last.photos_deleted+' deleted · '+mb(last.bytes_freed)):'Runs nightly at 3:00 am','var(--cyan)')+
        stat('Schedule','Daily 3:00 am','Photos are deleted 7 days after they were taken','var(--seal)')+'</div>'+
      (log.length?'<div class="scroll-x" style="margin-top:12px"><table style="min-width:560px"><thead><tr><th>When</th><th>How</th><th>Photos deleted</th><th>Space freed</th><th>Passes cleared</th><th>Problems</th></tr></thead><tbody>'+
        log.map(r=>'<tr><td>'+esc(fmtDT(ts(r.ran_at)))+'</td><td class="hint">'+esc(r.source==='manual'?'Run now':'Scheduled')+'</td><td class="num">'+r.photos_deleted+'</td><td class="num">'+mb(r.bytes_freed)+'</td><td class="num">'+r.passes_cleared+'</td><td class="hint">'+esc(r.errors||'—')+'</td></tr>').join('')+
        '</tbody></table></div>'
        :'<p class="hint" style="margin-top:10px">No cleanup has run yet. It runs every night at 3:00 am, or tap “Run cleanup now”.</p>');
  }catch(e){ box.innerHTML='<p class="hint">Could not load the deletion log ('+esc((e.message||'').replace(/^.*?: /,''))+'). Has 59-photo-purge-and-site-tags.sql been run?</p>'; }
}
function wireOverview(v){
  paintPurge(v);
  if($('#ov-purge-run',v)) $('#ov-purge-run',v).onclick=async()=>{ const b=$('#ov-purge-run',v); b.disabled=true; b.textContent='Running…';
    try{ const {data,error}=await SB.functions.invoke('gate-photo-purge',{body:{source:'manual'}}); if(error) throw error;
      if(data&&data.skipped) toast(data.reason||'Skipped — it ran a few minutes ago.','hold');
      else toast('Cleanup done — '+((data&&data.deleted)||0)+' photo(s) deleted.','ok');
      paintPurge(v); }
    catch(e){ toast('Cleanup could not run: '+((e&&e.message)||'is the gate-photo-purge function deployed?'),'bad'); }
    finally{ b.disabled=false; b.textContent='Run cleanup now'; } };
  if($('#ov-usage',v)) $('#ov-usage',v).onclick=()=>go({name:'usage'});
  if($('#ov-dl',v)) $('#ov-dl',v).onclick=()=>{
    if(!window.XLSX) return toast('Spreadsheet engine still loading — try again in a moment.','bad');
    const reqs=DB.requests, flows=DB.flows, gp=DB.passes, us=DB.users, teamMs=f=>us.reduce((t,u)=>t+f(u),0);
    const S=[['SETU — system overview','as of '+fmtDT(Date.now())],[],
      ['People (total)',us.length],['People (active)',us.filter(u=>u.active).length],
      ['System time — today',hms(teamMs(u=>spanMs(u,1)))],['System time — this month',hms(teamMs(monthMs))],['System time — all time',hms(teamMs(u=>statsOf(u).activeMs))],[],
      ['Documents (total)',reqs.length+flows.length],
      ['  Indents / PO',reqs.filter(r=>r.type==='indent').length+flows.filter(f=>f.head==='PO').length],
      ['  Work orders / WO',reqs.filter(r=>r.type==='workorder').length+flows.filter(f=>f.head==='WO').length],
      ['  Approved / completed',reqs.filter(r=>r.status==='Approved').length+flows.filter(f=>f.status==='completed').length],
      ['  In progress',reqs.filter(r=>r.status==='In Progress'||r.status==='Info Requested').length+flows.filter(f=>f.status==='running').length],
      ['  Rejected / cancelled',reqs.filter(r=>r.status==='Rejected').length+flows.filter(f=>f.status==='cancelled').length],
      ['  Custom chain (legacy)',reqs.length],['  Fixed flow (ALDS)',flows.length],[],
      ['Gate passes (total)',gp.length],
      ['  Early going',gp.filter(g=>g.kind==='early').length],
      ['  Half day leave',gp.filter(g=>g.kind==='halfday').length],
      ['    1st half',gp.filter(g=>g.kind==='halfday'&&g.halfPart==='1st').length],
      ['    2nd half',gp.filter(g=>g.kind==='halfday'&&g.halfPart==='2nd').length],
      ['  Outpass',gp.filter(g=>g.kind==='official').length],
      ['  With HOD',gp.filter(g=>g.status==='pending_hod').length],
      ['  With HR',gp.filter(g=>g.status==='pending_hr').length],
      ['  At the gate',gp.filter(g=>g.status==='pending_gate').length],
      ['  Out',gp.filter(g=>g.status==='out').length],
      ['  Closed',gp.filter(g=>g.status==='closed').length],
      ['  Declined',gp.filter(g=>g.status==='rejected').length]];
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(S),'Overview');
    XLSX.writeFile(wb,'setu-overview-'+new Date().toISOString().slice(0,10)+'.xlsx'); toast('Overview downloaded.','ok');
  };
}
function viewUsage(){
  if(!storageInfo){ rpc('storage_usage').then(x=>{storageInfo=x; if(ROUTE.name==='usage') render()}).catch(()=>{}) }
  head('Usage','Who is actually using the system, and how much');
  const us=DB.users.slice(), teamMs=f=>us.reduce((t,u)=>t+f(u),0);
  const onlineNow=us.filter(u=>{const l=statsOf(u).lastLogin;return l&&Date.now()-l<15*60000}).length, pinsSet=us.filter(pinOK).length;
  const totalWork=us.reduce((t,u)=>{const w=workOf(u);return t+w.acted+w.tasks},0);
  const sorters={today:(a,b)=>spanMs(b,1)-spanMs(a,1),week:(a,b)=>spanMs(b,7)-spanMs(a,7),month:(a,b)=>monthMs(b)-monthMs(a),all:(a,b)=>(statsOf(b).activeMs||0)-(statsOf(a).activeMs||0),name:(a,b)=>a.name.localeCompare(b.name),last:(a,b)=>(statsOf(b).lastLogin||0)-(statsOf(a).lastLogin||0)};
  us.sort(sorters[usageSort]||sorters.today);
  return '<div class="grid g4">'+stat('People registered',us.length,us.filter(u=>u.active).length+' active','var(--indigo)')+stat('Seen in last 15 min',onlineNow,onlineNow?'Working right now':'Nobody signed in just now','var(--seal)')+
    stat('PINs set today',pinsSet+' / '+us.filter(u=>u.active).length,'Only these people can approve','var(--hold)')+stat('Decisions and tasks',totalWork,'Recorded across every request','var(--cyan)')+'</div>'+
    (storageInfo?'<div class="grid g3" style="margin-top:14px">'+stat('Storage used',kb(storageInfo.bytes),storageInfo.files+' files, '+storageInfo.images+' of them photos',storageInfo.bytes>800*1048576?'var(--stop)':'var(--seal)')+
      stat('Free allowance',kb(1073741824),Math.round(storageInfo.bytes/1073741824*100)+'% used — Pro plan raises it to 100 GB','var(--indigo)')+
      stat('Average per file',storageInfo.files?kb(storageInfo.bytes/storageInfo.files):'—','Photos are shrunk to ~1600px before upload','var(--cyan)')+'</div>':'')+
    '<div class="grid g3" style="margin-top:14px">'+stat('Today, whole team',hms(teamMs(u=>spanMs(u,1))),us.filter(activeToday).length+' people active today','var(--indigo)')+stat('This month, whole team',hms(teamMs(monthMs)),'Calendar month to date','var(--indigo)')+stat('All time, whole team',hms(teamMs(u=>statsOf(u).activeMs)),'Since the first sign-in','var(--indigo)')+'</div>'+
    '<div class="tabs" style="margin-top:20px">'+[['today','Today'],['week','Last 7 days'],['month','This month'],['all','All time'],['last','Last seen'],['name','Name']].map(t=>'<button data-s="'+t[0]+'" class="'+(usageSort===t[0]?'on':'')+'">'+t[1]+'</button>').join('')+'</div>'+
    '<div class="row" style="margin:10px 0 0;gap:10px;flex-wrap:wrap"><input id="us-q" type="search" placeholder="Search a person — name, employee code, email or department" style="max-width:380px" value="'+esc(usageQ||'')+'"><span class="hint" id="us-count"></span></div>'+
    '<div class="card scroll-x"><table style="min-width:980px"><thead><tr><th>Person</th><th>Employee code</th><th>Department</th><th>Last signed in</th><th>Today</th><th>7 days</th><th>This month</th><th>All time</th><th>Sign-ins</th><th>Raised</th><th>Decisions</th><th>Tasks</th></tr></thead><tbody>'+
    us.map(u=>{const st=statsOf(u),w=workOf(u);return '<tr data-q="'+esc((u.name+' '+(u.empId||'')+' '+(u.email||'')+' '+(u.dept||'')).toLowerCase())+'"><td><div class="row" style="gap:10px"><div class="av sm">'+inits(u.name)+'</div><div><b>'+esc(u.name)+'</b>'+(activeToday(u)?' <span class="tag t-ok">active today</span>':'')+'<div class="hint">'+esc(u.email)+'</div></div></div></td><td class="hint">'+esc(u.empId||'—')+'</td><td class="hint">'+esc(u.dept||'')+'</td><td class="hint">'+(st.lastLogin?esc(fmtDT(st.lastLogin)):'Never signed in')+'</td>'+
      '<td class="num">'+hms(spanMs(u,1))+'</td><td class="num">'+hms(spanMs(u,7))+'</td><td class="num">'+hms(monthMs(u))+'</td><td class="num">'+hms(st.activeMs)+'</td><td class="num">'+(st.logins||0)+'</td><td class="num">'+w.raised+'</td><td class="num">'+w.acted+'</td><td class="num">'+w.tasks+'</td></tr>'}).join('')+'</tbody></table></div>'+
    '<div class="row" style="margin-top:16px;gap:10px;flex-wrap:wrap"><button class="btn primary" id="ux-dl">Download usage</button><span class="hint">Time counts only while the tab is open and in front, so it reflects attention rather than a window left running. Recorded on the server, so phone and laptop add up to one figure per person.</span></div>';
}
function wireUsage(v){
  $$('.tabs button',v).forEach(b=>b.onclick=()=>{usageSort=b.dataset.s;render()});
  // live person search — filter rows in place so the box keeps focus as you type
  const q=$('#us-q',v);
  const applyQ=()=>{ const s=(usageQ||'').trim().toLowerCase(); let n=0, total=0;
    $$('tbody tr',v).forEach(tr=>{ total++; const hit=!s||(tr.dataset.q||'').includes(s); tr.style.display=hit?'':'none'; if(hit)n++; });
    const c=$('#us-count',v); if(c) c.textContent=s?(n+' of '+total+' '+(n===1?'person':'people')):''; };
  if(q){ q.oninput=()=>{ usageQ=q.value; applyQ(); }; }
  applyQ();
  $('#ux-dl',v).onclick=()=>{const A=[['Person','Email','Department','Designation','Last signed in','Sign-ins','Today','Last 7 days','This month','All time','Requests raised','Decisions made','Tasks closed','Account active','PIN set today']];
    DB.users.forEach(u=>{const st=statsOf(u),w=workOf(u);A.push([u.name,u.email,u.dept||'',u.role||'',st.lastLogin?fmtDT(st.lastLogin):'Never',st.logins||0,hms(spanMs(u,1)),hms(spanMs(u,7)),hms(monthMs(u)),hms(st.activeMs),w.raised,w.acted,w.tasks,u.active?'Yes':'No',pinOK(u)?'Yes':'No'])});
    const B=[['Date'].concat(DB.users.map(u=>u.name))]; const days={}; DB.users.forEach(u=>Object.keys(statsOf(u).daily).forEach(d=>days[d]=1));
    Object.keys(days).sort().reverse().forEach(d=>B.push([d].concat(DB.users.map(u=>hms(statsOf(u).daily[d]||0)))));
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(A),'Usage summary'); XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(B),'Day by day');
    XLSX.writeFile(wb,'setu-usage-'+new Date().toISOString().slice(0,10)+'.xlsx'); toast('Usage downloaded.','ok')};
}

/* ============================================================
   People & masters
   ============================================================ */
function profileDialog(){
  modal({title:'Complete your directory entry',body:'<p style="margin-top:0">Department decides where a request hands over from one team to the next, so it has to come from the official list.</p>'+
      '<div class="grid g2" style="gap:13px;margin-top:16px"><div><label for="q-r">Designation</label><input id="q-r" type="text" list="dl-role" value="'+esc(ME.role||'')+'"></div><div><label for="q-d">Department</label><select id="q-d">'+deptOptions(ME.dept)+'</select></div></div>'+lists()+
      '<div style="margin-top:13px"><label for="q-m">Reports to</label><select id="q-m">'+mgrOptions(ME.managerId,ME.id)+'</select><div class="hint">Your manager confirms this before they can assign you work.</div></div><div id="q-e" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
    footer:'<button class="btn" data-x>Later</button><button class="btn primary" id="q-g">Save and continue</button>',
    onOpen:(v,c)=>{$('#q-g',v).onclick=async()=>{const r=$('#q-r',v).value.trim(),d=$('#q-d',v).value,m=$('#q-m',v).value||null;
      if(r.length<2) return $('#q-e',v).textContent='Enter your designation.'; if(!d&&!ME.admin) return $('#q-e',v).textContent='Choose your department.';
      try{ await rpc('update_my_profile',{p_role:r,p_dept:d,p_manager:m}); await load(); c(); $('#me-role').textContent=ME.role; render(); paintNav(); toast('Directory entry updated.','ok'); if(!pinOK(ME))setTimeout(pinDialog,350) }
      catch(e){ $('#q-e',v).textContent=(e.message||'').replace(/^.*?: /,'') }}}});
}
let peopleQ='';
// Admin: map a flow/blueprint name to the right person, system-wide (migration 77).
async function renderNameMap(c){
  if(!(ME.admin||ME.owner)){ c.innerHTML=''; return; }
  let maps=[], stuck=[];
  try{
    const m=await SB.from('flow_actor_map').select('*').order('set_at',{ascending:false});
    if(m.error) throw m.error; maps=m.data||[];
    stuck=(await rpc('flow_unmapped_names',{}))||[];
  }catch(e){ c.innerHTML='<p class="hint" style="color:var(--stop)">Could not load corrections: '+esc((e&&e.message)||'')+'</p>'; return; }
  const opts='<option value="">— choose the real person —</option>'+DB.users.filter(u=>u.active).slice().sort((a,b)=>a.name.localeCompare(b.name))
    .map(u=>'<option value="'+u.id+'">'+esc(u.name)+(u.empId?' ('+esc(u.empId)+')':'')+(u.dept?' — '+esc(u.dept):'')+'</option>').join('');
  const stuckHtml=stuck.length
    ? '<div class="hint" style="margin-bottom:10px">Names in live flows with <b>no approver</b> — tap one to fill it in below: '+stuck.map(x=>'<button class="btn ghost sm nm-stuck" data-nm="'+esc(x.nm)+'" style="margin:3px 2px">'+esc(x.nm)+' · '+x.stuck_flows+' file'+(x.stuck_flows===1?'':'s')+'</button>').join(' ')+'</div>'
    : '<div class="hint" style="margin-bottom:10px;color:var(--seal)">✓ No live flow is stuck on an unmatched name.</div>';
  const rows=maps.length
    ? '<table class="cards"><thead><tr><th>Flow name</th><th>Maps to</th><th>Note</th><th></th></tr></thead><tbody>'+maps.map(m=>{const u=user(m.user_id);
        return '<tr><td><b>'+esc(m.src_name)+'</b></td><td>'+esc(u&&u.id?u.name:'(account removed)')+'</td><td class="hint meta">'+esc(m.note||'')+'</td><td style="text-align:right"><button class="btn sm nm-del" data-src="'+esc(m.src_name)+'" style="color:var(--stop)">Remove</button></td></tr>'}).join('')+'</tbody></table>'
    : '<p class="hint">No corrections set yet.</p>';
  c.innerHTML=stuckHtml+
    '<div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end;margin:4px 0 12px">'+
      '<div style="flex:1;min-width:180px"><label for="nm-src">Name as it appears in the flow</label><input id="nm-src" type="text" placeholder="e.g. Pawnit Batra" autocomplete="off"></div>'+
      '<div style="flex:1;min-width:210px"><label for="nm-u">Real person</label><select id="nm-u">'+opts+'</select></div>'+
      '<button class="btn primary" id="nm-go">Apply to all flows</button></div>'+
    '<div id="nm-err" class="hint" style="color:var(--stop);margin-bottom:12px"></div>'+rows;
  $$('.nm-stuck',c).forEach(b=>b.onclick=()=>{ $('#nm-src',c).value=b.dataset.nm; const sel=$('#nm-u',c); sel.focus(); $('#nm-err',c).textContent=''; });
  $('#nm-go',c).onclick=async()=>{ const src=($('#nm-src',c).value||'').trim(), uid=$('#nm-u',c).value;
    if(!src) return $('#nm-err',c).textContent='Enter the name as it appears in the flow.';
    if(!uid) return $('#nm-err',c).textContent='Choose the real person.';
    $('#nm-go',c).disabled=true; $('#nm-err',c).textContent='';
    try{ const n=await rpc('admin_map_actor',{p_src:src,p_user:uid}); await load(['flows','notif']);
      toast('Saved for the whole system. '+(n?('Corrected '+n+' live step'+(n===1?'':'s')+' — open the file to see the new approver.'):'No file currently needed fixing.'),'ok');
      renderNameMap(c); }
    catch(e){ $('#nm-go',c).disabled=false; $('#nm-err',c).textContent=(e&&e.message)||'Could not save.'; } };
  $$('.nm-del',c).forEach(b=>b.onclick=()=>modal({title:'Remove this correction?',
    body:'<p style="margin-top:0">New flows will go back to matching “<b>'+esc(b.dataset.src)+'</b>” by name. Files already corrected keep the approver they have now.</p>',
    footer:'<button class="btn" data-x>Keep it</button><button class="btn primary" id="nmd-go">Remove</button>',
    onOpen:(mv,cl)=>{ $('#nmd-go',mv).onclick=async()=>{ try{ await rpc('admin_unmap_actor',{p_src:b.dataset.src}); cl(); toast('Correction removed.','ok'); renderNameMap(c); }catch(e){ fail(e); } }; }}));
}
function viewPeople(){
  const typed={}; DB.requests.forEach(r=>{const n=r.f.siteName; if(n&&!byName.has(String(n).toLowerCase())) typed[n]=1}); const unlisted=Object.keys(typed);
  const stuck=DB.requests.filter(r=>r.status==='In Progress'&&r.chain[r.current]);
  const pq=peopleQ.trim().toLowerCase();
  const ulist=DB.users.filter(u=>!pq||((u.name+' '+(u.email||'')+' '+(u.empId||'')+' '+(u.role||'')+' '+(u.dept||'')).toLowerCase().includes(pq)));
  return '<div class="card pad" style="margin-bottom:16px"><div class="row" style="flex-wrap:wrap"><div><h3>'+DB.users.filter(u=>u.active).length+' people can be added to a chain</h3><p class="hint" style="margin-top:4px">Anyone registered shows up when a requester searches for approvers. Create accounts here, or let people register themselves from the sign-in screen and set their access afterwards.</p></div>'+
    '<div class="row hdr-actions" style="margin-left:auto;gap:8px">'+(CAN_CREATE()?'<button class="btn primary" id="p-new">Create an account</button>':'')+((ME.admin||ME.owner)?'<button class="btn" id="p-xls">Download emails (Excel)</button>':'')+(CAN_MANAGE()?'<button class="btn" id="p-resync" title="Re-resolve approvers on live flows after renaming an account">Re-sync flow approvers</button>':'')+((ME.owner||ME.admin)?'<button class="btn" id="p-unstick" title="Re-activate the live step on any flow that is In Progress but shows no open step">Repair stuck flows</button>':'')+'<button class="btn" id="p-pw">Change password</button><button class="btn" id="p-me">My directory entry</button></div></div></div>'+
   '<div class="card"><div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line);gap:10px;flex-wrap:wrap"><input id="p-search" type="text" placeholder="Search name, email, designation or department" value="'+esc(peopleQ)+'" style="flex:1;min-width:220px">'+(pq?'<span class="tag t-prog" style="align-self:center">'+ulist.length+' of '+DB.users.length+'</span><button class="btn ghost sm" id="p-search-clear">Clear</button>':'')+'</div>'+
   '<table class="cards people"><thead><tr><th>Name</th><th>Employee ID</th><th>Designation</th><th>Department</th><th>Reports to</th><th>Access</th><th>PIN</th><th></th></tr></thead><tbody>'+
   ulist.map(u=>{const mgr=u.managerId?user(u.managerId):null, badges=(u.owner?'<span class="tag" style="background:#1A1338;color:#fff;border-color:#1A1338">Super admin</span> ':'')+(u.admin&&!u.owner?'<span class="tag t-prog">Admin</span> ':'')+(!u.admin&&!u.owner&&(u.canCreateUsers||u.canManageUsers)?'<span class="tag t-prog">Sub-admin</span> ':'')+((u.unit&&u.unit!=='ALDS')?'<span class="tag t-hold">'+esc(u.unit)+'</span> ':'')+(u.manager?'<span class="tag t-ok">Manager</span> ':'')+(u.seeAll&&!u.admin?'<span class="tag t-wait">Sees all</span>':'');
     return '<tr'+(u.active?'':' style="opacity:.55"')+'><td><div class="row" style="gap:10px"><div class="av sm">'+inits(u.name)+'</div><div><b>'+esc(u.name)+'</b>'+(u.id===ME.id?' <span class="hint">(you)</span>':'')+(u.active?'':' <span class="tag t-bad">off</span>')+'<div class="hint">'+esc(u.email)+'</div></div></div></td><td class="meta num">'+esc(u.empId||'—')+'</td><td class="meta">'+esc(u.role||'')+'</td>'+
     '<td class="hint meta">'+esc(u.dept||(u.admin?'no department':''))+'</td><td class="hint meta">'+(mgr?'reports to '+esc(mgr.name)+(u.managerConfirmed?'':' <span class="tag t-hold">unconfirmed</span>'):'')+'</td><td class="meta">'+(badges||'')+'</td><td class="meta">'+(pinOK(u)?'<span class="tag t-ok">PIN set</span>':'<span class="tag t-wait">No PIN today</span>')+'</td>'+
     '<td class="acts" style="text-align:right;white-space:nowrap">'+(canEditUser(u)?'<button class="btn sm" data-ed="'+u.id+'">Edit</button>':(u.owner?'<span class="hint">only the owner</span>':''))+
     (ME.owner&&!u.owner?' <button class="btn sm" data-rmu="'+u.id+'" style="color:var(--stop)">Remove</button>':'')+'</td></tr>'}).join('')+
   (ulist.length?'':'<tr><td colspan="8"><div class="empty" style="padding:22px 8px"><h3>No one matches</h3><p class="hint">No person matches “'+esc(peopleQ)+'”.</p></div></td></tr>')+'</tbody></table></div>'+
   (ME.admin?'<div class="card pad" style="margin-top:16px"><h3>Departments</h3><p class="hint" style="margin-top:5px">A request shows a handover whenever it crosses from one of these to another, so keep the list tight.</p><div class="row" style="flex-wrap:wrap;gap:7px;margin-top:12px">'+
     DB.departments.map(d=>'<span class="tag t-wait">'+esc(d)+' <button class="btn ghost sm" data-dd="'+esc(d)+'" style="padding:0 4px" title="Remove">×</button></span>').join('')+'</div><div class="row" style="gap:8px;margin-top:14px"><input id="dp-new" type="text" placeholder="Add a department" style="max-width:280px"><button class="btn sm" id="dp-add">Add</button></div></div>':'')+
   (ME.admin?'<div class="card pad" style="margin-top:16px"><h3>Requests stuck on an absent approver</h3><p class="hint" style="margin-top:5px">Only an admin can move a request off someone who is unavailable. The original assignment stays in the trail.</p>'+
     (stuck.length?'<div style="margin-top:12px">'+stuck.map(r=>'<div class="filerow"><div style="min-width:0;flex:1"><b>'+esc(docTitle(r))+'</b><div class="hint">'+esc(r.ref)+' · with '+esc(user(r.chain[r.current].userId).name)+' for '+daysBetween(r.chain[r.current].actedAt||r.createdAt,Date.now())+' days</div></div><button class="btn sm" data-re="'+r.id+'">Reassign</button></div>').join('')+'</div>':'<p class="hint" style="margin-top:10px">Nothing is currently in progress.</p>')+'</div>':'')+
   ((ME.admin||ME.owner)?'<div class="card pad" style="margin-top:16px"><h3>Approver name corrections</h3>'+
     '<p class="hint" style="margin-top:5px">When a name used in the fixed PO / WO / CNG flows does not match a real account, that step gets <b>no approver</b> and the file stops. Map the flow name to the right person here — it applies to <b>every</b> flow, the ones running now and all new ones, until you change it again. (Different from “Change approver” on a single flow, which only fixes that one file.)</p>'+
     '<div id="p-namemap" style="margin-top:12px"><p class="hint">Loading…</p></div></div>':'')+
   (ME.admin?'<div class="card pad" style="margin-top:16px"><h3>Bulk set “Reports to”</h3><p class="hint" style="margin-top:5px">Upload a sheet with two columns — the <b>person</b> and their <b>manager</b> — each by employee code or name. Headers like “Employee”/“Name” and “Manager”/“Reports to” are detected automatically. This is what makes hierarchy-ordered tagging and teams work.</p><div id="p-mgrupload" style="margin-top:12px"></div><div id="p-mgrres" style="margin-top:10px"></div></div>':'')+
   (ME.admin?'<div class="card pad" style="margin-top:16px"><h3>Data departments (ALDS / CNG…)</h3><p class="hint" style="margin-top:5px">These decide what data each person sees. A person only sees their own department’s indents and PO/WO flows (gate pass stays open to everyone). Set a person’s department in their <b>Edit</b>, or in bulk below. ALDS is the default.</p><div class="row" style="flex-wrap:wrap;gap:7px;margin-top:12px">'+WALL_DEPTS().map(d=>'<span class="tag '+(d==='ALDS'?'t-wait':'t-hold')+'">'+esc(d)+'</span>').join('')+'</div><div class="row" style="gap:8px;margin-top:14px"><input id="un-new" type="text" placeholder="New department name" style="max-width:280px"><button class="btn sm" id="un-add">Create department</button></div></div>':'')+
   (ME.admin?'<div class="card pad" style="margin-top:16px"><h3>Bulk set department</h3><p class="hint" style="margin-top:5px">Move many people into a department at once. Paste their <b>emails</b> or <b>employee IDs</b> (or names), one per line — email or ID is safest when names repeat. Pick the department and apply.</p><div class="row" style="gap:8px;margin-top:12px;align-items:center;flex-wrap:wrap"><label style="margin:0;font-weight:600">Department</label><select id="bd-dept" style="max-width:220px">'+WALL_DEPTS().map(d=>'<option '+(d==='CNG'?'selected':'')+'>'+esc(d)+'</option>').join('')+'</select><button class="btn primary sm" id="bd-go">Set department</button></div><textarea id="bd-list" rows="5" placeholder="one email / employee ID / name per line" style="margin-top:10px;width:100%"></textarea><div id="bd-res" style="margin-top:8px"></div></div>':'')+
   '<div class="grid g2" style="margin-top:16px;align-items:start"><div class="card pad"><h3>Station master</h3><p class="hint" style="margin-top:5px">'+STATIONS.length+' stations loaded.'+(ME.admin?' Upload a replacement to refresh the list — the columns must stay ERP Code, Station Name, State.':'')+'</p>'+(ME.admin?'<div id="p-mast" style="margin-top:12px"></div>':'')+'</div>'+
   '<div class="card pad"><h3>Typed, not in the master</h3>'+(unlisted.length?'<p class="hint" style="margin-top:5px">Typed by requesters and not found in the station master. Worth adding.</p><ul style="margin:10px 0 0;padding-left:18px">'+unlisted.map(n=>'<li>'+esc(n)+'</li>').join('')+'</ul>':'<p class="hint" style="margin-top:5px">Nothing so far — every site used has matched the master.</p>')+
     '<div class="sep"></div><h3>Project names</h3><p class="hint" style="margin-top:5px">'+DB.projects.map(esc).join(', ')+'</p></div></div>'+
   (ME.owner?'<div class="card pad" style="margin-top:16px;border-color:var(--stop)"><h3>Owner controls — testing and the go-live reset</h3>'+
     '<p class="hint" style="margin-top:5px">Only the system owner sees this. Deleting is the one exception to the permanent record and every use is logged where nobody, including you, can remove it. Use it to clear test data; once real requests exist, leave it alone.</p>'+
     '<div class="row" style="gap:9px;margin-top:12px;flex-wrap:wrap"><button class="btn bad sm" id="p-purge-all">Reset data — choose what to delete</button>'+
     '<span class="hint">Single requests are deleted from the request itself. Test accounts have a Remove button in the table above.</span></div></div>':'')+
   '<div class="card pad" style="margin-top:16px"><h3>The record is permanent</h3><p class="hint" style="margin-top:5px">Requests, approvals, conditions and the audit trail cannot be deleted or edited once recorded'+(ME.owner?', except by the system owner through the controls above, and those deletions are themselves recorded permanently':' — the database has no way to do it')+'. Corrections are added as new entries so the original stays visible.</p></div>';
}
/* Owner/admin: download the whole directory (names + emails + access) as Excel */
function accessLabel(u){
  const t=[]; if(u.owner)t.push('Owner'); if(u.admin)t.push('Admin');
  if(!u.admin&&!u.owner&&(u.canCreateUsers||u.canManageUsers)){const pr=[]; if(u.canCreateUsers)pr.push('create'); if(u.canManageUsers)pr.push('manage'); t.push('Sub-admin ('+pr.join('/')+')');}
  if(u.manager)t.push('Manager');
  if(u.seeAll)t.push('Sees all'); if(u.gateman)t.push('Gateman'); if(u.hrHead)t.push('HR Head'); if(u.gateOnly)t.push('Gate only');
  if(u.assistsId){const pr=DB.users.find(x=>x.id===u.assistsId); t.push('Assistant to '+(pr?pr.name:'—'));}
  return t.join(', ')||'User';
}
function exportUsersXlsx(){
  if(!(ME.admin||ME.owner)) return;
  const rows=DB.users.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(u=>({
    Name:u.name, 'Employee ID':u.empId||'', Email:u.email||'', Designation:u.role||'', Department:u.dept||'',
    'Reports to':u.managerId?(user(u.managerId).name||''):'', Access:accessLabel(u),
    Status:u.active?'Active':'Inactive', 'PIN today':pinOK(u)?'Set':'Not set'
  }));
  if(!window.XLSX){ toast('Spreadsheet engine still loading — try again in a moment.','bad'); return; }
  const ws=XLSX.utils.json_to_sheet(rows);
  ws['!cols']=[{wch:24},{wch:34},{wch:18},{wch:16},{wch:20},{wch:26},{wch:10},{wch:10}];
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'Users');
  XLSX.writeFile(wb,'setu-users-'+new Date().toISOString().slice(0,10)+'.xlsx');
  toast(rows.length+' users downloaded.','ok');
}
function wirePeople(v){
  $('#p-me',v).onclick=profileDialog;
  if($('#p-search',v)) $('#p-search',v).oninput=()=>{peopleQ=$('#p-search',v).value; const p=$('#p-search',v).selectionStart; render();
    const n=$('#p-search'); if(n){n.focus();n.setSelectionRange(p,p)}};
  if($('#p-search-clear',v)) $('#p-search-clear',v).onclick=()=>{peopleQ='';render()};
  if($('#p-new',v)) $('#p-new',v).onclick=createUserDialog;
  if($('#p-xls',v)) $('#p-xls',v).onclick=exportUsersXlsx;
  if($('#p-resync',v)) $('#p-resync',v).onclick=()=>modal({title:'Re-sync flow approvers',
    body:'<p style="margin-top:0">This re-checks every <b>live ALDS and CNG flow</b> and fills in any approval step that currently has no approver, matching the fixed hierarchy against the current directory.</p>'+
      '<p class="hint">Use it after renaming an account to match the hierarchy (e.g. “prachikhara” → “Prachi Khara”). It only adds missing approvers — it never changes steps already resolved.</p>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="rs-go">Re-sync now</button>',
    onOpen:(mv,cl)=>{$('#rs-go',mv).onclick=async()=>{$('#rs-go',mv).disabled=true;
      try{ const n=await rpc('flow_resync_actors',{}); cl(); await load(); toast(n?('Added approvers to '+n+' step'+(n===1?'':'s')+'. Refresh the flow to see them.'):'Nothing to fix — every live flow already has its approvers.','ok'); render(); }
      catch(e){ $('#rs-go',mv).disabled=false; fail(e); } }; }});
  if($('#p-unstick',v)) $('#p-unstick',v).onclick=()=>modal({title:'Repair stuck flows',
    body:'<p style="margin-top:0">Occasionally an older flow is left <b>In Progress</b> with no open step — the file shows “Nothing to do / no open step” for everyone and cannot move. This re-activates the correct live step on every such flow at once (and fills its approver). It does nothing to flows that are working normally.</p>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="us-go">Repair now</button>',
    onOpen:(mv,cl)=>{$('#us-go',mv).onclick=async()=>{$('#us-go',mv).disabled=true;
      try{ const rows=await rpc('flow_unstick',{}); cl(); await load(); const n=(rows||[]).length;
        toast(n?('Repaired '+n+' flow'+(n===1?'':'s')+'. Open them to see the live step.'):'Nothing to repair — every flow already has its live step.','ok'); render(); }
      catch(e){ $('#us-go',mv).disabled=false; fail(e); } }; }});
  if($('#p-namemap',v)) renderNameMap($('#p-namemap',v));
  if($('#p-purge-all',v)) $('#p-purge-all',v).onclick=purgeAllDialog;
  $$('[data-rmu]',v).forEach(b=>b.onclick=()=>purgeUserDialog(user(b.dataset.rmu)));
  $('#p-pw',v).onclick=()=>newPasswordDialog({title:'Change your password',cancellable:true});
  $$('[data-ed]',v).forEach(b=>b.onclick=()=>{const u=user(b.dataset.ed);
    modal({title:'Edit '+u.name,body:'<div class="grid" style="gap:13px">'+
        '<div><label for="e-name">Full name</label><input id="e-name" type="text" value="'+esc(u.name||'')+'"'+((u.owner&&u.id!==ME.id)?' disabled':'')+'>'+((u.owner&&u.id!==ME.id)?'<div class="hint">Only the system owner can rename their own account.</div>':'<div class="hint">Used across the app and to match ALDS flow approvers — spelling matters.</div>')+'</div>'+
        '<div><label for="e-emp">Employee code</label><input id="e-emp" type="text" value="'+esc(u.empId||'')+'" autocomplete="off" placeholder="e.g. CPIL1234"><div class="hint">Used to sign in (Employee ID or email) and shown on the People and Usage pages. Leave blank if none.</div></div>'+
        '<div class="grid g2"><div><label for="e-role">Designation</label><input id="e-role" type="text" value="'+esc(u.role||'')+'" list="dl-role"></div><div><label for="e-dept">Department</label><select id="e-dept">'+deptOptions(u.dept)+'</select></div></div>'+
        '<div><label for="e-mgr">Reports to</label><select id="e-mgr">'+mgrOptions(u.managerId,u.id)+'</select></div>'+
        '<div><label>Department <span class="hint" style="font-weight:400">which department’s data they work in — click to switch</span></label><div class="row" id="e-unitseg" style="flex-wrap:wrap;gap:6px;margin-top:4px">'+WALL_DEPTS().map(d=>'<button type="button" class="btn sm e-unitbtn'+(((u.unit||'ALDS')===d)?' primary':'')+'" data-unit="'+esc(d)+'">'+esc(d)+(d==='ALDS'?' (default)':'')+'</button>').join('')+'</div><div class="hint" id="e-unitnote">Switches straight away when you click — no need to Save.</div></div>'+
        (GRANTS_ROLES()?'<div><label>Also sees these departments <span class="hint" style="font-weight:400">cross-department access</span></label><div class="row" style="gap:12px;flex-wrap:wrap;margin-top:4px">'+WALL_DEPTS().filter(d=>d!=='ALDS').map(d=>'<label style="display:flex;align-items:center;gap:6px;margin:0;font-weight:400"><input type="checkbox" class="e-dv" value="'+esc(d)+'" style="width:auto" '+((u.deptsVisible||[]).indexOf(d)>-1?'checked':'')+'> '+esc(d)+'</label>').join('')+'</div><div class="hint">Tick the other departments this person may see as well — e.g. the ultimate purchaser. Their own department is always visible; gate pass is open to everyone.</div></div>':'')+
        '<div class="sep" style="margin:2px 0"></div>'+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-man" style="width:auto" '+(u.manager?'checked':'')+'> <span><b>Manager</b><div class="hint">Can assign work to their team inside a request.</div></span></label>'+
        (GRANTS_ROLES()?'<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-see" style="width:auto" '+(u.seeAll?'checked':'')+'> <span><b>Can see every request</b><div class="hint">For audit or finance oversight, without full admin rights.</div></span></label>':'')+
        (GRANTS_ROLES()?'<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-garuda" style="width:auto" '+(u.garudaAccess?'checked':'')+'> <span><b>Garuda (CNG stock) access</b><div class="hint">Opens the Garuda page for this person. CNG people get it anyway; use this to give an ALDS person access.</div></span></label>'+
          '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-gstore" style="width:auto" '+(u.garudaStore?'checked':'')+'> <span><b>Garuda — Store role</b><div class="hint">Issues QRs out to a station, and accepts returns at the store.</div></span></label>'+
          '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-gsite" style="width:auto" '+(u.garudaSite?'checked':'')+'> <span><b>Garuda — Site role</b><div class="hint">At the station: allots (fits) a QR and marks it consumed.</div></span></label>':'')+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-gate" style="width:auto" '+(u.gateman?'checked':'')+'> <span><b>Gateman</b><div class="hint">Clears people out at the gate: sees the approval selfies and closes each gate pass.</div></span></label>'+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-gateonly" style="width:auto" '+(u.gateOnly?'checked':'')+'> <span><b>Gate Pass only</b><div class="hint">This account signs in to the Gate Pass page and nothing else — no dashboard, requests or records.</div></span></label>'+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-hrhead" style="width:auto" '+(u.hrHead?'checked':'')+'> <span><b>HR Head (Gate Pass reports)</b><div class="hint">Sees every gate pass (view only) and the Gate Pass Reports page. Restricted to those two pages.</div></span></label>'+
        '<div><label for="e-assist">Assistant to (proxy) <span class="hint" style="font-weight:400">optional</span></label><select id="e-assist"><option value="">— nobody —</option>'+DB.users.filter(x=>x.active&&x.id!==u.id&&!x.owner).slice().sort((a,b)=>a.name.localeCompare(b.name)).map(x=>'<option value="'+x.id+'" '+(u.assistsId===x.id?'selected':'')+'>'+esc(x.name)+'</option>').join('')+'</select><div class="hint">Makes this a proxy for that person: a read-only view of their pending and approved items, no approval buttons, plus an “ERP entry done” button. Restricted to the Assisting page.</div></div>'+
        ((GRANTS_ROLES()&&!u.owner&&!u.admin)?'<div class="sep" style="margin:2px 0"></div><div class="hint" style="font-weight:600;color:var(--ink-soft)">Sub-admin — user-desk powers without full Admin</div>'+
          '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-cc" style="width:auto" '+(u.canCreateUsers?'checked':'')+'> <span><b>Can create users</b><div class="hint">Add new accounts. They make ordinary users only, never Admins.</div></span></label>'+
          '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-cm" style="width:auto" '+(u.canManageUsers?'checked':'')+'> <span><b>Can manage users</b><div class="hint">Edit existing people (not Admins or the owner) and reset their passwords. No access to requests, reports or masters.</div></span></label>':'')+
        (GRANTS_ROLES()?'<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-adm" style="width:auto" '+(u.admin?'checked':'')+' '+(u.id===ME.id||u.owner||!ME.owner?'disabled':'')+'> <span><b>Administrator</b><div class="hint">'+(u.owner?'The system owner is always an administrator. This cannot be changed by anyone.':(ME.owner?'A system role, separate from the flow: creates accounts, sets access, manages masters, sees every request.':'Only the system owner can grant or remove this.'))+'</div></span></label>':'')+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-act" style="width:auto" '+(u.active?'checked':'')+' '+(u.id===ME.id||u.owner?'disabled':'')+'> <span><b>Account active</b><div class="hint">'+(u.owner?'The system owner account cannot be switched off.':'Switched-off people cannot sign in or be added to chains.')+'</div></span></label>'+
        (u.admin||u.owner?'<div class="sep" style="margin:2px 0"></div><div class="hint">This account is an administrator, so it sees every page.</div>':'<div class="sep" style="margin:2px 0"></div>'+pagesChecklist('e-pages',allowedPages(u)))+'</div>'+lists()+'<div id="e-err" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
      footer:'<button class="btn bad" id="e-reset" style="margin-right:auto">Reset password</button><button class="btn" data-x>Cancel</button><button class="btn primary" id="eg">Save</button>',
      onOpen:(mv,cl)=>{
        $('#e-reset',mv).onclick=()=>{ cl(); resetPasswordDialog(u) };
        // Department quick-switch — persists on click, no Save needed
        $$('.e-unitbtn',mv).forEach(b=>b.onclick=async()=>{
          const nd=b.dataset.unit; if((u.unit||'ALDS')===nd) return;
          try{ await rpc('set_user_unit',{p_user:u.id,p_unit:(nd==='ALDS'?null:nd)});
            u.unit=(nd==='ALDS'?'':nd); const uu=DB.users.find(x=>x.id===u.id); if(uu) uu.unit=u.unit;
            $$('.e-unitbtn',mv).forEach(x=>x.classList.toggle('primary',(u.unit||'ALDS')===x.dataset.unit));
            const note=$('#e-unitnote',mv); if(note) note.textContent='Switched to '+nd+'.';
            reloadSoon(['people']);
          }catch(e){ fail(e); }
        });
        wirePagesChecklist('e-pages',mv);
        $('#eg',mv).onclick=async()=>{const d=$('#e-dept',mv).value;
        const admEl=$('#e-adm',mv), adm=u.id===ME.id?true:(admEl?admEl.checked:!!u.admin);
        const seeEl=$('#e-see',mv), see=seeEl?seeEl.checked:!!u.seeAll;
        if(!d&&!adm) return $('#e-err',mv).textContent='Choose a department, or make them an administrator.';
        const nameEl=$('#e-name',mv), newName=nameEl?nameEl.value.trim():u.name;
        if(nameEl&&!nameEl.disabled&&newName.length<2) return $('#e-err',mv).textContent='Enter a name of at least 2 characters.';
        const empEl=$('#e-emp',mv), empNew=empEl?empEl.value.trim():(u.empId||'');
        try{ if(nameEl&&!nameEl.disabled&&newName&&newName!==u.name) await rpc('admin_rename_user',{p_user:u.id,p_name:newName});
          if(empEl&&empNew!==(u.empId||'')) await rpc('set_emp_id',{p_user:u.id,p_emp:empNew});
          await rpc('admin_update_profile',{p_user:u.id,p_role:$('#e-role',mv).value.trim(),p_dept:d||null,p_manager:$('#e-mgr',mv).value||null,p_is_manager:$('#e-man',mv).checked,p_see_all:see,p_is_admin:adm,p_active:u.id===ME.id?true:$('#e-act',mv).checked});
          const ccEl=$('#e-cc',mv), cmEl=$('#e-cm',mv);
          if(ccEl&&cmEl&&(ccEl.checked!==!!u.canCreateUsers||cmEl.checked!==!!u.canManageUsers)) await rpc('set_subadmin',{p_user:u.id,p_create:ccEl.checked,p_manage:cmEl.checked});
          if($('#e-gate',mv)&&$('#e-gate',mv).checked!==!!u.gateman) await rpc('set_gateman',{p_user:u.id,p_on:$('#e-gate',mv).checked});
          if($('#e-gateonly',mv)&&$('#e-gateonly',mv).checked!==!!u.gateOnly) await rpc('set_gate_only',{p_user:u.id,p_on:$('#e-gateonly',mv).checked});
          if($('#e-hrhead',mv)&&$('#e-hrhead',mv).checked!==!!u.hrHead) await rpc('set_hr_head',{p_user:u.id,p_on:$('#e-hrhead',mv).checked});
          if($('#e-assist',mv)){ const av=$('#e-assist',mv).value||null; if((av||null)!==(u.assistsId||null)) await rpc('set_assists',{p_user:u.id,p_principal:av}); }
          if(!adm&&$('#e-pages',mv)) await rpc('set_pages',{p_user:u.id,p_pages:readChecklist('e-pages',mv)});
          const unitEl=$('#e-unit',mv); if(unitEl){ const nu=unitEl.value||null; if((nu||'')!==(u.unit||'')) await rpc('set_user_unit',{p_user:u.id,p_unit:nu}); }
          if(GRANTS_ROLES()){ const dv=[]; $$('.e-dv',mv).forEach(c=>{ if(c.checked) dv.push(c.value); });
            const cur=(u.deptsVisible||[]).slice().sort(); if(JSON.stringify(dv.slice().sort())!==JSON.stringify(cur)) await rpc('set_depts_visible',{p_user:u.id,p_depts:dv}); }
          if($('#e-garuda',mv)&&$('#e-garuda',mv).checked!==!!u.garudaAccess) await rpc('set_garuda_access',{p_user:u.id,p_on:$('#e-garuda',mv).checked});
          if($('#e-gstore',mv)&&($('#e-gstore',mv).checked!==!!u.garudaStore||$('#e-gsite',mv).checked!==!!u.garudaSite)) await rpc('set_garuda_role',{p_user:u.id,p_store:$('#e-gstore',mv).checked,p_site:$('#e-gsite',mv).checked});
          await load(); cl(); render(); toast(u.name+' updated.','ok') }catch(e){ $('#e-err',mv).textContent=(e.message||'').replace(/^.*?: /,'') }}}})});
  if($('#dp-add',v)) $('#dp-add',v).onclick=async()=>{const n=$('#dp-new',v).value.trim(); if(n.length<2) return toast('Type a department name.','bad');
    const {error}=await SB.from('departments').insert({name:n}); if(error) return fail(error); await load(); render(); toast('Added.','ok')};
  $$('[data-dd]',v).forEach(b=>b.onclick=async()=>{const d=b.dataset.dd, inUse=DB.users.filter(u=>u.dept===d).length; if(inUse) return toast(inUse+' '+(inUse===1?'person is':'people are')+' in '+d+'. Move them first.','bad');
    const {error}=await SB.from('departments').delete().eq('name',d); if(error) return fail(error); await load(); render(); toast('Removed.','ok')});
  $$('[data-re]',v).forEach(b=>b.onclick=()=>{const r=DB.requests.find(x=>x.id===b.dataset.re), s=r.chain[r.current], cur=user(s.userId);
    modal({title:'Reassign this step',body:'<p style="margin-top:0"><b>'+esc(docTitle(r))+'</b> is sitting with '+esc(cur.name)+'.</p><p class="hint">Reassigning moves only this step. Everything already approved stands, and the original assignment stays in the trail.</p>'+
        (openTasks(s).length?'<div class="banner hold" style="margin-top:12px"><div>'+openTasks(s).length+' task given to their team is still open. Reassigning withdraws those tasks.</div></div>':'')+
        '<div style="margin-top:14px"><label for="rs">Move it to</label><select id="rs"><option value="">Choose…</option>'+DB.users.filter(u=>u.active&&u.id!==s.userId).map(u=>'<option value="'+u.id+'">'+esc(u.name)+' — '+esc(u.role||'')+', '+esc(u.dept||'')+'</option>').join('')+'</select></div><div style="margin-top:12px"><label for="rw">Why</label><textarea id="rw" placeholder="e.g. On leave until the 20th."></textarea></div><div id="r-err" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
      footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="rg">Reassign</button>',
      onOpen:(mv,cl)=>{$('#rg',mv).onclick=async()=>{const id=$('#rs',mv).value, why=$('#rw',mv).value.trim(); if(!id) return $('#r-err',mv).textContent='Pick who it moves to.';
        try{ await rpc('reassign_step',{p_request:r.id,p_user:id,p_why:why}); await load(); cl(); render(); toast('Moved to '+user(id).name+'.','ok') }catch(e){ $('#r-err',mv).textContent=(e.message||'').replace(/^.*?: /,'') }}}})});
  if($('#un-add',v)) $('#un-add',v).onclick=async()=>{
    const nm=($('#un-new',v).value||'').trim(); if(nm.length<2) return toast('Enter a department name.','bad');
    try{ await rpc('add_unit',{p_name:nm}); await load(['people']); toast('Department “'+nm+'” created.','ok'); render(); }catch(e){ fail(e); } };
  if($('#bd-go',v)) $('#bd-go',v).onclick=async()=>{
    const dept=$('#bd-dept',v).value;
    const people=($('#bd-list',v).value||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    if(!people.length) return toast('Paste at least one person (email, ID or name).','bad');
    const res=$('#bd-res',v); res.innerHTML='<span class="hint">Applying '+people.length+'…</span>';
    try{ const {data,error}=await SB.rpc('bulk_set_unit',{p_dept:dept,p_people:people}); if(error){ res.innerHTML=''; return fail(error); }
      await load(['people']); const um=(data&&data.unmatched)||[]; res.innerHTML='';
      modal({title:'Department updated',
        body:'<p style="margin-top:0"><b>'+(data.set||0)+'</b> '+((data.set||0)===1?'person':'people')+' set to <b>'+esc(data.dept||'')+'</b>.'+(um.length?' <b>'+um.length+'</b> could not be matched:':' Everyone matched.')+'</p>'+
          (um.length?'<ul style="margin:8px 0 0;padding-left:18px;font-size:13px">'+um.slice(0,40).map(x=>'<li>'+esc(x)+'</li>').join('')+(um.length>40?'<li>…and '+(um.length-40)+' more</li>':'')+'</ul>':''),
        footer:'<button class="btn primary" data-x>Done</button>'});
      render();
    }catch(e){ res.innerHTML=''; fail(e); } };
  if($('#p-mgrupload',v)) localPicker($('#p-mgrupload',v),'Upload the Reports-to sheet (.xlsx)',async(file)=>{
    const res=$('#p-mgrres',v);
    if(['xlsx','xls'].indexOf(extOf(file.name))<0) return toast('Upload an Excel file.','bad');
    if(!window.XLSX){ return toast('Spreadsheet engine still loading — try again.','bad'); }
    try{ const wb=XLSX.read(await file.arrayBuffer(),{type:'array'}), grid=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1});
      let hi=-1; for(let i=0;i<Math.min(grid.length,10);i++){ const r=(grid[i]||[]).map(c=>String(c||'').toLowerCase()); if(r.some(c=>/manager|reports?\s*to/.test(c))){ hi=i; break; } }
      if(hi<0) return res.innerHTML='<span style="color:var(--stop);font-size:13px">Could not find a “Manager” or “Reports to” column.</span>';
      const hdr=grid[hi].map(c=>String(c||'').toLowerCase());
      const mi=hdr.findIndex(c=>/manager|reports?\s*to/.test(c));
      let pi=hdr.findIndex((c,idx)=>idx!==mi&&/employee|emp|person|staff|name/.test(c));
      if(pi<0) pi=hdr.findIndex((c,idx)=>idx!==mi&&String(c).trim()!=='');
      if(pi<0) return res.innerHTML='<span style="color:var(--stop);font-size:13px">Could not find the person column.</span>';
      const rows=[]; for(let i=hi+1;i<grid.length;i++){ const r=grid[i]; if(!r) continue; const person=String(r[pi]||'').trim(); if(!person) continue; rows.push({person, manager:String(r[mi]||'').trim()}); }
      if(!rows.length) return res.innerHTML='<span class="hint">No rows found below the header.</span>';
      res.innerHTML='<span class="hint">Applying '+rows.length+' rows…</span>';
      const {data,error}=await SB.rpc('bulk_set_managers',{p_rows:rows}); if(error){ res.innerHTML=''; return fail(error); }
      await load(); const um=(data&&data.unmatched)||[]; res.innerHTML='';
      modal({title:'Reports-to updated',
        body:'<p style="margin-top:0"><b>'+(data.set||0)+'</b> reporting line'+((data.set||0)===1?'':'s')+' set.'+(um.length?' <b>'+um.length+'</b> could not be matched:':' Every row matched.')+'</p>'+
          (um.length?'<ul style="margin:8px 0 0;padding-left:18px;font-size:13px">'+um.slice(0,40).map(x=>'<li>'+esc(x)+'</li>').join('')+(um.length>40?'<li>…and '+(um.length-40)+' more</li>':'')+'</ul>':''),
        footer:'<button class="btn primary" data-x>Done</button>'});
      render();
    }catch(e){ res.innerHTML=''; fail(e); }
  });
  if($('#p-mast',v)) localPicker($('#p-mast',v),'Upload a replacement station master (.xlsx)',async(file)=>{
    if(['xlsx','xls'].indexOf(extOf(file.name))<0) return toast('The master must be an Excel file.','bad');
    try{ const wb=XLSX.read(await file.arrayBuffer(),{type:'array'}), rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1});
      const hi=rows.findIndex(r=>r&&r.some(c=>/ERP\s*Code/i.test(String(c||'')))); if(hi<0) return toast('Could not find an "ERP Code" header row in that file.','bad');
      const hdr=rows[hi].map(c=>String(c||'').toLowerCase()), ci=hdr.findIndex(c=>c.indexOf('erp')>-1), ni=hdr.findIndex(c=>c.indexOf('station')>-1), si=hdr.findIndex(c=>c.indexOf('state')>-1);
      const out=[]; for(let i=hi+1;i<rows.length;i++){const r=rows[i]; if(!r||!r[ci]||!r[ni])continue; out.push({code:String(r[ci]).trim(),name:String(r[ni]).trim(),state:String(r[si]||'').trim()})}
      if(!out.length) return toast('No station rows found in that file.','bad');
      const {error}=await SB.from('stations').upsert(out,{onConflict:'code'}); if(error) return fail(error);
      await load(); toast(out.length+' stations loaded.','ok'); render() }catch(e){ fail(e) }
  });
}
/* ============================================================
   Garuda — CNG stock (Stage 2a: masters browser; GRN/QR/Processed next)
   ============================================================ */
let garudaTab='processed', garudaItemQ='', garudaStnQ='', garudaStockQ='', garudaStockF='all', garudaProcQ='', garudaHistTab='issued', garudaHistQ='', garudaTraceQ='', garudaTraceSel='', garudaStationSel='', garudaLoaded=false, garudaLoading=false;
const GAR_COLS=[['processed','Processed'],['issue','Issue'],['consumed','Consumed'],['items','Items'],['stations','Stations'],['qr','QR management'],['trace','Trace'],['history','History'],['admin','Admin']];
// a QR encodes a URL so a random phone camera opens the public page; the in-app
// scanner pulls the GAR-… code back out of whatever it reads (URL or bare code)
const garTagUrl=id=>APP_URL+'#g/'+encodeURIComponent(id);
const garTagCode=s=>{ s=String(s||'').trim(); const m=s.match(/GAR-[A-Z]+-\d+/i); return (m?m[0]:s).toUpperCase(); };
async function loadGaruda(force){
  if(garudaLoading) return; if(garudaLoaded&&!force) return;
  garudaLoading=true;
  try{
    const [it,st,lots,tags]=await Promise.all([
      SB.from('cng_items').select('code,name,item_type,part_life').order('code'),
      SB.from('cng_stations').select('station_no,station_name').order('station_no'),
      SB.from('cng_lots').select('id,request_id,item_code,item_name,item_type,vendor,po_no,grn_no,grn_date,invoice_no,order_qty,delivered_qty,accepted_qty,rejected_qty,rate,series_prefix,series_from,series_to').eq('minted',true).order('created_at',{ascending:false}),
      SB.from('cng_tags').select('id,lot_id,request_id,item_code,item_name,item_type,vendor,rate,po_no,grn_no,status,station_no,issued_to,issued_by,issued_by_name,issued_at,allotted_by,allotted_by_name,allotted_at,allot_photo,consumed_by,consumed_by_name,consume_remark,consumed_at,returned_by,returned_by_name,returned_at,replaced_from,replaced_at').order('id')
    ]);
    DB.garudaItems=(it.data||[]).map(r=>({code:r.code,name:r.name||'',type:r.item_type||'',partLife:r.part_life||''}));
    DB.garudaStations=(st.data||[]).map(r=>({no:r.station_no,name:r.station_name||''}));
    DB.garudaLots=(lots.data||[]);
    DB.garudaTags=(tags.data||[]);
    garudaLoaded=true;
  }catch(e){ /* leave unloaded; the view shows a retry */ }
  finally{ garudaLoading=false; }
}
function garTopBar(){
  return '<div class="gar-top"><div class="gar-brand"><img src="logo-lockup-white.png" alt="">CNG Garuda</div>'+
    '<select id="gar-col" class="gar-colsel" aria-label="Garuda section">'+GAR_COLS.map(c=>'<option value="'+c[0]+'"'+(garudaTab===c[0]?' selected':'')+'>'+esc(c[1])+'</option>').join('')+'</select>'+
    '<div class="gar-actions"><button class="btn sm" id="g-scan">📷 Scan a QR</button><button class="btn sm" id="gar-exit">← Back to SETU</button></div></div>';
}
function viewGaruda(){
  if(!garudaLoaded) return garTopBar()+'<div class="card pad"><p class="hint" style="margin:0">Loading Garuda…</p></div>';
  let body;
  switch(garudaTab){
    case 'issue': body=garIssue(); break;
    case 'consumed': body=garConsumed(); break;
    case 'items': body=garItems(); break;
    case 'stations': body=garStations(); break;
    case 'qr': body=garQR(); break;
    case 'trace': body=garTrace(); break;
    case 'history': body=garHistory(); break;
    case 'admin': body=garAdmin(); break;
    default: body=garProcessed();
  }
  return garTopBar()+'<div id="g-body">'+body+'</div>';
}
/* Processed — goods past both approvals, grouped by item; open an item to see/print its QRs */
function garProcessed(){
  const lots=DB.garudaLots||[], tags=DB.garudaTags||[];
  if(!lots.length) return '<div class="card pad"><p class="hint" style="margin:0">No GRNs processed yet. When a CNG GRN passes final HO approval, its items and QR codes appear here.</p></div>';
  const q=garudaProcQ.trim().toLowerCase();
  const byItem={};
  lots.forEach(l=>{ const g=byItem[l.item_code]=byItem[l.item_code]||{code:l.item_code,name:l.item_name||'',grns:new Set(),pos:new Set()}; if(l.grn_no)g.grns.add(l.grn_no); if(l.po_no)g.pos.add(l.po_no); });
  let items=Object.values(byItem).map(g=>({code:g.code,name:g.name,grns:[...g.grns],pos:[...g.pos],qrs:tags.filter(t=>t.item_code===g.code).length}));
  if(q) items=items.filter(g=>(g.code+' '+g.name+' '+g.grns.join(' ')+' '+g.pos.join(' ')).toLowerCase().includes(q)||tags.some(t=>t.item_code===g.code&&t.id.toLowerCase().includes(q)));
  items.sort((a,b)=>a.code.localeCompare(b.code));
  const head='<div class="card"><div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line);gap:10px;flex-wrap:wrap"><input id="g-procsearch" type="text" placeholder="Search item, ERP, PO, GRN or QR" value="'+esc(garudaProcQ)+'" style="flex:1;min-width:220px"><span class="tag t-prog" style="align-self:center">'+items.length+' item'+(items.length===1?'':'s')+'</span></div>';
  const rows=items.length?items.map(g=>'<tr><td><b class="num">'+esc(g.code)+'</b> <span class="hint">'+esc(g.name)+'</span></td><td class="num">'+g.qrs+'</td><td class="hint meta">'+esc(g.grns.slice(0,3).join(', ')||'—')+(g.grns.length>3?' +'+(g.grns.length-3):'')+'</td><td class="hint meta">'+esc(g.pos.slice(0,2).join(', ')||'—')+'</td><td style="text-align:right"><button class="btn sm" data-procitem="'+esc(g.code)+'">View / print QRs</button></td></tr>').join('')
    :'<tr><td colspan="5"><div class="empty" style="padding:18px"><p class="hint">No item matches.</p></div></td></tr>';
  return head+'<table class="cards"><thead><tr><th>Item</th><th>QRs</th><th>GRN(s)</th><th>PO(s)</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}
/* Issue — send a QR out of the store (single or a range), and allot it at the station */
function garIssue(){
  const store=canGarudaStore()||ME.owner||ME.admin, site=canGarudaSite()||ME.owner||ME.admin;
  const tags=DB.garudaTags||[], inStore=tags.filter(t=>t.status==='in_store'), issued=tags.filter(t=>t.status==='issued');
  if(!store&&!site) return '<div class="card pad"><p class="hint" style="margin:0">You don’t have a Garuda work role. Ask an admin for <b>store</b> or <b>site</b> access to issue or allot.</p></div>';
  let html='<div class="card pad" style="margin-bottom:12px"><button class="btn primary" id="g-scan2">📷 Scan a QR to issue / allot</button><div class="hint" style="margin-top:6px">Scan a sticker to issue it from the store, or to allot it once it reaches the station.</div></div>';
  if(store){
    html+='<div class="card pad" style="margin-bottom:12px"><h3 style="margin:0 0 4px">Issue a range</h3><p class="hint" style="margin:0 0 10px">Same series, up to 100 codes, all still in store. Leave “To” blank to issue just one.</p>'+
      '<div class="grid g2" style="gap:10px"><div><label for="ir-from">From QR</label><input id="ir-from" placeholder="GAR-DSP-00001" autocomplete="off" style="text-transform:uppercase"></div><div><label for="ir-to">To QR (optional)</label><input id="ir-to" placeholder="GAR-DSP-00010" autocomplete="off" style="text-transform:uppercase"></div>'+
      '<div><label for="ir-stn">Station</label><input id="ir-stn" list="cng-stn-dl2" placeholder="Station number" autocomplete="off"><datalist id="cng-stn-dl2">'+(DB.garudaStations||[]).map(s=>'<option value="'+esc(s.no)+'">'+esc(s.name)+'</option>').join('')+'</datalist></div>'+
      '<div><label for="ir-to2">Issued to</label><input id="ir-to2" type="text" placeholder="Person / technician taking it"></div>'+
      '<div><label for="ir-by">Issued by</label><input id="ir-by" type="text" value="'+esc((ME&&ME.name)||'')+'" placeholder="Who is issuing"></div>'+
      '<div><label for="ir-date">Issue date</label><input id="ir-date" type="date" value="'+esc(DAY())+'"></div></div>'+
      '<div class="row" style="margin-top:12px;gap:10px;align-items:center"><button class="btn primary" id="ir-go">Issue</button><span id="ir-err" class="hint" style="color:var(--stop)"></span></div></div>';
    html+='<div class="card"><div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line)"><h3 style="margin:0">In store</h3><span class="tag t-ok" style="margin-left:auto">'+inStore.length+'</span></div>'+
      '<table class="cards"><thead><tr><th>QR</th><th>Item</th><th></th></tr></thead><tbody>'+
      (inStore.length?inStore.slice(0,200).map(t=>'<tr><td class="num"><b>'+esc(t.id)+'</b></td><td>'+esc(t.item_code)+' <span class="hint">'+esc(t.item_name||'')+'</span></td><td style="text-align:right"><button class="btn sm" data-tag="'+esc(t.id)+'">Issue</button></td></tr>').join('')
        :'<tr><td colspan="3"><div class="empty" style="padding:16px"><p class="hint">Nothing in store to issue.</p></div></td></tr>')+'</tbody></table></div>';
  }
  if(site){
    html+='<div class="card" style="margin-top:12px"><div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line)"><h3 style="margin:0">Issued — ready to allot at the station</h3><span class="tag t-prog" style="margin-left:auto">'+issued.length+'</span></div>'+
      '<table class="cards"><thead><tr><th>QR</th><th>Item</th><th>Station</th><th></th></tr></thead><tbody>'+
      (issued.length?issued.slice(0,200).map(t=>'<tr><td class="num"><b>'+esc(t.id)+'</b></td><td>'+esc(t.item_code)+'</td><td class="hint">'+esc(t.station_no||'—')+'</td><td style="text-align:right"><button class="btn sm" data-tag="'+esc(t.id)+'">Allot</button></td></tr>').join('')
        :'<tr><td colspan="4"><div class="empty" style="padding:16px"><p class="hint">Nothing waiting to be allotted.</p></div></td></tr>')+'</tbody></table></div>';
  }
  return html;
}
/* Consumed — mark the old part used on site, then accept it back at the warehouse */
function garConsumed(){
  const store=canGarudaStore()||ME.owner||ME.admin, site=canGarudaSite()||ME.owner||ME.admin;
  const tags=DB.garudaTags||[], allotted=tags.filter(t=>t.status==='allotted'), consumed=tags.filter(t=>t.status==='consumed');
  if(!store&&!site) return '<div class="card pad"><p class="hint" style="margin:0">You don’t have a Garuda work role.</p></div>';
  let html='<div class="card pad" style="margin-bottom:12px"><button class="btn primary" id="g-scan2">📷 Scan a QR</button><div class="hint" style="margin-top:6px">Scan the old part on site to mark it consumed, or scan it at the warehouse to accept it back.</div></div>';
  if(site){
    html+='<div class="card"><div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line)"><h3 style="margin:0">On site — ready to consume</h3><span class="tag t-wait" style="margin-left:auto">'+allotted.length+'</span></div>'+
      '<table class="cards"><thead><tr><th>QR</th><th>Item</th><th>Station</th><th></th></tr></thead><tbody>'+
      (allotted.length?allotted.slice(0,200).map(t=>'<tr><td class="num"><b>'+esc(t.id)+'</b></td><td>'+esc(t.item_code)+'</td><td class="hint">'+esc(t.station_no||'—')+'</td><td style="text-align:right"><button class="btn sm" data-tag="'+esc(t.id)+'">Consume</button></td></tr>').join('')
        :'<tr><td colspan="4"><div class="empty" style="padding:16px"><p class="hint">Nothing to consume.</p></div></td></tr>')+'</tbody></table></div>';
  }
  if(store){
    html+='<div class="card" style="margin-top:12px"><div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line)"><h3 style="margin:0">Consumed — ready to accept back at the warehouse</h3><span class="tag t-hold" style="margin-left:auto">'+consumed.length+'</span></div>'+
      '<table class="cards"><thead><tr><th>QR</th><th>Item</th><th></th></tr></thead><tbody>'+
      (consumed.length?consumed.slice(0,200).map(t=>'<tr><td class="num"><b>'+esc(t.id)+'</b></td><td>'+esc(t.item_code)+'</td><td style="text-align:right"><button class="btn sm" data-tag="'+esc(t.id)+'">Accept return</button></td></tr>').join('')
        :'<tr><td colspan="3"><div class="empty" style="padding:16px"><p class="hint">Nothing waiting to be accepted back.</p></div></td></tr>')+'</tbody></table></div>';
  }
  return html;
}
/* Item — every item with its warehouse counts */
function garItems(){
  const items=DB.garudaItems||[], q=garudaItemQ.trim().toLowerCase();
  const rows=items.filter(i=>!q||(i.code+' '+i.name+' '+i.type).toLowerCase().includes(q)).slice(0,500);
  const stat=code=>{ const t=(DB.garudaTags||[]).filter(x=>x.item_code===code), c=s=>t.filter(x=>x.status===s).length; return {tot:t.length,store:c('in_store'),out:c('issued')+c('allotted'),cons:c('consumed')+c('returned')}; };
  return '<div class="card"><div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line);gap:10px;flex-wrap:wrap"><input id="g-isearch" type="text" placeholder="Search item code, name or type" value="'+esc(garudaItemQ)+'" style="flex:1;min-width:220px"><span class="tag t-prog" style="align-self:center">'+rows.length+(items.length>rows.length?' of '+items.length:'')+'</span></div>'+
    '<table class="cards"><thead><tr><th>Item code</th><th>Name</th><th>Type</th><th>In store</th><th>Out</th><th>Consumed</th><th>Total QR</th></tr></thead><tbody>'+
    (rows.length?rows.map(i=>{const s=stat(i.code); return '<tr><td class="num"><b>'+esc(i.code)+'</b></td><td>'+esc(i.name)+'</td><td class="hint meta">'+esc(i.type||'—')+'</td><td class="num">'+s.store+'</td><td class="num">'+s.out+'</td><td class="num">'+s.cons+'</td><td class="num">'+(s.tot||'—')+'</td></tr>';}).join('')
      :'<tr><td colspan="7"><div class="empty" style="padding:20px"><p class="hint">No item matches.</p></div></td></tr>')+
    '</tbody></table>'+(items.length>500&&!q?'<div class="hint" style="padding:10px 16px">Showing the first 500 — search to narrow.</div>':'')+'</div>';
}
/* Station — a box per station; open to see the QRs issued there */
function garStations(){
  const stations=DB.garudaStations||[], tags=DB.garudaTags||[];
  const atStn=no=>tags.filter(t=>t.station_no===no&&t.status!=='in_store');
  if(garudaStationSel){
    const st=stations.find(s=>s.no===garudaStationSel)||{no:garudaStationSel,name:''}, rows=atStn(garudaStationSel);
    return '<button class="btn sm" id="g-stnback" style="margin-bottom:10px">← All stations</button>'+
      '<div class="card"><div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line)"><h3 style="margin:0">Station '+esc(st.no)+' <span class="hint">'+esc(st.name)+'</span></h3><span class="tag t-prog" style="margin-left:auto">'+rows.length+' QR</span></div>'+
      '<table class="cards"><thead><tr><th>QR</th><th>Item</th><th>Issued to</th><th>Issue date</th><th></th></tr></thead><tbody>'+
      (rows.length?rows.map(t=>'<tr><td class="num"><b>'+esc(t.id)+'</b></td><td>'+esc(t.item_code)+' <span class="hint">'+esc(t.item_name||'')+'</span></td><td class="hint meta">'+esc(t.issued_to||'—')+'</td><td class="hint meta">'+esc(t.issued_at?fmtD(ts(t.issued_at)):'—')+'</td><td style="text-align:right"><button class="btn sm" data-tag="'+esc(t.id)+'">Open</button></td></tr>').join('')
        :'<tr><td colspan="5"><div class="empty" style="padding:18px"><p class="hint">Nothing issued to this station yet.</p></div></td></tr>')+
      '</tbody></table></div>';
  }
  const q=garudaStnQ.trim().toLowerCase(), rows=stations.filter(s=>!q||(s.no+' '+s.name).toLowerCase().includes(q));
  return '<div class="card pad" style="margin-bottom:12px"><input id="g-ssearch" type="text" placeholder="Search station number or name" value="'+esc(garudaStnQ)+'" style="width:100%"></div>'+
    '<div class="gar-box">'+(rows.length?rows.map(s=>{const n=atStn(s.no).length; return '<div class="gar-tile" data-stn="'+esc(s.no)+'"><b>'+esc(s.no)+'</b><div class="hint">'+esc(s.name||'')+'</div><div class="tag t-ok" style="margin-top:8px">'+n+' QR</div></div>';}).join('')
      :'<p class="hint">No station matches.</p>')+'</div>';
}
/* QR management — every QR, filterable, open one to act on it */
function garQR(){
  const tags=DB.garudaTags||[], q=garudaStockQ.trim().toLowerCase();
  const counts={}; tags.forEach(t=>counts[t.status]=(counts[t.status]||0)+1);
  const rows=tags.filter(t=>(garudaStockF==='all'||t.status===garudaStockF)&&(!q||(t.id+' '+t.item_code+' '+(t.item_name||'')+' '+(t.station_no||'')+' '+(t.issued_to||'')+' '+(t.po_no||'')+' '+(t.grn_no||'')).toLowerCase().includes(q))).slice(0,400);
  const chip=(k,label)=>'<button data-sf="'+k+'" class="btn sm '+(garudaStockF===k?'primary':'ghost')+'">'+esc(label)+(k!=='all'&&counts[k]?' '+counts[k]:'')+'</button>';
  return '<div class="card"><div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line);gap:8px;flex-wrap:wrap">'+
    chip('all','All ('+tags.length+')')+chip('in_store','In store')+chip('issued','Issued')+chip('allotted','Allotted')+chip('consumed','Consumed')+chip('returned','Returned')+
    '<input id="g-stocksearch" type="text" placeholder="Search QR, item, station, person, PO, GRN" value="'+esc(garudaStockQ)+'" style="flex:1;min-width:200px"></div>'+
    '<table class="cards"><thead><tr><th>QR code</th><th>Item</th><th>Status</th><th>Where</th><th></th></tr></thead><tbody>'+
    (rows.length?rows.map(t=>{const s=CNG_ST[t.status]||['t-wait',t.status]; return '<tr><td class="num"><b>'+esc(t.id)+'</b></td><td>'+esc(t.item_code)+' <span class="hint">'+esc(t.item_name||'')+'</span></td><td><span class="tag '+s[0]+'" style="font-size:11px">'+s[1]+'</span></td><td class="hint meta">'+esc(t.station_no||'—')+(t.issued_to?' · '+esc(t.issued_to):'')+'</td><td style="text-align:right"><button class="btn sm" data-tag="'+esc(t.id)+'">Open</button></td></tr>';}).join('')
      :'<tr><td colspan="5"><div class="empty" style="padding:18px"><p class="hint">No QR matches.</p></div></td></tr>')+
    '</tbody></table></div>';
}
/* History — Issued and Consumed records (read-only) */
function garHistory(){
  const tags=DB.garudaTags||[], q=garudaHistQ.trim().toLowerCase();
  const sub=(k,l)=>'<button data-hist="'+k+'" class="btn sm '+(garudaHistTab===k?'primary':'ghost')+'">'+l+'</button>';
  const bar='<div class="gar-subtabs">'+sub('issued','Issued')+sub('consumed','Consumed')+'</div>'+
    '<div class="card pad" style="margin-bottom:10px"><input id="g-histsearch" type="text" placeholder="Search QR, item, station or person" value="'+esc(garudaHistQ)+'" style="width:100%"></div>';
  if(garudaHistTab==='consumed'){
    let rows=tags.filter(t=>t.consumed_at); if(q) rows=rows.filter(t=>(t.id+' '+t.item_code+' '+(t.item_name||'')).toLowerCase().includes(q));
    rows.sort((a,b)=>ts(b.consumed_at)-ts(a.consumed_at));
    return bar+'<div class="card"><table class="cards"><thead><tr><th>QR</th><th>Item</th><th>Consumed on</th><th></th></tr></thead><tbody>'+
      (rows.length?rows.map(t=>'<tr><td class="num"><b>'+esc(t.id)+'</b></td><td>'+esc(t.item_code)+' <span class="hint">'+esc(t.item_name||'')+'</span></td><td class="hint meta">'+esc(fmtDT(ts(t.consumed_at)))+'</td><td style="text-align:right"><button class="btn sm" data-tag="'+esc(t.id)+'">Open</button></td></tr>').join('')
        :'<tr><td colspan="4"><div class="empty" style="padding:18px"><p class="hint">Nothing consumed yet.</p></div></td></tr>')+'</tbody></table></div>';
  }
  let rows=tags.filter(t=>t.issued_at); if(q) rows=rows.filter(t=>(t.id+' '+t.item_code+' '+(t.item_name||'')+' '+(t.station_no||'')+' '+(t.issued_to||'')).toLowerCase().includes(q));
  rows.sort((a,b)=>ts(b.issued_at)-ts(a.issued_at));
  return bar+'<div class="card"><table class="cards"><thead><tr><th>QR</th><th>Item</th><th>Station</th><th>Issued on</th><th></th></tr></thead><tbody>'+
    (rows.length?rows.map(t=>'<tr><td class="num"><b>'+esc(t.id)+'</b></td><td>'+esc(t.item_code)+' <span class="hint">'+esc(t.item_name||'')+'</span></td><td class="hint meta">'+esc(t.station_no||'—')+'</td><td class="hint meta">'+esc(fmtD(ts(t.issued_at)))+'</td><td style="text-align:right"><button class="btn sm" data-tag="'+esc(t.id)+'">Open</button></td></tr>').join('')
      :'<tr><td colspan="5"><div class="empty" style="padding:18px"><p class="hint">Nothing issued yet.</p></div></td></tr>')+'</tbody></table></div>';
}
/* Trace — the full life of one PO, item by item */
function garResolvePO(q){ if(!q) return ''; const Q=q.trim().toLowerCase(); const lots=DB.garudaLots||[], tags=DB.garudaTags||[];
  let hit=lots.find(l=>(l.po_no||'').toLowerCase()===Q)||lots.find(l=>(l.po_no||'').toLowerCase().includes(Q)||(l.grn_no||'').toLowerCase()===Q||(l.item_code||'').toLowerCase()===Q);
  if(hit) return hit.po_no;
  const tg=tags.find(t=>t.id.toLowerCase()===Q||(t.grn_no||'').toLowerCase()===Q||(t.item_code||'').toLowerCase()===Q); if(tg) return tg.po_no;
  hit=lots.find(l=>(l.item_name||'').toLowerCase().includes(Q)); return hit?hit.po_no:'';
}
function garTrace(){
  const lots=DB.garudaLots||[], tags=DB.garudaTags||[];
  const head='<div class="card pad" style="margin-bottom:12px"><div class="row" style="gap:8px"><input id="g-tracesearch" type="text" placeholder="Search a PO (or item / GRN / QR)" value="'+esc(garudaTraceQ)+'" style="flex:1"><button class="btn primary" id="g-tracego">Trace</button></div><div class="hint" style="margin-top:6px">The full life of a purchase order, item by item.</div></div>';
  if(!garudaTraceSel) return head+'<div class="card pad"><p class="hint" style="margin:0">Enter a PO number above to see its life cycle.</p></div>';
  const po=garudaTraceSel, poLots=lots.filter(l=>l.po_no===po);
  if(!poLots.length) return head+'<div class="card pad"><p class="hint" style="margin:0">No processed records found for PO '+esc(po)+'.</p></div>';
  const byItem={}; poLots.forEach(l=>(byItem[l.item_code]=byItem[l.item_code]||[]).push(l));
  const flow=(DB.flows||[]).find(f=>poLots.some(l=>l.request_id===f.id));
  const approvals=flow?flow.steps.filter(s=>/approve|grn/i.test(s.label)).map(s=>'<div class="hint">• '+esc(s.label)+' — '+(s.status==='done'?(s.actedBy?esc(user(s.actedBy).name):'done')+(s.actedAt?' · '+esc(fmtDT(s.actedAt)):''):esc(s.status))+'</div>').join(''):'<span class="hint">—</span>';
  const sec=(title,inner)=>'<div style="margin-top:8px"><b style="font-size:13px">'+title+'</b><div style="margin-top:3px">'+(inner||'<span class="hint">—</span>')+'</div></div>';
  const body=Object.keys(byItem).map(code=>{ const ls=byItem[code], itemTags=tags.filter(t=>ls.some(l=>l.id===t.lot_id)), l0=ls[0];
    const inv=itemTags.filter(t=>t.status==='in_store'), out=itemTags.filter(t=>t.status==='issued'||t.status==='allotted'), cons=itemTags.filter(t=>t.status==='consumed'||t.status==='returned'), repl=itemTags.filter(t=>t.replaced_from);
    return '<div class="card pad" style="margin-bottom:12px"><h3 style="margin:0 0 4px">'+esc(code)+' <span class="hint">'+esc(l0.item_name||'')+'</span></h3>'+
      sec('Purchase order','<span class="hint">PO '+esc(po)+' · vendor '+esc(l0.vendor||'—')+' · ordered '+ls.reduce((a,l)=>a+(l.order_qty||0),0)+' · received '+ls.reduce((a,l)=>a+(l.accepted_qty||0),0)+' · rate '+esc(l0.rate||'—')+'</span>')+
      sec('GRN',ls.map(l=>'<div class="hint">GRN '+esc(l.grn_no||'—')+(l.grn_date?' · '+esc(l.grn_date):'')+' · qty '+(l.accepted_qty||0)+' · inv '+esc(l.invoice_no||'—')+' · QR '+esc(l.series_from||'')+((l.accepted_qty||0)>1?'…'+esc(l.series_to||''):'')+'</div>').join(''))+
      sec('Approvals (Bangalore & HO)',approvals)+
      sec('Inventory (in store)',inv.map(t=>'<span class="tag t-ok" style="margin:2px;display:inline-block">'+esc(t.id)+'</span>').join(''))+
      sec('Issue & allot',out.map(t=>'<div class="hint">'+esc(t.id)+' → station '+esc(t.station_no||'—')+' · to '+esc(t.issued_to||'—')+(t.issued_by_name?' · by '+esc(t.issued_by_name):'')+(t.allotted_at?' · allotted'+(t.allotted_by_name?' by '+esc(t.allotted_by_name):'')+' '+esc(fmtD(ts(t.allotted_at))):'')+'</div>').join(''))+
      sec('Consumed & warehouse',cons.map(t=>'<div class="hint">'+esc(t.id)+' · consumed'+(t.consumed_by_name?' by '+esc(t.consumed_by_name):'')+(t.consume_remark?' ('+esc(t.consume_remark)+')':'')+(t.returned_at?' · accepted back'+(t.returned_by_name?' by '+esc(t.returned_by_name):'')+' '+esc(fmtD(ts(t.returned_at))):'')+'</div>').join(''))+
      sec('Replaced',repl.map(t=>'<div class="hint">'+esc(t.replaced_from)+' → '+esc(t.id)+'</div>').join(''))+
      '</div>';
  }).join('');
  return head+'<div class="card pad" style="margin-bottom:12px"><b>PO '+esc(po)+'</b> · '+Object.keys(byItem).length+' item(s)</div>'+body;
}
/* Admin — masters (add/edit arrives in a later update) */
function garAdmin(){
  return '<div class="gar-box" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">'+
    '<div class="gar-tile" data-admin="items"><b>Item master</b><div class="hint">'+(DB.garudaItems||[]).length+' items</div></div>'+
    '<div class="gar-tile" data-admin="stations"><b>Station master</b><div class="hint">'+(DB.garudaStations||[]).length+' stations</div></div>'+
    '</div><div class="hint" style="margin-top:10px">Opens the browse lists. Add / edit of the masters is coming in the next update.</div>';
}
/* show an arbitrary set of QR stickers — scan from screen, tap one to open it, or print all */
function garQrDialog(title,tags){
  if(!tags||!tags.length) return toast('No QR codes for this item.','bad');
  modal({title:title,
    body:'<div class="hint" style="margin:0 0 10px">'+tags.length+' sticker'+(tags.length>1?'s':'')+'. Tap a code to open it, or print them together.</div>'+
      '<div id="qr-grid" class="row" style="gap:12px;flex-wrap:wrap;justify-content:center"></div>',
    footer:'<button class="btn" data-x>Close</button><button class="btn primary" id="qr-print">Download all / print</button>',
    onOpen:(mv,cl)=>{ const grid=$('#qr-grid',mv), printCells=[];
      ensureQR().then(()=>{ tags.forEach(t=>{ const cell=document.createElement('div'); cell.className='qr-cell'; cell.style.cssText='text-align:center;padding:8px;border:1px solid var(--line);border-radius:8px;cursor:pointer';
          const box=document.createElement('div'); cell.appendChild(box);
          try{ new QRCode(box,{text:garTagUrl(t.id),width:118,height:118,correctLevel:QRCode.CorrectLevel.M}); }catch(e){}
          const cap=document.createElement('div'); cap.className='num'; cap.style.cssText='margin-top:6px;font-size:12px;font-weight:600'; cap.textContent=t.id; cell.appendChild(cap);
          cell.onclick=()=>{ cl(); setTimeout(()=>cngTagPanel(t.id),0); };
          grid.appendChild(cell);
          let durl=''; try{ const cv=box.querySelector('canvas'); durl=cv?cv.toDataURL('image/png'):((box.querySelector('img')||{}).src||''); }catch(e){}
          printCells.push('<div class="qr-cell"><img src="'+durl+'"><div>'+esc(t.id)+'</div></div>'); }); })
        .catch(()=>{ grid.innerHTML='<p class="hint">Could not load the QR renderer — reopen.</p>'; });
      if($('#qr-print',mv)) $('#qr-print',mv).onclick=()=>{ if(!printCells.length) return toast('Still rendering — try again.','bad');
        const w=window.open('','_blank'); if(!w) return toast('Allow pop-ups to print.','bad');
        w.document.write('<html><head><title>QR codes</title><style>body{font-family:sans-serif;display:flex;flex-wrap:wrap;gap:12px;padding:12px}.qr-cell{text-align:center;border:1px solid #ccc;border-radius:8px;padding:8px}.qr-cell img{width:118px;height:118px}.qr-cell div{font-size:12px;margin-top:6px;font-weight:600}</style></head><body>'+printCells.join('')+'</body></html>');
        w.document.close(); setTimeout(()=>{ try{ w.print(); }catch(e){} },500); };
    }});
}
/* Public QR page — what a RANDOM scanner (no SETU login) sees: item, vendor,
   issue date only. The same code inside the signed-in app opens the full panel. */
async function garPublicView(id){
  let data=null; try{ const r=await SB.rpc('cng_public_tag',{p_tag:garTagCode(id)}); data=r.data; }catch(e){}
  let el=document.getElementById('gpub'); if(el) el.remove();
  el=document.createElement('div'); el.id='gpub';
  el.style.cssText='position:fixed;inset:0;z-index:130;display:grid;place-items:center;background:#f6f7f9;padding:20px;overflow:auto';
  const row=(k,val)=>'<tr><td style="color:#536471;padding:4px 12px 4px 0;white-space:nowrap">'+k+'</td><td style="font-weight:600">'+esc(val||'—')+'</td></tr>';
  const inner = data
    ? '<div style="font-weight:800;letter-spacing:.32em;color:#0c3aa6;font-size:22px">S E T U</div><div style="color:#536471;font-size:13px;margin-bottom:16px">CNG part · Garuda</div>'+
      '<div style="text-align:left;border:1px solid #e3e6ea;border-radius:12px;padding:18px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.06)">'+
        '<div style="font-weight:700;font-size:18px;letter-spacing:.02em">'+esc(data.id)+'</div>'+
        '<table style="margin-top:12px;font-size:14px;width:100%;border-collapse:collapse">'+row('Item',data.item_name)+row('Vendor',data.vendor)+row('Issue date',data.issue_date)+'</table>'+
        '<div style="color:#536471;font-size:12.5px;margin-top:16px;border-top:1px solid #eef0f2;padding-top:12px">Signed-in SETU users see the full record — PO, GRN, rate, station and who issued it.</div>'+
      '</div>'
    : '<div style="font-weight:800;letter-spacing:.32em;color:#0c3aa6;font-size:22px">S E T U</div><div style="border:1px solid #e3e6ea;border-radius:12px;padding:20px;background:#fff;margin-top:16px;color:#536471">This QR code was not found.</div>';
  el.innerHTML='<div style="text-align:center;max-width:360px;width:100%">'+inner+'<div style="margin-top:18px"><button class="btn primary" id="gpub-go" style="width:100%">Open SETU</button></div></div>';
  document.body.appendChild(el);
  const b=document.getElementById('gpub-go'); if(b) b.onclick=()=>{ el.remove(); try{ history.replaceState(null,'',APP_URL); }catch(e){} if(ME){ render(); } else { hideSplash(); paintSignIn(); } };
}
function wireGaruda(v){
  if(!garudaLoaded){ loadGaruda().then(()=>{ if(ROUTE.name==='garuda') render(); }); }
  const col=$('#gar-col',v); if(col) col.onchange=()=>{ garudaTab=col.value; garudaStationSel=''; render(); };
  if($('#gar-exit',v)) $('#gar-exit',v).onclick=()=>go({name:'dash'});
  if($('#g-scan',v)) $('#g-scan',v).onclick=()=>cngScanDialog();
  if($('#g-scan2',v)) $('#g-scan2',v).onclick=()=>cngScanDialog();
  if($('#ir-go',v)) $('#ir-go',v).onclick=async()=>{
    const from=($('#ir-from',v).value||'').trim(), to=($('#ir-to',v).value||'').trim(), stn=($('#ir-stn',v).value||'').trim(), who=($('#ir-to2',v).value||'').trim(), by=($('#ir-by',v).value||'').trim(), dt=($('#ir-date',v).value||'')||null, err=$('#ir-err',v);
    err.textContent='';
    if(!from) return err.textContent='Enter the first QR.';
    if(!stn) return err.textContent='Choose a station.';
    if(!who) return err.textContent='Enter who it is issued to.';
    busy(true);
    try{ const n=await rpc('cng_issue_range',{p_from:garTagCode(from),p_to:to?garTagCode(to):garTagCode(from),p_station:stn,p_to_person:who,p_by_name:by,p_issue_date:dt}); await cngReload(); toast(n+' QR'+(n>1?'s':'')+' issued.','ok'); }
    catch(e){ err.textContent=(e.message||'').replace(/^.*?: /,''); }
    busy(false);
  };
  const wireSearch=(id,set)=>{ const el=$('#'+id,v); if(el) el.oninput=()=>{ set(el.value); const p=el.selectionStart; render(); const n=document.getElementById(id); if(n){n.focus();try{n.setSelectionRange(p,p);}catch(e){}} }; };
  wireSearch('g-procsearch',x=>garudaProcQ=x);
  wireSearch('g-isearch',x=>garudaItemQ=x);
  wireSearch('g-ssearch',x=>garudaStnQ=x);
  wireSearch('g-stocksearch',x=>garudaStockQ=x);
  wireSearch('g-histsearch',x=>garudaHistQ=x);
  $$('[data-procitem]',v).forEach(b=>b.onclick=()=>{ const code=b.dataset.procitem; garQrDialog('QR codes — '+code,(DB.garudaTags||[]).filter(t=>t.item_code===code)); });
  $$('[data-tag]',v).forEach(b=>b.onclick=()=>cngTagPanel(b.dataset.tag));
  $$('[data-sf]',v).forEach(b=>b.onclick=()=>{ garudaStockF=b.dataset.sf; render(); });
  $$('[data-stn]',v).forEach(b=>b.onclick=()=>{ garudaStationSel=b.dataset.stn; render(); });
  if($('#g-stnback',v)) $('#g-stnback',v).onclick=()=>{ garudaStationSel=''; render(); };
  $$('[data-hist]',v).forEach(b=>b.onclick=()=>{ garudaHistTab=b.dataset.hist; render(); });
  $$('[data-admin]',v).forEach(b=>b.onclick=()=>{ garudaTab=b.dataset.admin; render(); });
  const tgo=()=>{ const el=$('#g-tracesearch',v); const qq=(el?el.value:'').trim(); garudaTraceQ=qq; garudaTraceSel=garResolvePO(qq); render(); };
  if($('#g-tracego',v)) $('#g-tracego',v).onclick=tgo;
  const tsel=$('#g-tracesearch',v); if(tsel) tsel.onkeydown=e=>{ if(e.key==='Enter') tgo(); };
}

/* ---------- CNG QR lifecycle: scan / find a sticker, then act on it ---------- */
const CNG_ST={in_store:['t-ok','In store'],issued:['t-prog','Issued'],allotted:['t-wait','Allotted'],consumed:['t-hold','Consumed'],returned:['t-bad','Returned'],replaced:['t-bad','Replaced']};
async function cngFetchTag(code){ const {data}=await SB.from('cng_tags').select('*').eq('id',(code||'').trim().toUpperCase()).maybeSingle(); return data||null; }
async function cngReload(){ await loadGaruda(true); if(ROUTE.name==='garuda') render(); }
function cngScanDialog(){
  let stream=null, raf=0, stopped=false;
  const stop=()=>{ stopped=true; if(raf)cancelAnimationFrame(raf); if(stream){try{stream.getTracks().forEach(t=>t.stop())}catch(e){}} };
  modal({title:'Scan or enter a QR',
    body:'<div style="text-align:center"><video id="sc-vid" playsinline muted style="width:100%;max-width:320px;border-radius:10px;background:#000;display:none"></video>'+
      '<div id="sc-hint" class="hint" style="margin-top:8px">Point the camera at the sticker, or type the code below.</div></div>'+
      '<div style="margin-top:12px;display:flex;gap:8px"><input id="sc-code" type="text" placeholder="GAR-DSP-00001" autocomplete="off" style="flex:1;text-transform:uppercase"><button class="btn" id="sc-find">Find</button></div>'+
      '<div id="sc-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>',
    footer:'<button class="btn" data-x>Close</button><button class="btn primary" id="sc-cam">Use camera</button>',
    onOpen:(mv,close)=>{
      const open=async(code)=>{ const raw=(code||$('#sc-code',mv).value||'').trim(); if(!raw) return $('#sc-err',mv).textContent='Type a QR code.'; const c=garTagCode(raw);
        const t=await cngFetchTag(c); if(!t){ $('#sc-err',mv).textContent='No QR found for '+c+'.'; return; } stop(); close(); setTimeout(()=>cngTagPanel(t.id),0); };
      $('#sc-find',mv).onclick=()=>open();
      $('#sc-code',mv).onkeydown=e=>{ if(e.key==='Enter') open(); };
      $('#sc-cam',mv).onclick=async()=>{
        const btn=$('#sc-cam',mv); btn.disabled=true;
        try{ await ensureJsQR(); stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
          const vid=$('#sc-vid',mv); vid.style.display='block'; vid.srcObject=stream; await vid.play();
          $('#sc-hint',mv).textContent='Scanning… hold the sticker steady.';
          const cv=document.createElement('canvas'), ctx=cv.getContext('2d');
          const tick=()=>{ if(stopped) return; if(vid.readyState===vid.HAVE_ENOUGH_DATA){ cv.width=vid.videoWidth; cv.height=vid.videoHeight; ctx.drawImage(vid,0,0,cv.width,cv.height);
              try{ const img=ctx.getImageData(0,0,cv.width,cv.height); const r=window.jsQR&&jsQR(img.data,cv.width,cv.height); if(r&&r.data){ open(r.data); return; } }catch(e){} }
            raf=requestAnimationFrame(tick); };
          tick();
        }catch(e){ btn.disabled=false; $('#sc-err',mv).textContent='Camera not available — type the code instead.'; }
      };
      // closing the modal (X / back) must stop the camera
      const veil=mv.closest?mv.closest('.veil'):null; if(veil){ const mo=new MutationObserver(()=>{ if(!document.body.contains(veil)){ stop(); mo.disconnect(); } }); mo.observe(document.body,{childList:true,subtree:true}); }
    }});
}
let _jsqrP=null;
function ensureJsQR(){ if(window.jsQR) return Promise.resolve();
  if(!_jsqrP) _jsqrP=new Promise((res,rej)=>{ const sc=document.createElement('script');
    sc.src='https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js'; sc.onload=()=>res(); sc.onerror=()=>rej(new Error('scanner load failed')); document.head.appendChild(sc); });
  return _jsqrP; }
async function cngTagPanel(code){
  const t=await cngFetchTag(code); if(!t) return toast('QR not found.','bad');
  const st=CNG_ST[t.status]||['t-wait',t.status];
  const {data:evs}=await SB.from('cng_tag_events').select('action,by_name,detail,at').eq('tag_id',t.id).order('at');
  const hist=(evs||[]).map(e=>'<div class="hint" style="margin-top:3px">• <b>'+esc(e.action)+'</b>'+(e.by_name?' — '+esc(e.by_name):'')+(e.detail?' · '+esc(e.detail):'')+' <span style="opacity:.7">'+esc(fmtDT(ts(e.at)))+'</span></div>').join('');
  // find any QR that replaced this one (trace the chain forward)
  const replacedBy=(DB.garudaTags||[]).find(x=>x.replaced_from===t.id);
  let actions='';
  if(t.status==='in_store'&&canGarudaStore()) actions='<button class="btn primary" data-act="issue">Issue to a station</button>';
  else if(t.status==='issued'&&canGarudaSite()) actions='<button class="btn primary" data-act="allot">Mark allotted (fitted)</button>';
  else if(t.status==='allotted'&&canGarudaSite()) actions='<button class="btn primary" data-act="consume">Mark consumed</button>';
  else if(t.status==='consumed'&&canGarudaStore()) actions='<button class="btn primary" data-act="return">Accept return at store</button>';
  const canReplace=['in_store','issued','allotted'].indexOf(t.status)>-1&&(canGarudaStore()||canGarudaSite());
  const nextRole=t.status==='in_store'||t.status==='consumed'?'store':(t.status==='issued'||t.status==='allotted'?'site':'');
  const roleNote=(!actions&&nextRole)?'<div class="hint" style="margin-top:12px">The next step ('+(t.status==='in_store'?'issue':t.status==='issued'?'allot':t.status==='allotted'?'consume':'return')+') needs the <b>'+nextRole+'</b> role. Ask an admin to grant it.</div>':'';
  modal({title:t.id,
    body:'<div class="kv" style="margin-top:0"><dt>Item</dt><dd>'+esc(t.item_name||'')+'</dd>'+
      '<dt>ERP code</dt><dd>'+esc(t.item_code||'—')+'</dd>'+
      '<dt>Status</dt><dd><span class="tag '+st[0]+'">'+st[1]+'</span></dd>'+
      (t.po_no?'<dt>PO</dt><dd>'+esc(t.po_no)+'</dd>':'')+
      (t.grn_no?'<dt>GRN</dt><dd>'+esc(t.grn_no)+'</dd>':'')+
      (t.vendor?'<dt>Vendor</dt><dd>'+esc(t.vendor)+'</dd>':'')+
      (t.rate?'<dt>Rate</dt><dd>'+esc(t.rate)+'</dd>':'')+
      (t.station_no?'<dt>Station</dt><dd>'+esc(t.station_no)+'</dd>':'')+
      (t.issued_to?'<dt>Issued to</dt><dd>'+esc(t.issued_to)+'</dd>':'')+
      (t.issued_at?'<dt>Issue date</dt><dd>'+esc(fmtD(ts(t.issued_at)))+'</dd>':'')+
      (t.issued_by_name?'<dt>Issued by</dt><dd>'+esc(t.issued_by_name)+'</dd>':'')+
      (t.allotted_by_name?'<dt>Allotted by</dt><dd>'+esc(t.allotted_by_name)+'</dd>':'')+
      (t.consumed_by_name?'<dt>Consumed by</dt><dd>'+esc(t.consumed_by_name)+'</dd>':'')+
      (t.consume_remark?'<dt>Remark</dt><dd>'+esc(t.consume_remark)+'</dd>':'')+
      (t.returned_by_name?'<dt>Accepted by</dt><dd>'+esc(t.returned_by_name)+'</dd>':'')+
      (t.replaced_from?'<dt>Replaces</dt><dd><button class="btn ghost sm" data-goto="'+esc(t.replaced_from)+'" style="padding:0;color:var(--indigo)">'+esc(t.replaced_from)+'</button></dd>':'')+
      (replacedBy?'<dt>Replaced by</dt><dd><button class="btn ghost sm" data-goto="'+esc(replacedBy.id)+'" style="padding:0;color:var(--indigo)">'+esc(replacedBy.id)+'</button></dd>':'')+'</div>'+
      '<div class="grid" style="gap:9px;margin-top:14px">'+actions+(canReplace?'<button class="btn" data-act="replace">Replace a damaged sticker</button>':'')+'</div>'+roleNote+
      (hist?'<div class="sep" style="margin:14px 0 8px"></div><div class="hint" style="font-weight:600">History</div>'+hist:'')+
      '<div id="tp-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>',
    footer:'<button class="btn" data-x>Close</button>',
    onOpen:(mv,cl)=>{ $$('[data-act]',mv).forEach(b=>b.onclick=()=>{const a=b.dataset.act;
      if(a==='issue') cngIssueDialog(t,cl);
      else if(a==='allot') cngAllotDialog(t,cl);
      else if(a==='consume') cngConsumeDialog(t,cl);
      else if(a==='return') cngReturnDialog(t,cl);
      else if(a==='replace') cngReplaceDialog(t,cl); });
      $$('[data-goto]',mv).forEach(b=>b.onclick=()=>{ const c=b.dataset.goto; cl(); setTimeout(()=>cngTagPanel(c),0); }); }});
}
async function cngDo(fn,args,close){ busy(true);
  try{ await rpc(fn,args); if(close)close(); await cngReload(); toast('Updated.','ok'); }
  catch(e){ fail(e); } finally{ busy(false); } }
function cngIssueDialog(t,parentClose){
  modal({title:'Issue '+t.id,
    body:'<p class="hint" style="margin-top:0">Issue this QR from the store.</p>'+
      '<div class="grid g2" style="gap:10px"><div><label for="is-stn">Station</label><input id="is-stn" list="cng-stn-dl" placeholder="Station number" autocomplete="off"><datalist id="cng-stn-dl">'+(DB.garudaStations||[]).map(s=>'<option value="'+esc(s.no)+'">'+esc(s.name)+'</option>').join('')+'</datalist></div>'+
      '<div><label for="is-date">Issue date</label><input id="is-date" type="date" value="'+esc(DAY())+'"></div>'+
      '<div><label for="is-to">Issued to</label><input id="is-to" type="text" placeholder="Person / technician taking it"></div>'+
      '<div><label for="is-by">Issued by</label><input id="is-by" type="text" value="'+esc((ME&&ME.name)||'')+'" placeholder="Who is issuing it"></div></div>'+
      '<div id="is-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="is-go">Issue</button>',
    onOpen:(mv,cl)=>{ $('#is-go',mv).onclick=async()=>{ const stn=$('#is-stn',mv).value.trim(), to=$('#is-to',mv).value.trim(), by=$('#is-by',mv).value.trim(), dt=$('#is-date',mv).value||null;
      if(!stn) return $('#is-err',mv).textContent='Choose a station.'; if(!to) return $('#is-err',mv).textContent='Enter who it is issued to.';
      busy(true); try{ await rpc('cng_issue',{p_tag:t.id,p_station:stn,p_to:to,p_by_name:by,p_issue_date:dt}); cl(); if(parentClose)parentClose(); await cngReload(); toast('Issued.','ok'); }
      catch(e){ busy(false); $('#is-err',mv).textContent=(e.message||'').replace(/^.*?: /,''); return; } busy(false); }; }});
}
/* Allot at facility — who allotted it, and an optional item photo */
function cngAllotDialog(t,parentClose){
  modal({title:'Allot '+t.id,
    body:'<p class="hint" style="margin-top:0">Mark this QR fitted at the station. The time is saved automatically.</p>'+
      '<div><label for="al-by">Allotted by</label><input id="al-by" type="text" value="'+esc((ME&&ME.name)||'')+'" placeholder="Who fitted it"></div>'+
      '<div style="margin-top:10px"><label for="al-photo">Item photo <span class="hint" style="font-weight:400">optional</span></label><input id="al-photo" type="file" accept="image/*" capture="environment"></div>'+
      '<div id="al-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="al-go">Mark allotted</button>',
    onOpen:(mv,cl)=>{ $('#al-go',mv).onclick=async()=>{ const by=$('#al-by',mv).value.trim(); const f=$('#al-photo',mv).files[0];
      busy(true); try{ let path='';
        if(f){ path=ME.id+'/garuda-'+t.id+'-'+uid()+'.jpg'; const {error}=await SB.storage.from('documents').upload(path,f,{contentType:f.type||'image/jpeg',upsert:false}); if(error){ path=''; } }
        await rpc('cng_allot',{p_tag:t.id,p_photo:path,p_by_name:by}); cl(); if(parentClose)parentClose(); await cngReload(); toast('Allotted.','ok'); }
      catch(e){ busy(false); $('#al-err',mv).textContent=(e.message||'').replace(/^.*?: /,''); return; } busy(false); }; }});
}
/* Consume on site — who consumed it, and a short remark */
function cngConsumeDialog(t,parentClose){
  modal({title:'Consume '+t.id,
    body:'<p class="hint" style="margin-top:0">Mark the old part used on site.</p>'+
      '<div><label for="cs-by">Consumed by</label><input id="cs-by" type="text" value="'+esc((ME&&ME.name)||'')+'" placeholder="Who removed it"></div>'+
      '<div style="margin-top:10px"><label for="cs-rmk">Remark</label><input id="cs-rmk" type="text" placeholder="e.g. worn out, leaking"></div>'+
      '<div id="cs-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="cs-go">Mark consumed</button>',
    onOpen:(mv,cl)=>{ $('#cs-go',mv).onclick=async()=>{ const by=$('#cs-by',mv).value.trim(), rmk=$('#cs-rmk',mv).value.trim();
      busy(true); try{ await rpc('cng_consume',{p_tag:t.id,p_remark:rmk,p_by_name:by}); cl(); if(parentClose)parentClose(); await cngReload(); toast('Consumed.','ok'); }
      catch(e){ busy(false); $('#cs-err',mv).textContent=(e.message||'').replace(/^.*?: /,''); return; } busy(false); }; }});
}
/* Warehouse accept — who accepted the old part back */
function cngReturnDialog(t,parentClose){
  modal({title:'Accept return '+t.id,
    body:'<p class="hint" style="margin-top:0">Accept the old part back at the warehouse. It is not put back as new stock.</p>'+
      '<div><label for="rt-by">Accepted by</label><input id="rt-by" type="text" value="'+esc((ME&&ME.name)||'')+'" placeholder="Who accepted it"></div>'+
      '<div id="rt-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="rt-go">Accept return</button>',
    onOpen:(mv,cl)=>{ $('#rt-go',mv).onclick=async()=>{ const by=$('#rt-by',mv).value.trim();
      busy(true); try{ await rpc('cng_return',{p_tag:t.id,p_by_name:by}); cl(); if(parentClose)parentClose(); await cngReload(); toast('Return accepted.','ok'); }
      catch(e){ busy(false); $('#rt-err',mv).textContent=(e.message||'').replace(/^.*?: /,''); return; } busy(false); }; }});
}
function cngReplaceDialog(t,parentClose){
  modal({title:'Replace '+t.id,
    body:'<p class="hint" style="margin-top:0">Retire this damaged sticker and make a fresh QR for the same item. The new code carries the same item and its current state.</p>'+
      '<div><label for="rp-why">Why</label><textarea id="rp-why" placeholder="e.g. sticker torn / unreadable"></textarea></div><div id="rp-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="rp-go">Replace</button>',
    onOpen:(mv,cl)=>{ $('#rp-go',mv).onclick=async()=>{ const why=$('#rp-why',mv).value.trim(); if(why.length<3) return $('#rp-err',mv).textContent='Give a short reason.';
      busy(true); try{ const {data,error}=await SB.rpc('cng_replace',{p_tag:t.id,p_reason:why}); if(error) throw error;
        cl(); if(parentClose)parentClose(); await cngReload(); busy(false); toast('New QR: '+data,'ok'); setTimeout(()=>cngTagPanel(data),300); }
      catch(e){ busy(false); $('#rp-err',mv).textContent=(e.message||'').replace(/^.*?: /,''); } }; }});
}
/* load a QR renderer on demand (no change to index.html) */
let _qrLibP=null;
function ensureQR(){ if(window.QRCode) return Promise.resolve();
  if(!_qrLibP) _qrLibP=new Promise((res,rej)=>{ const sc=document.createElement('script');
    sc.src='https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'; sc.onload=()=>res(); sc.onerror=()=>rej(new Error('QR load failed')); document.head.appendChild(sc); });
  return _qrLibP; }
function qrLotDialog(lotId){
  const lot=(DB.garudaLots||[]).find(l=>l.id===lotId), tags=(DB.garudaTags||[]).filter(t=>t.lot_id===lotId);
  if(!tags.length) return toast('No QR codes for this line.','bad');
  modal({title:'QR codes — '+(lot?lot.item_code:''),
    body:'<div class="hint" style="margin:0 0 10px">'+tags.length+' sticker'+(tags.length>1?'s':'')+(lot&&lot.item_name?' · '+esc(lot.item_name):'')+'. Scan from the screen, or print.</div>'+
      '<div id="qr-grid" class="row" style="gap:12px;flex-wrap:wrap;justify-content:center"></div>',
    footer:'<button class="btn" data-x>Close</button><button class="btn primary" id="qr-print">Print</button>',
    onOpen:(mv,cl)=>{ const grid=$('#qr-grid',mv); const printCells=[];
      ensureQR().then(()=>{ tags.forEach(t=>{ const cell=document.createElement('div'); cell.className='qr-cell';
          cell.style.cssText='text-align:center;padding:8px;border:1px solid var(--line);border-radius:8px';
          const box=document.createElement('div'); cell.appendChild(box);
          try{ new QRCode(box,{text:garTagUrl(t.id),width:118,height:118,correctLevel:QRCode.CorrectLevel.M}); }catch(e){}
          const cap=document.createElement('div'); cap.className='num'; cap.style.cssText='margin-top:6px;font-size:12px;font-weight:600'; cap.textContent=t.id; cell.appendChild(cap);
          grid.appendChild(cell);
          let durl=''; try{ const cv=box.querySelector('canvas'); durl=cv?cv.toDataURL('image/png'):((box.querySelector('img')||{}).src||''); }catch(e){}
          printCells.push('<div class="qr-cell"><img src="'+durl+'"><div>'+esc(t.id)+'</div></div>'); }); })
        .catch(()=>{ grid.innerHTML='<p class="hint">Could not load the QR renderer — check the connection and reopen.</p>'; });
      if($('#qr-print',mv)) $('#qr-print',mv).onclick=()=>{ if(!printCells.length) return toast('QR codes are still rendering — try again in a second.','bad');
        const w=window.open('','_blank'); if(!w) return toast('Allow pop-ups to print.','bad');
        w.document.write('<html><head><title>QR codes</title><style>body{font-family:sans-serif;display:flex;flex-wrap:wrap;gap:12px;padding:12px}.qr-cell{text-align:center;border:1px solid #ccc;border-radius:8px;padding:8px}.qr-cell img{width:118px;height:118px}.qr-cell div{font-size:12px;margin-top:6px;font-weight:600}</style></head><body>'+printCells.join('')+'</body></html>');
        w.document.close(); setTimeout(()=>{ try{ w.print(); }catch(e){} },500); };
    }});
}

/* a plain picker for files that are read in the browser and never stored */
function localPicker(mount,label,onFile){
  mount.innerHTML='<div class="drop" tabindex="0" role="button">'+esc(label)+'</div><input type="file" class="hide" accept=".xlsx,.xls">';
  const inp=$('input',mount), drop=$('.drop',mount);
  drop.onclick=()=>inp.click(); drop.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();inp.click()}};
  inp.onchange=async e=>{const f=e.target.files[0]; inp.value=''; if(f) await onFile(f)};
}

/* ============================================================
   Gate Pass
   A live selfie is the signature. There is no upload and no gallery:
   the camera opens, a frame is taken here and now, and the server
   stamps the time it arrives. Photos are wiped after 7 days; the
   record of who signed, and when, is permanent.
   ============================================================ */
let gpDraft=null, gateTab='desk', gateKindFilter='all';
async function selfieUpload(blob){
  const path=ME.id+'/gate-'+uid()+'.jpg';
  const {error}=await SB.storage.from('documents').upload(path,blob,{contentType:'image/jpeg',upsert:false});
  if(error) throw error;
  // the ~240px list thumbnail is made and uploaded IN THE BACKGROUND, so the person
  // isn't kept waiting for a second upload. If it isn't ready yet, lists just fall
  // back to the full photo. Best-effort.
  (async()=>{ try{ const tb=await downscaleToJpeg(blob,240,0.7);
    if(tb) await SB.storage.from('documents').upload(thumbOf(path),tb,{contentType:'image/jpeg',upsert:false}); }catch(e){} })();
  return path;
}
/* shrink any picked/captured image to a <=edge jpeg (strips EXIF, caps size) */
async function downscaleToJpeg(fileOrBlob,edge,q){
  const url=URL.createObjectURL(fileOrBlob);
  try{
    const img=await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>rej(new Error('image')); i.src=url; });
    const w=img.naturalWidth||img.width||720, h=img.naturalHeight||img.height||720, scale=Math.min(1,(edge||1000)/Math.max(w,h));
    const cv=document.createElement('canvas'); cv.width=Math.max(1,Math.round(w*scale)); cv.height=Math.max(1,Math.round(h*scale));
    cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
    return await new Promise(res=>cv.toBlob(res,'image/jpeg',q||0.82));
  } finally { URL.revokeObjectURL(url); }
}
/* fallback when the live WebView camera is blocked: take the photo with the
   phone's own camera app via a file input. This works even when the app was
   built without the WebRTC camera permission, because the OS camera app (not
   SETU) takes the picture. Resolves to a jpeg Blob, or null if cancelled. */
function nativeCameraCapture(){
  return new Promise(resolve=>{
    const inp=document.createElement('input');
    inp.type='file'; inp.accept='image/*'; inp.setAttribute('capture','user');
    inp.style.position='fixed'; inp.style.left='-9999px'; inp.style.top='0';
    let settled=false; const done=v=>{ if(settled)return; settled=true; window.removeEventListener('focus',onFocus); try{document.body.removeChild(inp)}catch(e){}; resolve(v); };
    inp.onchange=async()=>{ const f=inp.files&&inp.files[0]; if(!f) return done(null);
      try{ done(await downscaleToJpeg(f,1000,0.82)); }catch(e){ done(null); } };
    // if the picker is dismissed, the window regains focus with no file chosen
    const onFocus=()=>setTimeout(()=>{ if(!settled && !(inp.files&&inp.files.length)) done(null); },1200);
    window.addEventListener('focus',onFocus);
    document.body.appendChild(inp); inp.click();
  });
}
/* ---- selfie look: fixed orientation + gentle filters ----
   The phone's front camera delivers a MIRRORED feed. Standard selfie behaviour:
   - the LIVE framing view is left mirror-like (the raw feed, no transform) so it
     feels like a mirror and the person frames themselves without tilting;
   - on CAPTURE the frame is flipped (mirror=true) so the SAVED photo and the
     confirm preview are the true way round — as others see them, so writing on a
     badge or shirt reads correctly, and the face stays usable as identity proof.
   There is no flip button. Filters are mild light-and-colour looks only. */
const SF_FILTERS=[
  {id:'natural',label:'Natural',css:''},
  {id:'bright', label:'Bright', css:'brightness(1.12) contrast(1.04) saturate(1.08)'},
  {id:'glow',   label:'Glow',   css:'brightness(1.08) contrast(0.94) saturate(1.12) blur(0.5px)',tint:'rgba(255,196,170,.24)'},
  {id:'warm',   label:'Warm',   css:'sepia(0.15) saturate(1.18) brightness(1.04)',tint:'rgba(255,166,77,.22)'},
  {id:'cool',   label:'Cool',   css:'saturate(0.96) contrast(1.06) brightness(1.04)',tint:'rgba(86,156,255,.22)'},
  {id:'vivid',  label:'Vivid',  css:'contrast(1.12) saturate(1.35)'},
  {id:'mono',   label:'B&W',    css:'grayscale(1) contrast(1.12) brightness(1.04)'},
  {id:'retro',  label:'Retro',  css:'sepia(0.35) contrast(0.92) brightness(1.06) saturate(0.9)',tint:'rgba(255,214,170,.2)'}
];
const sfFilter=id=>SF_FILTERS.find(f=>f.id===id)||SF_FILTERS[0];
const sfPref={ get(k,d){ try{ const v=localStorage.getItem('setu.selfie.'+k); return v==null?d:v; }catch(e){ return d; } },
               set(k,v){ try{ localStorage.setItem('setu.selfie.'+k,String(v)); }catch(e){} } };
// Android / Chrome draw CSS filters straight onto a canvas; older iPhones get the same look pixel by pixel
const SF_CTX_FILTER=typeof CanvasRenderingContext2D!=='undefined' && 'filter' in CanvasRenderingContext2D.prototype;
function sfPixelFilter(ctx,w,h,css){
  const steps=[]; css.replace(/(brightness|contrast|saturate|sepia|grayscale)\(([\d.]+)\)/g,(_,n,v)=>{ steps.push({n,a:parseFloat(v)}); return ''; });
  if(!steps.length) return;
  for(const s of steps){ const a=(s.n==='sepia'||s.n==='grayscale')?Math.min(1,s.a):s.a, r=1-a;
    s.m= s.n==='saturate'  ? [.213+.787*a,.715-.715*a,.072-.072*a, .213-.213*a,.715+.285*a,.072-.072*a, .213-.213*a,.715-.715*a,.072+.928*a]
       : s.n==='grayscale' ? [.2126+.7874*r,.7152-.7152*r,.0722-.0722*r, .2126-.2126*r,.7152+.2848*r,.0722-.0722*r, .2126-.2126*r,.7152-.7152*r,.0722+.9278*r]
       : s.n==='sepia'     ? [.393+.607*r,.769-.769*r,.189-.189*r, .349-.349*r,.686+.314*r,.168-.168*r, .272-.272*r,.534-.534*r,.131+.869*r]
       : null; }
  const img=ctx.getImageData(0,0,w,h), d=img.data, cl=v=>v<0?0:v>255?255:v;
  for(let i=0;i<d.length;i+=4){ let r=d[i],g=d[i+1],b=d[i+2];
    for(const s of steps){
      if(s.n==='brightness'){ r=cl(r*s.a); g=cl(g*s.a); b=cl(b*s.a); }
      else if(s.n==='contrast'){ r=cl((r-127.5)*s.a+127.5); g=cl((g-127.5)*s.a+127.5); b=cl((b-127.5)*s.a+127.5); }
      else { const m=s.m, R=r, G=g, B=b; r=cl(m[0]*R+m[1]*G+m[2]*B); g=cl(m[3]*R+m[4]*G+m[5]*B); b=cl(m[6]*R+m[7]*G+m[8]*B); }
    }
    d[i]=r; d[i+1]=g; d[i+2]=b; }
  ctx.putImageData(img,0,0);
}
/* draws a frame (camera, photo or canvas) with the chosen orientation and filter, <= edge px */
function sfRender(src,sw,sh,f,mirror,edge){
  const sc=Math.min(1,(edge||1000)/Math.max(sw,sh));
  const cv=document.createElement('canvas'); cv.width=Math.max(1,Math.round(sw*sc)); cv.height=Math.max(1,Math.round(sh*sc));
  const ctx=cv.getContext('2d');
  if(mirror){ ctx.translate(cv.width,0); ctx.scale(-1,1); }
  ctx.drawImage(src,0,0,cv.width,cv.height);
  // the filtered frame goes over the plain one, so a soft (Glow) edge never turns dark
  if(f.css&&SF_CTX_FILTER){ ctx.filter=f.css; ctx.drawImage(src,0,0,cv.width,cv.height); ctx.filter='none'; }
  ctx.setTransform(1,0,0,1,0,0);
  if(f.css&&!SF_CTX_FILTER) sfPixelFilter(ctx,cv.width,cv.height,f.css);
  if(f.tint){ ctx.globalCompositeOperation='soft-light'; ctx.fillStyle=f.tint; ctx.fillRect(0,0,cv.width,cv.height); ctx.globalCompositeOperation='source-over'; }
  return cv;
}
/* a small centre square of the frame, for the round filter previews */
function sfSnap(src,sw,sh){ const s=Math.min(sw,sh), cv=document.createElement('canvas'); cv.width=cv.height=96;
  cv.getContext('2d').drawImage(src,(sw-s)/2,(sh-s)/2,s,s,0,0,96,96); return cv.toDataURL('image/jpeg',0.7); }
const sfChips=cur=>'<div class="sf-filters" role="radiogroup" aria-label="Photo filter">'+SF_FILTERS.map(f=>
  '<button type="button" class="sf-chip'+(f.id===cur?' on':'')+'" data-sf="'+f.id+'" role="radio" aria-checked="'+(f.id===cur)+'">'+
  '<span class="sf-thumb"><img alt=""'+(f.css?' style="filter:'+f.css+'"':'')+'>'+(f.tint?'<i style="background:'+f.tint+'"></i>':'')+'</span>'+esc(f.label)+'</button>').join('')+'</div>';
const blobToImage=b=>new Promise((res,rej)=>{ const u=URL.createObjectURL(b), i=new Image();
  i.onload=()=>{ URL.revokeObjectURL(u); res(i); }; i.onerror=()=>{ URL.revokeObjectURL(u); rej(new Error('image')); }; i.src=u; });

/* opens the front camera, lets you capture and confirm one frame (choosing a
   look and the left–right orientation), uploads it, and resolves to the stored
   path (or null if the person backed out) */
function captureSelfie(title){
  return new Promise(resolve=>{
    let stream=null, path=null, done=false;
    let raw=null;              // the captured frame: true orientation, no filter
    let src='live';            // 'live' camera in the app, or 'native' (the phone's camera app)
    let mode='';               // 'live' view or 'preview' of the captured frame
    let filt=sfFilter(sfPref.get('filter','natural'));
    const LIVE_MSG='Fit your face inside the circle and look at the camera. The photo is live and time-stamped — it cannot be uploaded, and a held-up photograph will not line up in the ring.';
    const finish=v=>{ if(done)return; done=true; if(stream)stream.getTracks().forEach(t=>t.stop()); resolve(v); };
    modal({title:title||'Take a live selfie',cls:'selfie',
      body:'<div id="sf-stage" class="selfie-stage"><div class="selfie-hint"><span class="spin"></span> Starting the camera…</div></div>'+
           '<div id="sf-look" hidden>'+sfChips(filt.id)+'</div>'+
           '<div id="sf-msg" class="hint" style="margin-top:8px;text-align:center">'+LIVE_MSG+'</div>',
      footer:'<button class="btn" data-x>Cancel</button><button class="btn" id="sf-retake" style="display:none">Retake</button><button class="btn primary" id="sf-shoot" disabled>Capture</button>',
      onOpen:(v,cl)=>{
        const stage=$('#sf-stage',v), look=$('#sf-look',v), msg=$('#sf-msg',v), shoot=$('#sf-shoot',v), retake=$('#sf-retake',v);
        const obs=new MutationObserver(()=>{ if(!v.isConnected){ obs.disconnect(); finish(path) } });
        obs.observe(v.parentNode||document.body,{childList:true});
        const render=()=>sfRender(raw,raw.width,raw.height,filt,false,1000);
        // apply the current look to whatever is on screen
        const applyLook=()=>{
          look.querySelectorAll('.sf-chip').forEach(c=>{ const on=c.dataset.sf===filt.id; c.classList.toggle('on',on); c.setAttribute('aria-checked',String(on));
          });
          if(mode==='live'){
            const video=$('video.selfie-video',stage), tint=$('.sf-tint',stage);
            if(video){ video.style.transform=''; video.style.filter=filt.css||''; }
            if(tint) tint.style.background=filt.tint||'transparent';
          }else if(mode==='preview'&&raw){
            const img=$('img.selfie-video',stage); if(img) img.src=render().toDataURL('image/jpeg',0.85);
          }
        };
        // bring the remembered look into view the first time the row shows
        let centred=false; const centreChip=()=>{ if(centred) return; centred=true; const strip=$('.sf-filters',look), on=$('.sf-chip.on',look); if(!strip||!on) return;
          const a=strip.getBoundingClientRect(), b=on.getBoundingClientRect(); strip.scrollLeft+=(b.left+b.width/2)-(a.left+a.width/2); };
        const paintChips=(el,w,h)=>{ try{ const u=sfSnap(el,w,h); look.querySelectorAll('.sf-thumb img').forEach(im=>{ im.src=u; }); }catch(e){} };
        look.addEventListener('click',e=>{ const c=e.target.closest('.sf-chip'); if(!c) return;
          filt=sfFilter(c.dataset.sf); sfPref.set('filter',filt.id); applyLook(); });
        // the captured frame, ready to check: change the look or flip it, then use it
        const showPreview=()=>{ mode='preview';
          stage.innerHTML='<img class="selfie-video" alt="selfie preview">';
          look.hidden=false; centreChip(); paintChips(raw,raw.width,raw.height); applyLook();
          shoot.style.display=''; shoot.disabled=false; shoot.textContent='Use this photo'; shoot.dataset.mode='use'; retake.style.display='';
          if(msg) msg.textContent='This is exactly how the photo will be saved. Pick a look you like, then use the photo.';
        };
        // take the shot with the phone's camera app when the live camera can't start
        const useNative=async()=>{
          const blob=await nativeCameraCapture(); if(!blob) return;   // cancelled — leave what's on screen
          try{ const img=await blobToImage(blob); raw=sfRender(img,img.naturalWidth||img.width,img.naturalHeight||img.height,SF_FILTERS[0],false,1000); }
          catch(e){ return showCamErr('Could not read that photo. Try again.'); }
          src='native'; showPreview();
        };
        // render a camera error with a one-tap fallback to the phone camera app
        function showCamErr(html){ mode=''; look.hidden=true;
          stage.innerHTML='<div class="selfie-err">'+html+'</div>'+
            '<button class="btn primary" id="sf-native" style="margin-top:12px;width:100%">📷 Use phone camera</button>'+
            '<div class="hint" style="margin-top:7px;text-align:center">This opens your phone’s camera to take the selfie now. To get the live circle guide back, allow Camera for SETU and reopen the app.</div>';
          shoot.style.display='none'; retake.style.display='none'; if(msg) msg.textContent='';
          const nb=$('#sf-native',stage); if(nb) nb.onclick=useNative;
        }
        const showLive=()=>{ src='live'; mode='live';
          const video=document.createElement('video'); video.autoplay=true; video.playsInline=true; video.setAttribute('playsinline','');
          video.muted=true; video.className='selfie-video'; video.srcObject=stream; stage.innerHTML=''; stage.appendChild(video); video.play().catch(()=>{});
          const tint=document.createElement('div'); tint.className='sf-tint'; stage.appendChild(tint);   // colour wash for the Warm / Cool / Glow / Retro looks
          const ring=document.createElement('div'); ring.className='selfie-ring'; stage.appendChild(ring);   // face guide: a real face fills the oval, a held-up photo won't line up
          look.hidden=false; centreChip(); applyLook();
          // once real frames arrive, put a still of the person in each round filter preview
          video.addEventListener('playing',()=>setTimeout(()=>{ if(video.isConnected&&video.videoWidth) paintChips(video,video.videoWidth,video.videoHeight); },350),{once:true});
          if(msg) msg.textContent=LIVE_MSG;
          shoot.style.display=''; shoot.textContent='Capture'; shoot.dataset.mode='cap'; shoot.disabled=false; retake.style.display='none'; };
        (async()=>{
          const md=navigator.mediaDevices;
          if(!md||!md.getUserMedia){
            const secure=window.isSecureContext!==false && location.protocol==='https:';
            showCamErr('The live camera isn’t available to the app.'+
              '<div class="hint" style="margin-top:6px">'+(secure
                ? 'This app build was not given camera access, so the live view can’t start. Use the phone camera below for now; to restore the live circle, the app needs to be rebuilt with Camera enabled.'
                : 'The page must be opened over a secure (https) connection for the live camera to work.')+'</div>');
            return;
          }
          // try the front camera; fall back to any camera if the WebView rejects the constraints
          const tries=[{video:{facingMode:{ideal:'user'}},audio:false},{video:{facingMode:'user'},audio:false},{video:true,audio:false}];
          let err=null;
          for(const c of tries){ try{ stream=await md.getUserMedia(c); err=null; break; }catch(e){ err=e; } }
          if(done){ if(stream) stream.getTracks().forEach(t=>t.stop()); return; }   // closed while the camera was starting
          if(!stream){
            const name=(err&&(err.name||err.message))||'unknown';
            const why=/NotAllowed|Security|Permission/i.test(name)
                ? 'The live camera was blocked for this app build. Use the phone camera below for now. To restore the live circle, the app needs Camera enabled in its build (or, if a Camera toggle shows under phone Settings → Apps → SETU → Permissions, allow it and reopen).'
              : /NotFound|Overconstrained/i.test(name) ? 'No usable camera was found on this device.'
              : /NotReadable|InUse|Track/i.test(name) ? 'The camera is busy in another app. Close other camera apps and try again.'
              : 'The live camera could not start ('+esc(String(name))+').';
            showCamErr('Live camera didn’t open.<div class="hint" style="margin-top:6px">'+why+'</div>');
            return;
          }
          showLive();
        })();
        shoot.onclick=async()=>{
          if(shoot.dataset.mode==='use'){
            shoot.disabled=true; retake.style.display='none'; msg.textContent='Saving…';
            try{ const blob=await new Promise(res=>render().toBlob(res,'image/jpeg',0.85)); path=await selfieUpload(blob); cl(); }
            catch(e){ msg.textContent='Could not save the photo. Try again.'; shoot.disabled=false; retake.style.display=''; }
            return;
          }
          const video=$('video.selfie-video',stage); if(!video||!video.videoWidth) return;
          raw=sfRender(video,video.videoWidth,video.videoHeight,SF_FILTERS[0],true,1000);   // flip the mirrored front-camera frame → true orientation (as others see you); look applied on save
          showPreview();
        };
        retake.onclick=()=>{ if(src==='native') useNative(); else showLive(); };
      }});
  });
}
async function showSelfie(path,label){
  if(!path){ toast('That photo was kept for 7 days and has since been wiped.','hold'); return; }
  const {el}=modal({title:label||'Selfie',cls:'selfie',body:'<div id="sv-stage" class="selfie-stage"><span class="spin"></span></div>'+
    '<div class="hint" style="margin-top:8px;text-align:center">Selfies are removed 7 days after the pass; the approval record stays.</div>'});
  try{ const url=await imgURL(path);   // full photo, downloaded once per session
    if($('#sv-stage',el)) $('#sv-stage',el).innerHTML='<img class="selfie-video" src="'+url+'" alt="selfie">'; }
  catch(e){ if($('#sv-stage',el)) $('#sv-stage',el).innerHTML='<div class="selfie-err">This photo is no longer available.</div>'; }
}
const gpDuration=(a,b)=>{ if(!a||!b) return ''; let s=Math.max(0,Math.round((b-a)/1000)); const h=Math.floor(s/3600), m=Math.floor(s%3600/60);
  return (h?h+'h ':'')+m+'m'; };
function gpTimeline(g){
  const row=(ok,label,who,when,selfie,slabel)=>'<div class="gp-step '+(ok?'done':'')+'"><span class="gp-dot"></span><div style="flex:1;min-width:0"><b>'+esc(label)+'</b>'+
    (who?'<div class="hint">'+esc(who)+(when?' · '+esc(fmtDT(when)):'')+'</div>':'')+'</div>'+
    (selfie!==undefined?'<button class="btn sm" data-selfie="'+esc(selfie||'')+'" data-slabel="'+esc(slabel||'')+'"'+(selfie?'':' disabled')+'>Selfie</button>':'')+'</div>';
  const gm=g.gateBy?user(g.gateBy):null, req=user(g.requesterId);
  const hodLbl=g.hodId?'HOD — '+user(g.hodId).name:'HOD sign', hrLbl=g.hrId?'HR — '+user(g.hrId).name:'HR sign';
  let h='<div class="gp-timeline">';
  h+=row(true,'Raised',req.name,g.createdAt,g.reqSelfie,req.name+' — at creation');
  h+=row(!!g.hodAt,hodLbl,g.hodAt?'Signed':(g.status==='rejected'&&g.rejectBy===g.hodId?'Declined':'Waiting'),g.hodAt,g.hodSelfie,(g.hodId?user(g.hodId).name:'HOD')+' — HOD');
  h+=row(!!g.hrAt,hrLbl,g.hrAt?'Signed':(g.status==='rejected'&&g.rejectBy===g.hrId?'Declined':'Waiting'),g.hrAt,g.hrSelfie,(g.hrId?user(g.hrId).name:'HR')+' — HR');
  if(g.kind==='official'){
    h+=row(!!g.outAt,'Out at gate',gm?gm.name:'',g.outAt);
    h+=row(!!g.returnAt,'Returned',g.returnAt?(gpDuration(g.outAt,g.returnAt)+' out'):'Not back yet',g.returnAt);
  }else{
    h+=row(!!g.outAt,'Signed out at gate',gm?gm.name:'',g.outAt);
  }
  if(g.status==='rejected') h+='<div class="banner bad" style="margin-top:8px"><div><b>Declined by '+esc(user(g.rejectBy).name)+'</b>'+(g.rejectReason?'<div class="hint" style="color:var(--stop)">'+esc(g.rejectReason)+'</div>':'')+'</div></div>';
  h+='</div>'; return h;
}
function gpCard(g,acts){
  return '<div class="card gp-card"><div class="row" style="padding:13px 16px;gap:10px;flex-wrap:wrap;border-bottom:1px solid var(--line)">'+
    '<div style="min-width:0"><b>'+esc(g.name||user(g.requesterId).name)+'</b> <span class="hint">'+esc(g.ref)+'</span>'+
    '<div class="hint">'+esc(gpKindLabel(g))+' · '+esc(fmtD(g.createdAt))+(g.dept?' · '+esc(g.dept):'')+'</div></div>'+
    '<span style="margin-left:auto">'+gpTag(g)+'</span></div>'+
    '<div style="padding:12px 16px"><div class="hint" style="margin-bottom:8px"><b>Purpose:</b> '+esc(g.purpose||'—')+'</div>'+
    gpTimeline(g)+(acts?'<div class="row" style="gap:9px;margin-top:12px;flex-wrap:wrap">'+acts+'</div>':'')+'</div></div>';
}
/* gateman console card — the two approval selfies shown side by side, live */
function gpGateCard(g){
  const req=user(g.requesterId), hod=g.hodId?user(g.hodId):null, hr=g.hrId?user(g.hrId):null;
  const label=g.status==='out'?'Record return &amp; close':(g.kind==='official'?'Sign out (records time)':'Approve &amp; close');
  const thumb=(path,cap,sub)=>'<div class="gp-th"><div class="gp-th-img'+(path?'':' gp-th-empty')+'" data-selfiethumb="'+esc(path||'')+'" data-slabel="'+esc(cap)+'">'+
      (path?'<span class="spin"></span>':'<span class="gp-th-none">not signed yet</span>')+'</div>'+
      '<div class="gp-th-cap"><b>'+esc(cap)+'</b>'+(sub?'<div class="hint">'+esc(sub)+'</div>':'')+'</div></div>';
  return '<div class="card gp-card"><div class="row" style="padding:13px 16px;gap:10px;flex-wrap:wrap;border-bottom:1px solid var(--line)">'+
    '<div style="min-width:0"><b>'+esc(g.name||req.name)+'</b> <span class="hint">'+esc(g.ref)+'</span>'+
    '<div class="hint">'+esc(gpKindLabel(g))+(g.dept?' · '+esc(g.dept):'')+' · '+esc(fmtDT(g.createdAt))+'</div></div>'+
    '<span style="margin-left:auto">'+gpTag(g)+'</span></div>'+
    '<div style="padding:12px 16px"><div class="hint" style="margin-bottom:10px"><b>Purpose:</b> '+esc(g.purpose||'—')+'</div>'+
    '<div class="gp-thumbs">'+
      thumb(g.reqSelfie,'Requester',req.name)+
      thumb(g.hodSelfie,'HOD approved',hod?hod.name+' · '+fmtDT(g.hodAt):'')+
      thumb(g.hrSelfie,'HR approved',hr?hr.name+' · '+fmtDT(g.hrAt):'')+
    '</div>'+
    '<div class="row" style="gap:9px;margin-top:12px"><button class="btn primary" data-gate="'+g.id+'">'+label+'</button></div>'+
    (g.status==='out'?'<div class="hint" style="margin-top:7px">Out since '+esc(fmtDT(g.outAt))+'</div>':'')+
    '</div></div>';
}
/* ---- photo data-transfer: each gate photo is downloaded at most ONCE per session
   (not on every screen refresh), and lists use a ~10 KB thumbnail instead of the
   full photo. Passes from before thumbnails existed fall back to the full photo. ---- */
function thumbOf(p){ return String(p||'').replace(/\.jpg$/i,'.t.jpg'); }
function withThumbs(paths){ const out=[]; (paths||[]).forEach(p=>{ if(!p) return; out.push(p); if(/\/gate-[^/]+\.jpg$/i.test(p)&&!/\.t\.jpg$/i.test(p)) out.push(thumbOf(p)); }); return out; }
const IMG_CACHE=new Map();   // storage path -> Promise<object URL>
const IMG_MISS=new Set();    // thumbnail paths known not to exist (older passes)
function imgURL(path){
  if(!IMG_CACHE.has(path)){
    const pr=fetchFile({path}).then(b=>URL.createObjectURL(b));
    pr.catch(()=>IMG_CACHE.delete(path));
    IMG_CACHE.set(path,pr);
  }
  return IMG_CACHE.get(path);
}
async function thumbURL(path){
  const t=thumbOf(path);
  if(t!==path&&!IMG_MISS.has(t)){ try{ return await imgURL(t); }catch(e){ IMG_MISS.add(t); } }
  return imgURL(path);
}
async function loadSelfieThumbs(v){
  for(const el of $$('[data-selfiethumb]',v)){
    const path=el.dataset.selfiethumb; if(!path){ continue; }   // no path = step not signed yet; keep its placeholder
    el.classList.remove('gp-th-retry');
    // a real photo exists at this path. try twice before showing anything scary —
    // with hundreds of users live a single storage call can blip.
    let url=null;
    for(let a=0;a<2&&!url;a++){
      try{ url=await thumbURL(path); }
      catch(e){ if(a===0) await new Promise(r=>setTimeout(r,500)); }
    }
    if(url){
      el.innerHTML='<img src="'+url+'" alt="selfie">'; el.classList.add('has');
      el.onclick=()=>showSelfie(path,el.dataset.slabel||'Selfie'); }
    else {   // the photo is really there in the record, it just didn't load — let them retry, don't imply it's gone
      el.classList.add('gp-th-retry'); el.classList.remove('has');
      el.innerHTML='<span class="gp-th-none">tap to retry</span>';
      el.onclick=()=>{ el.innerHTML='<span class="spin sm"></span>'; loadSelfieThumbs(el.parentElement||v); };
    }
  }
}
/* the requester collects one signature: pick whoever is available for this step,
   hand them the phone, they take a live selfie to approve — or decline */
function getSignFlow(g){
  const role=g.status==='pending_hod'?'HOD':'HR';
  let picked=null;
  const personRow=u=>'<button data-u="'+u.id+'"><div class="av sm">'+inits(u.name)+'</div><div style="min-width:0"><b>'+esc(u.name)+'</b><div class="hint">'+esc(u.role||'')+(u.dept?' · '+esc(u.dept):'')+'</div></div></button>';
  const {el,close}=modal({title:'Get '+role+' signature',body:'<div id="gs-body"></div>',
    onOpen:(mv,cl)=>{ renderPick(mv,cl); }});
  function renderPick(mv,cl){
    const b=$('#gs-body',mv);
    b.innerHTML='<p style="margin-top:0" class="hint">Pick the '+role+' who is signing — whoever is available, not necessarily your own '+role+'.</p>'+
      '<div class="gp-pick"><input type="text" class="gp-search" placeholder="Search by name, department or email"><div class="gp-res"></div></div>';
    const inp=$('input',b), res=$('.gp-res',b); inp.focus();
    inp.oninput=()=>{ const q=inp.value.trim().toLowerCase(); if(!q){res.innerHTML='';return}
      const hits=DB.users.filter(u=>u.active&&u.id!==ME.id&&(g.status!=='pending_hr'||u.id!==g.hodId)&&(u.name+' '+u.email+' '+u.dept+' '+u.role).toLowerCase().includes(q)).slice(0,7);
      res.innerHTML=hits.length?'<div class="results inline">'+hits.map(personRow).join('')+'</div>':'<div class="results inline"><div class="hint" style="padding:12px 14px">Nobody matches that.</div></div>';
      $$('.results button',res).forEach(x=>x.onclick=()=>{picked=user(x.dataset.u);renderHandoff(mv,cl)});
    };
  }
  function renderHandoff(mv,cl){
    const b=$('#gs-body',mv);
    b.innerHTML='<div class="gp-picked"><div class="av sm">'+inits(picked.name)+'</div><div style="flex:1;min-width:0"><b>'+esc(picked.name)+'</b><div class="hint">'+esc(picked.role||'')+(picked.dept?' · '+esc(picked.dept):'')+'</div></div><button class="btn sm" data-change>Change</button></div>'+
      '<div class="banner live" style="margin-top:12px"><div>Hand the phone to <b>'+esc(picked.name)+'</b>. They approve by taking a live selfie, or decline. The time is recorded automatically.</div></div>'+
      '<div class="row" style="gap:9px;margin-top:12px"><button class="btn primary" id="gs-selfie">Take '+role+' selfie</button><button class="btn bad" id="gs-decline">Decline</button></div>'+
      '<div id="gs-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>';
    $('[data-change]',b).onclick=()=>{picked=null;renderPick(mv,cl)};
    $('#gs-selfie',b).onclick=async()=>{ const p=await captureSelfie(picked.name+' — '+role+' approval selfie'); if(!p) return;
      busy(true); try{ await rpc('gp_sign',{p_id:g.id,p_person:picked.id,p_selfie:p}); await load(['gate','notif']); cl(); toast(role+' signed.','ok'); render(); }
      catch(e){ $('#gs-err',b).textContent=(e.message||'').replace(/^.*?: /,''); }finally{ busy(false); } };
    $('#gs-decline',b).onclick=()=>renderDecline(mv,cl);
  }
  function renderDecline(mv,cl){
    const b=$('#gs-body',mv);
    b.innerHTML='<p style="margin-top:0"><b>'+esc(picked.name)+'</b> ('+role+') is declining this pass.</p><div><label for="gs-reason">Reason (optional)</label><textarea id="gs-reason" placeholder="e.g. Not required today."></textarea></div>'+
      '<div class="row" style="gap:9px;margin-top:12px"><button class="btn" id="gs-back">Back</button><button class="btn bad" id="gs-do">Confirm decline</button></div><div id="gs-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>';
    $('#gs-back',b).onclick=()=>renderHandoff(mv,cl);
    $('#gs-do',b).onclick=async()=>{ busy(true);
      try{ await rpc('gp_reject',{p_id:g.id,p_person:picked.id,p_reason:$('#gs-reason',b).value.trim()}); await load(['gate','notif']); cl(); toast('Pass declined.','ok'); render(); }
      catch(e){ $('#gs-err',b).textContent=(e.message||'').replace(/^.*?: /,''); }finally{ busy(false); } };
  }
}
/* ---- compact console row (used for 100s of entries) ---- */
function gpGateBtnLabel(g){ return g.status==='out'?'Return &amp; close':(g.kind==='official'?'Sign out':'Approve &amp; close'); }
function gpRow(g,opts){
  opts=opts||{};
  const names=['Requester','HOD','HR'], sels=[g.reqSelfie,g.hodSelfie,g.hrSelfie];
  const signedAt=[g.createdAt,g.hodAt,g.hrAt];
  const th=sels.map((p,i)=>'<span class="gp-mini'+(p?'':' gp-mini-empty')+'" data-selfiethumb="'+esc(p||'')+'" data-slabel="'+names[i]+' — '+esc(g.name||'')+'" title="'+esc(names[i]+(p?' selfie':(signedAt[i]?' — photo expired':' — not signed yet')))+'">'+(p?'<span class="spin sm"></span>':'<span class="gp-mini-x">'+(signedAt[i]?'·':names[i][0])+'</span>')+'</span>').join('');
  const hodN=g.hodId?user(g.hodId).name:'', hrN=g.hrId?user(g.hrId).name:'';
  const appr=(hodN||hrN)?('HOD '+esc(hodN||'—')+' · HR '+esc(hrN||'—')):'';
  const timeline=g.outAt?(g.returnAt?('out '+fmtT(g.outAt)+' → '+fmtT(g.returnAt)+' ('+gpDuration(g.outAt,g.returnAt)+')'):('out '+fmtT(g.outAt))):'';
  return '<tr data-gp="'+g.id+'"><td class="gp-rth">'+th+'</td>'+
    '<td style="min-width:0"><b>'+esc(g.name||user(g.requesterId).name)+'</b> <span class="hint">'+esc(g.ref)+'</span>'+
      '<div class="hint">'+esc(gpKindLabel(g))+(g.dept?' · '+esc(g.dept):'')+' · '+esc(fmtDT(g.createdAt))+'</div>'+
      (appr?'<div class="hint">'+appr+'</div>':'')+(timeline?'<div class="hint">'+esc(timeline)+'</div>':'')+'</td>'+
    '<td class="meta">'+gpTag(g)+'</td>'+
    (opts.action?'<td class="meta">'+opts.action+'</td>':'')+'</tr>';
}
const gpSection=(title,count,inner)=>'<div class="card" style="margin-bottom:14px"><div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line)"><h3>'+esc(title)+'</h3><span class="tag '+(count?'t-ok':'t-wait')+'" style="margin-left:auto">'+count+'</span></div>'+inner+'</div>';
/* reactive bifurcation bar: one chip per pass type with a live count; tap to filter.
   `base` is the set the counts are drawn from (today's at-gate + cleared). */
function gpKindBar(base){
  const cnt=k=>base.filter(g=>g.kind===k).length;
  const chip=(val,label,n)=>{ const on=gateKindFilter===val;
    return '<button data-gk="'+val+'" style="display:inline-flex;align-items:center;gap:7px;border:1px solid '+(on?'var(--indigo)':'var(--line)')+';background:'+(on?'var(--indigo)':'var(--card,#fff)')+';color:'+(on?'#fff':'inherit')+';border-radius:999px;padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer">'+
      '<span style="display:inline-flex;min-width:20px;height:20px;align-items:center;justify-content:center;border-radius:999px;font-size:12px;line-height:1;padding:0 6px;background:'+(on?'rgba(255,255,255,.26)':'var(--wash,#eef2ff)')+';color:'+(on?'#fff':'var(--indigo)')+'">'+n+'</span>'+esc(label)+'</button>'; };
  return '<div class="row" style="gap:9px;flex-wrap:wrap;align-items:center;margin-bottom:14px">'+
    chip('all','All',base.length)+GP_KINDS.map(k=>chip(k[0],k[1],cnt(k[0]))).join('')+
    '<button class="btn sm" id="gc-xlsx" style="margin-left:auto">⬇ Excel (this view)</button></div>';
}
/* download the currently selected console view (today, filtered by type) */
function gateConsoleExport(){
  if(!window.XLSX){ toast('Spreadsheet engine still loading — try again in a moment.','bad'); return; }
  const fk=gateKindFilter, base=gpAtGate().concat(gpClearedToday());
  const sel=base.filter(g=>fk==='all'||g.kind===fk);
  if(!sel.length) return toast('Nothing in this view to download.','bad');
  const rows=sel.map(gpToObj), ws=XLSX.utils.json_to_sheet(rows), wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Gate '+DAY());
  XLSX.writeFile(wb,'gate-today_'+DAY()+(fk==='all'?'':'_'+fk)+'.xlsx');
  toast('Downloaded '+sel.length+' entr'+(sel.length===1?'y':'ies')+'.','ok');
}
/* the gateman/HR-head console: dense rows, newest live at the top */
function gateConsole(){
  const gm=isGateman(ME);
  let h='';
  if(gm){
    const needsAll=gpAtGate(), doneAll=gpClearedToday();
    const fk=gateKindFilter, keep=g=>fk==='all'||g.kind===fk;
    const needs=needsAll.filter(keep), done=doneAll.filter(keep);
    const suffix=fk==='all'?'':' · '+gpKindLabel(fk);
    h+=gpKindBar(needsAll.concat(doneAll));
    h+=gpSection('At the gate'+suffix,needs.length,
      needs.length
        ? '<div style="padding:10px 16px 0" class="hint">Tap a photo to enlarge. New passes arrive here live.</div><table class="cards gp-dense"><tbody>'+needs.map(g=>gpRow(g,{action:'<button class="btn primary sm" data-gate="'+g.id+'">'+gpGateBtnLabel(g)+'</button>'})).join('')+'</tbody></table>'
        : '<div class="empty" style="padding:24px 16px"><h3>'+(fk==='all'?'No one at the gate right now':'No '+esc(gpKindLabel(fk).toLowerCase())+' at the gate right now')+'</h3><p class="hint">Cleared passes land here the moment HR signs — live.</p></div>');
    h+=gpSection('Cleared today'+suffix,done.length,
      done.length ? '<table class="cards gp-dense"><tbody>'+done.map(g=>gpRow(g,{})).join('')+'</tbody></table>'
        : '<div class="empty" style="padding:18px 16px"><p class="hint">Nothing cleared yet today'+(fk==='all'?'':' in this type')+'.</p></div>');
  } else {
    const all=gpAllToday();
    h+='<div class="hint" style="margin:-2px 0 12px">Live, read-only view of every gate pass today. Full history and graphs are under Reports.</div>'+
      gpSection("Today's gate passes",all.length,
      all.length ? '<table class="cards gp-dense"><tbody>'+all.map(g=>gpRow(g,{})).join('')+'</tbody></table>'
        : '<div class="empty" style="padding:22px 16px"><p class="hint">No passes today yet.</p></div>');
  }
  return h;
}
/* the create form + the signer's own passes (second tab for gatemen/HR heads) */
function gateCreateAndMine(){
  const mine=gpMine(); let h='';
  const next=gpMyNext();
  if(next.length) h+='<div class="card" style="margin-bottom:14px;border-color:var(--indigo)"><div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line)"><h3>Collect your signatures</h3><span class="tag t-prog" style="margin-left:auto">'+next.length+'</span></div>'+
    '<div style="padding:12px 16px" class="hint">Walk up to whichever HOD is free, pick them here and hand over your phone for their selfie. Then do the same with HR.</div>'+
    '<div class="gp-list">'+next.map(g=>gpCard(g,
      '<button class="btn primary" data-getsign="'+g.id+'">'+(g.status==='pending_hod'?'Get HOD sign':'Get HR sign')+'</button>'+
      '<button class="btn bad" data-del="'+g.id+'">Delete</button>')).join('')+'</div></div>';

  // passes I approved (as HOD or HR)
  const signed=gpSignedByMe();
  if(signed.length){
    const groups={}; signed.forEach(g=>{const t=g.hodId===ME.id?g.hodAt:g.hrAt; const k=new Date(t||g.createdAt).toISOString().slice(0,7);(groups[k]=groups[k]||[]).push(g)});
    const months=Object.keys(groups).sort().reverse();
    h+='<div class="card" style="margin-bottom:14px"><div class="row" style="padding:13px 16px;border-bottom:1px solid var(--line)"><h3>Passes you have approved</h3><span class="tag t-ok" style="margin-left:auto">'+signed.length+' signed</span></div>'+
      months.map(m=>{const label=new Date(m+'-01').toLocaleDateString('en-IN',{month:'long',year:'numeric'});const list=groups[m];
        return '<div class="gp-month"><div class="gp-month-h">'+esc(label)+' <span class="hint">· '+list.length+' approved</span></div>'+
          '<table class="cards"><tbody>'+list.map(g=>{const role=gpMyRole(g),when=g.hodId===ME.id?g.hodAt:g.hrAt,sel=g.hodId===ME.id?g.hodSelfie:g.hrSelfie;
            return '<tr><td><b>'+esc(g.name||user(g.requesterId).name)+'</b><div class="hint">'+esc(gpKindLabel(g))+' · '+esc(g.ref)+' · signed as '+role+' on '+esc(fmtDT(when))+'</div></td>'+
              '<td class="meta">'+gpTag(g)+'</td><td class="meta"><button class="btn sm" data-selfie="'+esc(sel||'')+'" data-slabel="'+esc((g.name||'')+' — your '+role+' selfie')+'"'+(sel?'':' disabled')+'>Selfie</button></td></tr>'}).join('')+'</tbody></table></div>'}).join('')+
      '</div>';
  }

  // create a pass
  const d=gpDraft||(gpDraft={kind:'early',half:'',employeeId:ME.empId||'',name:ME.name||'',dept:ME.dept||'',purpose:'',selfie:null});
  if(!d.employeeId&&ME.empId) d.employeeId=ME.empId;   // backfill if the draft was created before we knew the emp id
  h+='<div class="card pad"><h3>Create a pass</h3>'+
    '<div style="margin:12px 0"><label for="g-kind">Type of pass</label><select id="g-kind">'+
      GP_KINDS.map(k=>'<option value="'+k[0]+'" '+(d.kind===k[0]?'selected':'')+'>'+esc(k[1])+'</option>').join('')+'</select></div>'+
    '<div class="hint" id="g-kindnote" style="margin:-4px 0 12px">'+gpKindNote(d.kind)+'</div>'+
    '<div id="g-halfwrap" style="margin:-4px 0 12px'+(d.kind==='halfday'?'':';display:none')+'"><label for="g-half">Which half?</label>'+
      '<div class="seg" id="g-half"><button type="button" data-h="1st" class="'+(d.half==='1st'?'on':'')+'">1st half</button>'+
      '<button type="button" data-h="2nd" class="'+(d.half==='2nd'?'on':'')+'">2nd half</button></div></div>'+
    '<div class="grid g2"><div><label for="g-emp">Employee ID</label><input id="g-emp" type="text" value="'+esc(d.employeeId)+'" placeholder="Your employee code"></div>'+
      '<div><label for="g-name">Name</label><input id="g-name" type="text" value="'+esc(d.name)+'"></div></div>'+
    '<div class="grid g2" style="margin-top:12px"><div><label for="g-dept">Department</label><select id="g-dept">'+deptOptions(d.dept)+'</select></div>'+
      '<div><label>Date</label><input type="text" value="'+esc(fmtD(Date.now()))+'" disabled></div></div>'+
    '<div style="margin-top:12px"><label for="g-purpose">Purpose</label><textarea id="g-purpose" placeholder="Where are you going and why?">'+esc(d.purpose)+'</textarea></div>'+
    '<div style="margin-top:14px"><label>Your selfie (signature)</label><div id="g-selfie-wrap" class="gp-selfie-wrap"></div></div>'+
    '<div class="hint" style="margin-top:10px">After you create the pass, you take it to whichever HOD, then HR, is available for their selfie.</div>'+
    '<div id="g-err" style="color:var(--stop);font-size:13px;margin-top:12px"></div>'+
    '<div class="row" style="gap:9px;margin-top:12px"><button class="btn primary" id="g-send">Create pass</button><button class="btn" id="g-clear">Clear</button></div></div>';

  // history, month-wise
  const openMine=mine.filter(g=>['pending_hod','pending_hr','pending_gate','out'].includes(g.status));
  const groups={}; mine.forEach(g=>{const k=String(g.passDate||'').slice(0,7)||new Date(g.createdAt).toISOString().slice(0,7);(groups[k]=groups[k]||[]).push(g)});
  const months=Object.keys(groups).sort().reverse();
  h+='<div class="card" style="margin-top:16px"><div class="row" style="padding:13px 16px;border-bottom:1px solid var(--line)"><h3>My passes</h3><span class="hint" style="margin-left:auto">'+mine.length+' in all · '+openMine.length+' open</span></div>';
  if(!mine.length) h+='<div class="empty" style="padding:26px 16px"><h3>No passes yet</h3><p class="hint">Create one above.</p></div>';
  else h+=months.map(m=>{const label=new Date(m+'-01').toLocaleDateString('en-IN',{month:'long',year:'numeric'});
    const list=groups[m], early=list.filter(g=>g.kind==='early'&&g.status!=='rejected').length;
    return '<div class="gp-month"><div class="gp-month-h">'+esc(label)+' <span class="hint">· '+list.length+' pass'+(list.length!==1?'es':'')+(early?' · '+early+' early-going':'')+'</span></div>'+
      '<div class="gp-list" style="padding:0 12px 12px">'+list.map(g=>gpCard(g,gpCanDelete(g)?'<button class="btn bad" data-del="'+g.id+'">Delete</button>':null)).join('')+'</div></div>'}).join('');
  h+='</div>';
  return h;
}
function viewGate(){
  if(gateViewer()){
    head('Gate Pass',isGateman(ME)?'Clear people at the gate — photos side by side, updating live':'Live view of every gate pass');
    const tab=gateTab||'desk';
    return '<div class="tabs"><button data-gt="desk" class="'+(tab==='desk'?'on':'')+'">'+(isGateman(ME)?'At the gate':'All entries')+'</button>'+
      '<button data-gt="new" class="'+(tab==='new'?'on':'')+'">New pass</button></div>'+
      '<div id="gate-body">'+(tab==='desk'?gateConsole():gateCreateAndMine())+'</div>';
  }
  head('Gate Pass','Take an early-going pass or an outpass — a live selfie is your signature');
  return gateCreateAndMine();
}
function wireGate(v){
  // console tabs (gateman / HR head)
  $$('[data-gt]',v).forEach(b=>b.onclick=()=>{ gateTab=b.dataset.gt; render(); });
  // bifurcation chips (early / half day / outpass) + per-view Excel
  $$('[data-gk]',v).forEach(b=>b.onclick=()=>{ gateKindFilter=b.dataset.gk; render(); });
  if($('#gc-xlsx',v)) $('#gc-xlsx',v).onclick=()=>gateConsoleExport();
  // whole console/history row → open the pass's photos & timeline
  if($('#g-send',v)){
  const d=gpDraft;
  // selfie
  const paintSelfie=()=>{ const w=$('#g-selfie-wrap',v); if(!w) return;
    w.innerHTML=d.selfie
      ? '<div class="gp-selfie-done"><span class="gp-selfie-ok">✓ Selfie taken</span><button class="btn sm" id="g-selfie-view">View</button><button class="btn sm" id="g-selfie-redo">Retake</button></div>'
      : '<button class="btn" id="g-selfie-take">📷 Take live selfie</button>';
    if($('#g-selfie-take',w)) $('#g-selfie-take',w).onclick=async()=>{const p=await captureSelfie('Your selfie'); if(p){d.selfie=p; paintSelfie()}};
    if($('#g-selfie-redo',w)) $('#g-selfie-redo',w).onclick=async()=>{const p=await captureSelfie('Retake your selfie'); if(p){d.selfie=p; paintSelfie()}};
    if($('#g-selfie-view',w)) $('#g-selfie-view',w).onclick=()=>showSelfie(d.selfie,'Your selfie');
  };
  paintSelfie();
  // kind dropdown + half-day selector (1st / 2nd half)
  const paintHalf=()=>{ const wrap=$('#g-halfwrap',v); if(!wrap) return;
    wrap.style.display = d.kind==='halfday' ? '' : 'none';
    $$('#g-half button',v).forEach(b=>b.classList.toggle('on', b.dataset.h===d.half)); };
  $$('#g-half button',v).forEach(b=>b.onclick=()=>{ d.half=b.dataset.h; paintHalf(); });
  const gk=$('#g-kind',v); if(gk) gk.onchange=()=>{ d.kind=gk.value; if(d.kind!=='halfday') d.half=''; $('#g-kindnote',v).innerHTML=gpKindNote(d.kind); paintHalf(); };
  paintHalf();
  const bind=(id,key)=>{const el=$(id,v); if(el) el.oninput=()=>d[key]=el.value; if(el&&el.tagName==='SELECT') el.onchange=()=>d[key]=el.value;};
  bind('#g-emp','employeeId'); bind('#g-name','name'); bind('#g-dept','dept'); bind('#g-purpose','purpose');
  if($('#g-dept',v)) $('#g-dept',v).value=d.dept||'';
  $('#g-clear',v).onclick=()=>{gpDraft=null;render()};
  $('#g-send',v).onclick=async()=>{
    const err=$('#g-err',v); err.textContent='';
    if(!d.name.trim()) return err.textContent='Enter your name.';
    if(d.kind==='halfday'&&!d.half) return err.textContent='Choose the 1st half or the 2nd half.';
    if(!d.purpose.trim()) return err.textContent='Enter the purpose.';
    if(!d.selfie) return err.textContent='Take your live selfie — it is your signature.';
    if(d.kind==='early'&&gpEarlyUsed()>=2) return err.textContent='You have already used both early-going passes this month.';
    busy(true);
    try{ await rpc('gp_create',{p_kind:d.kind,p_employee_id:d.employeeId.trim(),p_name:d.name.trim(),p_dept:d.dept,p_purpose:d.purpose.trim(),p_selfie:d.selfie,p_half:(d.kind==='halfday'?d.half:null)});
      gpDraft=null; await load(['gate','notif']); toast('Pass created. Now take it to an HOD for their selfie.','ok'); render(); }
    catch(e){ err.textContent=(e.message||'').replace(/^.*?: /,''); }
    finally{ busy(false); }
  };
  } // end create-form wiring
  // collect an HOD / HR signature on my own pass
  $$('[data-getsign]',v).forEach(b=>b.onclick=()=>{ const g=DB.passes.find(x=>x.id===b.dataset.getsign); if(g) getSignFlow(g); });
  // delete my own pass while it has not reached the gate
  $$('[data-del]',v).forEach(b=>b.onclick=()=>{ const g=DB.passes.find(x=>x.id===b.dataset.del); if(!g) return;
    const signed=(g.hodAt?1:0)+(g.hrAt?1:0);
    modal({title:'Delete this pass',
      body:'<p style="margin-top:0">Delete <b>'+esc(g.ref)+'</b> ('+esc(gpKindLabel(g).toLowerCase())+')?</p>'+
        '<p class="hint">It is removed completely — it will not count'+(g.kind==='early'?' against your two early-going passes this month':'')+
        (signed?', and it disappears from the '+(signed===2?'HOD and HR':'approver')+' page too':'')+'. This cannot be undone.</p>',
      footer:'<button class="btn" data-x>Keep it</button><button class="btn bad" id="gd-do">Delete</button>',
      onOpen:(mv,cl)=>{$('#gd-do',mv).onclick=async()=>{ busy(true);
        try{ await rpc('gp_delete',{p_id:g.id});
          const ps=[g.reqSelfie,g.hodSelfie,g.hrSelfie].filter(Boolean);
          if(ps.length){ try{ await SB.storage.from('documents').remove(ps) }catch(_){} }   // best-effort; 7-day sweep catches the rest
          await load(); cl(); toast('Pass deleted.','ok'); render(); }
        catch(e){ busy(false); cl(); fail(e); }finally{ busy(false); } }}}); });
  $$('[data-gate]',v).forEach(b=>b.onclick=async()=>{ const g=DB.passes.find(x=>x.id===b.dataset.gate); if(!g) return;
    busy(true); try{ const r=await rpc('gp_gate',{p_id:g.id}); await load(['gate','notif']); toast(r==='out'?'Out-time recorded.':'Closed.','ok'); render(); }catch(e){ fail(e); }finally{ busy(false); } });
  // selfie view buttons inside timelines
  $$('[data-selfie]',v).forEach(b=>b.onclick=()=>showSelfie(b.dataset.selfie||null,b.dataset.slabel||'Selfie'));
  loadSelfieThumbs(v);   // gateman console: load the side-by-side approval selfies
}

/* ============================================================
   Gate Pass Reports — interactive graphs + downloads
   ============================================================ */
let gpRepFilter=null, gpRepDrill=null;   // gpRepDrill={by,val} drills the entries list from a clicked bar/tile
function gpRepDefaults(){ const to=DAY(); const d=new Date(); d.setDate(d.getDate()-29);
  return {from:d.toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}),to:to,type:'all',dept:'all'}; }
function gpRepData(){ const f=gpRepFilter;
  return DB.passes.filter(g=>{ const d=String(g.passDate||'').slice(0,10);
    if(f.from&&d<f.from) return false; if(f.to&&d>f.to) return false;
    if(f.type!=='all'&&g.kind!==f.type) return false;
    if(f.dept!=='all'&&(g.dept||'')!==f.dept) return false; return true; }); }
const gpAgg=(rows,keyFn)=>{ const m={}; rows.forEach(g=>{const k=keyFn(g)||'—'; m[k]=(m[k]||0)+1}); return Object.entries(m).map(([label,value])=>({label,value})); };
/* a bar chart whose rows can be clicked to drill the entries list. dim names the
   dimension (dept/type/status/day/person); each row's key is what a pass is matched on. */
function gpBar(title,rows,color,dim){
  const max=Math.max(1,...rows.map(r=>r.value));
  const body=rows.length?rows.map(r=>{ const key=r.key!=null?r.key:r.label;
      const on=dim&&gpRepDrill&&gpRepDrill.by===dim&&String(gpRepDrill.val)===String(key);
      return '<div class="gpr-bar'+(dim?' gpr-click':'')+(on?' on':'')+'"'+(dim?' data-gpby="'+esc(dim)+'" data-gpval="'+esc(String(key))+'"':'')+'>'+
        '<div class="gpr-bar-l" title="'+esc(r.label)+'">'+esc(r.label)+'</div>'+
        '<div class="gpr-bar-t"><i style="width:'+Math.round(r.value/max*100)+'%'+(color?';background:'+color:'')+'"></i></div>'+
        '<div class="gpr-bar-v num">'+r.value+'</div></div>'; }).join('')
    :'<div class="hint" style="padding:12px 2px">No data in this range.</div>';
  return '<div class="card pad"><h3>'+esc(title)+'</h3>'+(dim?'<div class="hint" style="margin-top:3px">Tap a row to list those passes.</div>':'')+'<div style="margin-top:12px">'+body+'</div></div>';
}
function gpDrillMatch(g){ const d=gpRepDrill; if(!d) return true;
  if(d.by==='dept')   return (g.dept||'—')===d.val;
  if(d.by==='type')   return g.kind===d.val;
  if(d.by==='status') return g.status===d.val;
  if(d.by==='day')    return String(g.passDate||'').slice(0,10)===d.val;
  if(d.by==='person') return (g.name||user(g.requesterId).name)===d.val;
  return true; }
/* full detail of one pass, shown in-app (no download needed) */
function gpViewPass(g){
  const row=(k,val)=>val?'<div class="row" style="justify-content:space-between;gap:14px;padding:5px 0;border-bottom:1px solid var(--line)"><span class="hint">'+esc(k)+'</span><b style="text-align:right">'+esc(val)+'</b></div>':'';
  const selBtn=(p,lbl)=>p?'<button class="btn sm" data-selfieview="'+esc(p)+'" data-slabel="'+esc(lbl)+' — '+esc(g.name||'')+'">'+esc(lbl)+' selfie</button>':'';
  modal({title:g.ref+' · '+gpKindLabel(g),
    body:'<div>'+
      row('Name',g.name||user(g.requesterId).name)+row('Employee ID',g.employeeId)+row('Department',g.dept)+
      row('Type',gpKindLabel(g))+row('Purpose',g.purpose)+row('Status',(GP_STATUS[g.status]||['',g.status])[1])+
      row('HOD',g.hodId?user(g.hodId).name:'')+row('HR',g.hrId?user(g.hrId).name:'')+row('Cleared by',g.gateBy?user(g.gateBy).name:'')+
      row('Pass date',g.passDate)+row('Created',g.createdAt?fmtDT(g.createdAt):'')+row('HOD signed',g.hodAt?fmtDT(g.hodAt):'')+
      row('HR signed',g.hrAt?fmtDT(g.hrAt):'')+row('Out',g.outAt?fmtDT(g.outAt):'')+row('Return',g.returnAt?fmtDT(g.returnAt):'')+
      ((g.reqSelfie||g.hodSelfie||g.hrSelfie)?'<div class="row" style="gap:8px;flex-wrap:wrap;margin-top:12px">'+selBtn(g.reqSelfie,'Requester')+selBtn(g.hodSelfie,'HOD')+selBtn(g.hrSelfie,'HR')+'</div><div class="hint" style="margin-top:6px">Selfies auto-expire 7 days after the pass.</div>':'')+
      '</div>',
    footer:(ME.owner?'<button class="btn bad" id="gp-admindel" style="margin-right:auto">Delete (duplicate)</button>':'')+'<button class="btn" data-x>Close</button>',
    onOpen:(mv,cl)=>{ $$('[data-selfieview]',mv).forEach(b=>b.onclick=()=>showSelfie(b.dataset.selfieview,b.dataset.slabel));
      if($('#gp-admindel',mv)) $('#gp-admindel',mv).onclick=()=>gpAdminDelete(g,cl); }});
}
/* owner-only: remove one gate pass (a duplicate or wrong entry); logged permanently */
function gpAdminDelete(g,closeParent){
  if(!ME.owner) return;
  modal({title:'Delete this gate pass',
    body:'<p style="margin-top:0">Permanently remove <b>'+esc(g.ref)+'</b> — '+esc(g.name||user(g.requesterId).name)+' · '+esc(gpKindLabel(g))+'. Use this only for a <b>duplicate or wrong entry</b>; it is recorded.</p>'+
      '<div style="margin-top:10px"><label for="gad-why">Reason</label><input id="gad-why" type="text" placeholder="e.g. duplicate of GP-E1040"></div>'+
      '<div id="gad-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>',
    footer:'<button class="btn" data-x>Keep it</button><button class="btn bad" id="gad-go">Delete</button>',
    onOpen:(mv,cl)=>{ $('#gad-go',mv).onclick=async()=>{ const why=$('#gad-why',mv).value.trim();
      if(why.length<3) return $('#gad-err',mv).textContent='Give a short reason for the record.';
      $('#gad-go',mv).disabled=true;
      const paths=[g.reqSelfie,g.hodSelfie,g.hrSelfie].filter(Boolean);
      try{ try{ await removeObjects(paths); }catch(e){}
        await rpc('gp_admin_delete',{p_id:g.id,p_why:why}); cl(); if(closeParent) closeParent(); await load(['gate','notif']); toast('Gate pass deleted.','ok'); render(); }
      catch(e){ $('#gad-go',mv).disabled=false; $('#gad-err',mv).textContent=(e.message||'').replace(/^.*?: /,''); } }; }});
}
function gpRepBody(){
  const rows=gpRepData(), byType=k=>rows.filter(g=>g.kind===k).length;
  const kpis='<div class="grid g4" style="margin:14px 0">'+
    stat('Total passes',rows.length,'In the selected range','var(--indigo)')+
    stat('Early / Half / Outpass',byType('early')+' / '+byType('halfday')+' / '+byType('official'),'By type','var(--cyan)')+
    '<div class="gpr-click" data-gpby="status" data-gpval="out">'+stat('Currently out',rows.filter(g=>g.status==='out').length,'Tap to list · not back yet',rows.some(g=>g.status==='out')?'var(--hold)':'var(--seal)')+'</div>'+
    '<div class="gpr-click" data-gpby="status" data-gpval="rejected">'+stat('Rejected',rows.filter(g=>g.status==='rejected').length,'Tap to list · declined','var(--stop)')+'</div>'+'</div>';
  const deptAgg=gpAgg(rows,g=>g.dept).sort((a,b)=>b.value-a.value);
  const typeAgg=GP_KINDS.map(k=>({label:k[1],value:byType(k[0]),key:k[0]}));
  const statusAgg=[['With HOD','pending_hod'],['With HR','pending_hr'],['At gate','pending_gate'],['Out','out'],['Closed','closed'],['Rejected','rejected']].map(([lbl,st])=>({label:lbl,value:rows.filter(g=>g.status===st).length,key:st}));
  const m={}; rows.forEach(g=>{const k=String(g.passDate||'').slice(0,10); m[k]=(m[k]||0)+1}); const dayAgg=Object.keys(m).sort().map(k=>({label:k.slice(5),value:m[k],key:k}));
  const personAgg=gpAgg(rows,g=>g.name||user(g.requesterId).name).sort((a,b)=>b.value-a.value).slice(0,10);
  const multi=personAgg.filter(p=>p.value>1).length;
  // the entries list — drilled by whatever bar/tile is selected, viewable in-app
  const erows=rows.filter(gpDrillMatch).sort((a,b)=>b.createdAt-a.createdAt);
  const dName={dept:'Department',type:'Type',status:'Status',day:'Day',person:'Person'};
  const drillHdr=gpRepDrill?'<span class="tag t-prog" style="margin-left:auto">'+esc(dName[gpRepDrill.by]+': '+gpRepDrill.val)+' · '+erows.length+'</span><button class="btn ghost sm" id="gpr-clear">Clear</button>'
    :'<span class="hint" style="margin-left:auto">'+erows.length+' entr'+(erows.length===1?'y':'ies')+'</span>';
  const entries='<div class="card" style="margin-top:14px"><div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line)"><h3>Gate pass entries</h3>'+drillHdr+'</div>'+
    (erows.length?'<table class="cards"><tbody>'+erows.map(g=>gpRow(g,{action:'<button class="btn sm" data-gpview="'+g.id+'">View</button>'})).join('')+'</tbody></table>'
      :'<div class="empty" style="padding:22px 16px"><h3>No passes</h3><p class="hint">Nothing matches this selection.</p></div>')+'</div>';
  return kpis+
    '<div class="grid g2" style="gap:14px;align-items:start">'+
      gpBar('Passes by department',deptAgg,'var(--indigo)','dept')+
      gpBar('Passes by type',typeAgg,'var(--cyan)','type')+
      gpBar('Passes by day',dayAgg,'var(--seal)','day')+
      gpBar('By status',statusAgg,'var(--hold)','status')+
    '</div>'+
    gpBar('People with the most passes'+(multi?' · '+multi+' took more than one':''),personAgg,'var(--indigo-deep)','person')+
    entries;
}
function viewGpReport(){
  head('Gate Pass Reports','Live analytics across every gate pass — filter, then download');
  if(!gpRepFilter) gpRepFilter=gpRepDefaults();
  const f=gpRepFilter, depts=Array.from(new Set(DB.passes.map(g=>g.dept).filter(Boolean))).sort();
  const filters='<div class="card pad"><div class="grid g4" style="gap:12px">'+
    '<div><label for="gr-from">From</label><input type="date" id="gr-from" value="'+esc(f.from)+'"></div>'+
    '<div><label for="gr-to">To</label><input type="date" id="gr-to" value="'+esc(f.to)+'"></div>'+
    '<div><label for="gr-type">Type</label><select id="gr-type"><option value="all">All types</option>'+GP_KINDS.map(k=>'<option value="'+k[0]+'" '+(f.type===k[0]?'selected':'')+'>'+esc(k[1])+'</option>').join('')+'</select></div>'+
    '<div><label for="gr-dept">Department</label><select id="gr-dept"><option value="all">All departments</option>'+depts.map(d=>'<option '+(f.dept===d?'selected':'')+'>'+esc(d)+'</option>').join('')+'</select></div>'+
    '</div><div class="row" style="gap:9px;margin-top:12px;flex-wrap:wrap"><button class="btn" id="gr-reset">Reset to last 30 days</button><button class="btn primary" id="gr-xlsx">Download Excel</button><button class="btn" id="gr-csv">Download CSV</button></div></div>';
  return filters+'<div id="gpr-body">'+gpRepBody()+'</div>';
}
function gpToObj(g){ return {
  Ref:g.ref, Type:gpKindLabel(g), Half:(g.kind==='halfday'?gpHalfLabel(g.halfPart):''), Name:g.name||user(g.requesterId).name, 'Employee ID':g.employeeId||'',
  Department:g.dept||'', Purpose:g.purpose||'', Status:(GP_STATUS[g.status]||['',g.status])[1],
  HOD:g.hodId?user(g.hodId).name:'', HR:g.hrId?user(g.hrId).name:'', 'Cleared by':g.gateBy?user(g.gateBy).name:'',
  Created:fmtDT(g.createdAt),'HOD signed':fmtDT(g.hodAt),'HR signed':fmtDT(g.hrAt),'Out':fmtDT(g.outAt),'Return':fmtDT(g.returnAt),'Pass date':g.passDate }; }
function gpRepRows(){ return gpRepData().map(gpToObj); }
function gpRepDownload(fmt){
  const rows=gpRepRows(); if(!rows.length) return toast('No entries in this range.','bad');
  const name='gate-passes_'+gpRepFilter.from+'_to_'+gpRepFilter.to;
  if(fmt==='xlsx'&&window.XLSX){ const ws=XLSX.utils.json_to_sheet(rows), wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,'Gate passes'); XLSX.writeFile(wb,name+'.xlsx'); return; }
  const cols=Object.keys(rows[0]);
  const csv=[cols.join(',')].concat(rows.map(r=>cols.map(c=>'"'+String(r[c]==null?'':r[c]).replace(/"/g,'""')+'"').join(','))).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download=name+'.csv'; a.click(); URL.revokeObjectURL(a.href);
}
function wireGpReport(v){
  const f=gpRepFilter;
  const paintBody=()=>{ const b=$('#gpr-body',v); if(!b) return; b.innerHTML=gpRepBody();
    const drill=(by,val)=>{ gpRepDrill=(gpRepDrill&&gpRepDrill.by===by&&String(gpRepDrill.val)===String(val))?null:{by,val}; paintBody(); };
    $$('[data-gpby]',b).forEach(el=>el.onclick=()=>drill(el.dataset.gpby,el.dataset.gpval));
    if($('#gpr-clear',b)) $('#gpr-clear',b).onclick=()=>{ gpRepDrill=null; paintBody(); };
    $$('[data-gpview]',b).forEach(btn=>btn.onclick=()=>{ const g=DB.passes.find(x=>x.id===btn.dataset.gpview); if(g) gpViewPass(g); });
    loadSelfieThumbs(b);
  };
  const set=(id,key)=>{const el=$(id,v); if(el) el.onchange=()=>{ f[key]=el.value; gpRepDrill=null; paintBody(); };};
  set('#gr-from','from'); set('#gr-to','to'); set('#gr-type','type'); set('#gr-dept','dept');
  if($('#gr-reset',v)) $('#gr-reset',v).onclick=()=>{ gpRepFilter=gpRepDefaults(); gpRepDrill=null; render(); };
  if($('#gr-xlsx',v)) $('#gr-xlsx',v).onclick=()=>gpRepDownload('xlsx');
  if($('#gr-csv',v)) $('#gr-csv',v).onclick=()=>gpRepDownload('csv');
  paintBody();
}


/* ============================================================
   ALDS PO / WO fixed flows (Stage 2 UI)
   ============================================================ */
const flowHeadLabel=h=>h==='PO'?'ALDS PO (Indent)':h==='WO'?'ALDS WO (Work order)':h==='CNG'?'CNG (Indent)':h;
const flowNorm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const flowLive=f=>f.steps.find(s=>s.status==='pending');
const flowIsMine=f=>{const s=flowLive(f); return !!(s&&s.actors.indexOf(ME.id)>-1)};
// a flow's first approval group = the division's Indent / Work Order approvers
const flowFirstApprovers=f=>{const s=(f.steps||[]).filter(x=>x.action==='approve').sort((a,b)=>a.pos-b.pos)[0]; return s?s.actors:[]};
// only those division approvers may escalate past CMD (accounts team no longer can)
const flowCanEscalate=f=>{const s=flowLive(f); return !!(s&&s.escalatable&&flowFirstApprovers(f).indexOf(ME.id)>-1)};
// delete a flow: the requester may, but only before any approval; an admin/owner may anytime
const flowApprovedYet=f=>(f.steps||[]).some(s=>s.action==='approve'&&s.status==='done');
const flowCanDelete=f=>f.status!=='cancelled'&&((f.requesterId===ME.id&&!flowApprovedYet(f))||ME.admin||ME.owner);
// the person a parked step is CURRENTLY on (sequential: first tagged, in order, not yet replied)
const flowActiveTag=s=>{ if(!s||!s.infoRequested) return null; const tg=infoTargets(s); if(!tg.length) return null;
  return tg.find(id=>!(s.infoReplies||[]).some(e=>(e.user_id||e.userId)===id))||null; };
// item 8 — three buckets for a running flow's live step:
//   actionable  : it's with me and I can act now (not parked on an ask)
//   taggedToMe  : I'm the person it's currently parked on (my input needed)
//   awaitingMine: I asked / own the step but it's parked on someone else right now
const flowActionableByMe=f=>{const s=flowLive(f); return !!(s&&s.actors.indexOf(ME.id)>-1&&!s.infoRequested)};
const flowTaggedToMe=f=>{const s=flowLive(f); if(!s||!s.infoRequested) return false; const tg=infoTargets(s);
  return tg.length?(flowActiveTag(s)===ME.id):(f.requesterId===ME.id)};
const flowAwaitingMyReply=f=>{const s=flowLive(f); if(!s||!s.infoRequested) return false;
  return s.actors.indexOf(ME.id)>-1 && !flowTaggedToMe(f)};
const flowNeedsMyReply=flowTaggedToMe;   // kept name for existing callers
const flowMyTurn=()=>DB.flows.filter(f=>f.status==='running'&&(flowActionableByMe(f)||flowCanEscalate(f)));
const flowTagged=()=>DB.flows.filter(f=>f.status==='running'&&flowTaggedToMe(f));
const flowAwaitingReply=()=>DB.flows.filter(f=>f.status==='running'&&flowAwaitingMyReply(f));
const flowMine=()=>DB.flows.filter(f=>f.requesterId===ME.id);
const flowStageList=f=>{const order=[],seen={}; f.steps.forEach(s=>{if(!seen[s.stage]){seen[s.stage]=1;order.push(s.stage)}}); return order;};
const flowWhere=f=>{ if(f.status==='completed') return 'Completed'; const s=flowLive(f); return s?(s.stage+' · '+s.label):'—'; };
const flowStatusTag=f=>f.status==='completed'?'<span class="tag t-ok">Completed</span>':f.status==='cancelled'?'<span class="tag t-bad">Cancelled</span>':'<span class="tag t-prog">In progress</span>';

function flowRow(f){
  const s=flowLive(f), withWho=s?s.actors.map(id=>user(id).name).slice(0,3).join(', ')+(s.actors.length>3?' +'+(s.actors.length-3):''):'';
  return '<tr data-flow="'+f.id+'"'+(flowTaggedToMe(f)?' class="row-tagme"':flowAwaitingMyReply(f)?' class="row-await"':'')+'><td><b>'+esc(f.ref)+'</b> <span class="tag t-ok" style="font-size:10.5px">Fixed flow</span> <span class="hint">'+esc(flowHeadLabel(f.head))+' · '+esc(f.division)+'</span>'+
    '<div class="hint">'+esc(f.title||'(no title)')+' · by '+esc(user(f.requesterId).name)+' · '+esc(fmtD(f.createdAt))+'</div>'+
    '<div class="hint">'+esc(flowWhere(f))+(withWho?' — with '+esc(withWho):'')+'</div></td>'+
    '<td class="meta">'+flowStatusTag(f)+(flowActionableByMe(f)?'<div class="hint" style="color:var(--indigo)">Your turn</div>':flowTaggedToMe(f)?'<div class="hint tag-me">Your input needed</div>':flowAwaitingMyReply(f)?'<div class="hint" style="color:var(--steel)">Awaiting reply</div>':'')+'</td></tr>';
}
/* ALDS flows surfaced inside the normal lists (Waiting on me / My requests / All).
   They are raised from the Raise-a-request page, so there is no separate raise tab.
   Each section carries a "requester" dropdown + search so an approver facing 100s of
   flows can narrow to one person who raised them and act on just those. */
let flowFilter={turn:{req:'',q:'',stage:''},mine:{req:'',q:'',stage:''},all:{req:'',q:'',stage:''}};
const STAGE_ORDER=['Indent','Purchase','Vendor Process','Payment Advice','Advice Submit','Vendor Confirm','SRN','GRN'];
function flowSection(ctx){
  let list;
  if(ctx==='turn') list=flowMyTurn();
  else if(ctx==='tagged') list=flowTagged();
  else if(ctx==='awaiting') list=flowAwaitingReply();
  else if(ctx==='mine') list=flowMine();
  else list=DB.flows.slice();
  if(!list.length) return '';
  const ft=flowFilter[ctx]||(flowFilter[ctx]={req:'',q:'',stage:''});
  // the people who raised the flows in this section (so an approver sees only the
  // requesters whose requests actually reached them)
  const reqIds=[...new Set(list.map(f=>f.requesterId))].sort((a,b)=>user(a).name.localeCompare(user(b).name));
  if(ft.req&&reqIds.indexOf(ft.req)<0) ft.req='';   // stale pick no longer present
  let shown=list.slice();
  // on the All requests page, obey the page's type / status filter so it covers
  // both engines: Indent ↔ ALDS PO flows, Work order ↔ ALDS WO flows.
  if(ctx==='all'){
    if(allF.type==='indent') shown=shown.filter(f=>f.head==='PO');
    else if(allF.type==='workorder') shown=shown.filter(f=>f.head==='WO');
    if(allF.status){ const sm={'In Progress':'running','Approved':'completed'}[allF.status];
      shown = sm ? shown.filter(f=>f.status===sm) : []; }   // Info Requested / Rejected have no flow equivalent
    shown=shown.filter(f=>dateMatch(f.createdAt));   // #2: the top bar's month / date cover both engines
  }
  if(ft.req) shown=shown.filter(f=>f.requesterId===ft.req);
  // #1 stage filter: segregate pending files by the stage their LIVE step is at (running flows only)
  const stageCount={}; list.forEach(f=>{const s=flowLive(f); if(s&&s.stage) stageCount[s.stage]=(stageCount[s.stage]||0)+1;});
  const stageOpts=Object.keys(stageCount).sort((a,b)=>{const ia=STAGE_ORDER.indexOf(a),ib=STAGE_ORDER.indexOf(b);return (ia<0?99:ia)-(ib<0?99:ib)||a.localeCompare(b);});
  if(ft.stage&&!stageCount[ft.stage]) ft.stage='';
  if(ft.stage) shown=shown.filter(f=>{const s=flowLive(f);return !!(s&&s.stage===ft.stage);});
  // text search: on the All requests page the page's own search box drives it (so one
  // box covers both engines); elsewhere this section's own box does. It matches the
  // FLOW reference AND the real PO / WO / indent number (stored in the title and fields),
  // so searching "1052" or the document number "W326O08-001" / just "001" all work.
  const q=((ctx==='all'?allF.q:ft.q)||'').trim().toLowerCase();
  if(q){ shown=shown.filter(f=>{
    const extra=Object.keys(f.fields||{}).map(k=>f.fields[k]).filter(v=>typeof v==='string'||typeof v==='number').join(' ');
    return ((f.ref||'')+' '+(f.title||'')+' '+user(f.requesterId).name+' '+(f.division||'')+' '+flowHeadLabel(f.head)+' '+extra).toLowerCase().includes(q); }); }
  shown.sort((a,b)=>b.createdAt-a.createdAt);
  const label=ctx==='turn'?'ALDS flows waiting on me':ctx==='tagged'?'Tagged to you — your input needed':ctx==='awaiting'?'Awaiting reply — you asked someone':ctx==='mine'?'My ALDS flows':'ALDS PO / WO flows';
  const onAll=ctx==='all';
  const filtered=ft.req||ft.q||ft.stage||(onAll&&(allF.type||allF.status||allF.q||allF.month||allF.date));
  const stageSel=stageOpts.length>1
    ? '<select class="fl-stage" data-ctx="'+ctx+'" title="Show only files pending at a stage" style="width:auto"><option value="">All stages ('+stageOpts.length+')</option>'+
        stageOpts.map(st=>'<option value="'+esc(st)+'" '+(ft.stage===st?'selected':'')+'>'+esc(st)+' ('+stageCount[st]+')</option>').join('')+'</select>'
    : '';
  const bar=reqIds.length>1||list.length>1||stageSel
    ? '<div class="row filters-row" style="gap:10px;padding:10px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap">'+
        (reqIds.length>1||list.length>1?'<select class="fl-req" data-ctx="'+ctx+'" style="width:auto"><option value="">All requesters ('+reqIds.length+')</option>'+
          reqIds.map(id=>'<option value="'+id+'" '+(ft.req===id?'selected':'')+'>'+esc(user(id).name)+'</option>').join('')+'</select>':'')+
        stageSel+
        // the All page already has the top search box, so don't show a duplicate here
        (onAll?'<div class="hint" style="flex:1;min-width:140px;align-self:center">Use the search box at the top to find a number, title or division.</div>'
             :'<input class="fl-q" data-ctx="'+ctx+'" type="text" placeholder="Search number, title or division" value="'+esc(ft.q)+'" style="flex:1;min-width:180px">')+
        ((ft.req||ft.q||ft.stage)?'<button class="btn ghost sm fl-clear" data-ctx="'+ctx+'">Clear</button>':'')+
      '</div>'
    : '';
  return '<div class="card" style="margin-top:16px"><div class="row" style="padding:14px 18px;border-bottom:1px solid var(--line)"><h3>'+label+'</h3>'+
      '<span class="tag t-prog" style="margin-left:auto">'+shown.length+(filtered?' of '+list.length:'')+'</span></div>'+
    bar+
    (shown.length?'<table class="cards"><tbody>'+shown.map(flowRow).join('')+'</tbody></table>'
      :'<div class="empty" style="padding:22px 16px"><h3>Nothing matches</h3><p class="hint">No flow matches the current filter.</p></div>')+
    '</div>';
}
function wireFlowRows(v){
  $$('[data-flow]',v).forEach(tr=>tr.onclick=()=>go({name:'flowdetail',id:tr.dataset.flow}));
  $$('.fl-req',v).forEach(sel=>sel.onchange=()=>{const c=sel.dataset.ctx;(flowFilter[c]||(flowFilter[c]={req:'',q:'',stage:''})).req=sel.value;render()});
  $$('.fl-stage',v).forEach(sel=>sel.onchange=()=>{const c=sel.dataset.ctx;(flowFilter[c]||(flowFilter[c]={req:'',q:'',stage:''})).stage=sel.value;render()});
  $$('.fl-clear',v).forEach(b=>b.onclick=()=>{const c=b.dataset.ctx;flowFilter[c]={req:'',q:'',stage:''};render()});
  $$('.fl-q',v).forEach(inp=>inp.oninput=()=>{const c=inp.dataset.ctx;(flowFilter[c]||(flowFilter[c]={req:'',q:''})).q=inp.value;
    const p=inp.selectionStart;render();const n=$('.fl-q[data-ctx="'+c+'"]');if(n){n.focus();n.setSelectionRange(p,p)}});
}
/* ---- detail: the stage → sub-step chain, visible to all, act only at your point ---- */
const FLOW_ST={waiting:['t-wait','Waiting'],pending:['t-prog','Now here'],done:['t-ok','Done'],skipped:['t-hold','Skipped']};
/* read-only timeline row — the actions live in the right-hand panel */
function flowStepRow(f,s){
  let st=FLOW_ST[s.status]||['t-wait',s.status];
  if(s.systemApproved) st=['t-ok','System approved'];
  // parked on an ask: the step is NOT with its approver right now — it's with the tagged
  // people. Show the approver's row muted and put the highlight on whoever has it.
  const parked=s.status==='pending'&&s.infoRequested;
  if(parked) st=['t-wait','Asked for more — waiting'];
  const held=s.status==='pending'&&s.onHold;
  if(held) st=['t-hold','On hold'];
  const actors=s.actorKind==='any'?'Anyone in the department':(s.actors.map(id=>user(id).name).join(', ')||'—');
  let meta='';
  if(held) meta+='<div class="hint" style="color:var(--hold)"><b>On hold</b>'+(s.holdBy?' by '+esc(user(s.holdBy).name):'')+(s.holdReason?' — '+esc(s.holdReason):'')+'</div>';
  if(s.status==='done'){
    if(s.systemApproved) meta='<div class="hint" style="color:var(--indigo)"><b>System Approved — by super admin</b> · '+esc(fmtDT(s.actedAt))+'</div>';
    else meta='<div class="hint">'+(s.actedBy?esc(user(s.actedBy).name):'—')+' · '+esc(fmtDT(s.actedAt))+(s.remark?' · '+esc(s.remark):'')+'</div>';
  }
  if(s.erpDone) meta+='<div class="hint" style="color:var(--seal)">ERP entered'+(s.erpDoneBy?' by '+esc(user(s.erpDoneBy).name):'')+(s.erpDoneAt?' · '+esc(fmtDT(s.erpDoneAt)):'')+'</div>';
  if(s.dataVal&&s.dataVal.condition) meta+='<div class="hint" style="color:var(--hold)">Condition: '+esc(s.dataVal.condition)+'</div>';
  if(s.datetimeVal) meta+='<div class="hint">Confirmed: '+esc(fmtDT(s.datetimeVal))+'</div>';
  if(s.dataVal&&s.action==='data') meta+='<div class="hint">'+Object.entries(s.dataVal).filter(([k])=>k!=='condition').map(([k,val])=>esc(k)+': '+esc(val)).join(' · ')+'</div>';
  if(s.dataVal&&s.action==='payment') meta+='<div class="hint">'+esc((s.dataVal.mode||'').toUpperCase())+(s.dataVal.advices?' · '+s.dataVal.advices.map(a=>a.pct+'%').join(', '):'')+'</div>';
  // (who it's pending with is shown by the highlighted "Pending with" pill below; with
  //  several people tagged, the order chain shows who has it now and who is next)
  if(s.infoRequested){ const tg=infoTargets(s); if(tg.length>1) meta+='<div style="margin-top:6px">'+flowTagChain(s)+'</div>'; }
  meta+=flowCommentThread(s);
  // item 7: the people on this step, the raiser (and admins) can attach a file at ANY stage of a running flow
  const canAttach=f.status==='running'&&(s.actors.indexOf(ME.id)>-1||f.requesterId===ME.id||ME.admin||ME.owner);
  const attachBtn=canAttach?'<button class="btn ghost sm" data-fattach="'+s.id+'" style="padding:2px 9px">'+(isSiteStep(s)?'📷 Add site photos':'📎 Attach a file')+'</button>':'';
  // item 14: photos tagged with a station are shown grouped by station, each labelled with its date
  const tagged=s.files.filter(fl=>fl.station), plain=s.files.filter(fl=>!fl.station);
  let sitePhotos='';
  if(tagged.length){ const by={}; tagged.forEach(fl=>(by[fl.station]=by[fl.station]||[]).push(fl));
    const stations=Object.keys(by).sort((a,b)=>a.localeCompare(b)), short=n=>String(n||'').length>18?String(n).slice(0,16)+'…':String(n||'');
    sitePhotos='<div class="site-photos"><div class="sp-head">Site photos · '+tagged.length+' photo'+(tagged.length>1?'s':'')+' from '+stations.length+' station'+(stations.length>1?'s':'')+'</div>'+
      stations.map(st=>'<div class="sp-group"><div class="sp-st">📍 '+esc(st)+' <span class="hint">('+by[st].length+')</span></div><div class="row" style="gap:6px;flex-wrap:wrap">'+
        by[st].slice().sort((a,b)=>String(a.photoDate).localeCompare(String(b.photoDate))).map(fl=>'<button class="btn sm" data-ffile="'+fl.id+'" title="'+esc(fl.name)+'">'+esc(fmtD(fl.photoDate))+' · '+esc(short(fl.name))+'</button>').join('')+
        '</div></div>').join('')+'</div>'; }
  const files=sitePhotos+((plain.length||attachBtn)?'<div class="row" style="gap:6px;flex-wrap:wrap;margin-top:4px">'+plain.map(fl=>'<button class="btn sm" data-ffile="'+fl.id+'" title="'+esc(fl.name)+'">'+esc(fl.name)+'</button>').join('')+attachBtn+'</div>':'');
  let ownerBtn='';
  if(ME.owner&&f.status==='running'&&(s.status==='pending'||s.status==='waiting'))
    ownerBtn='<button class="btn ghost sm" data-fsys="'+s.id+'" style="color:var(--indigo);padding:2px 9px">⚡ System-approve to here</button>';
  else if(ME.owner&&(f.status==='running'||f.status==='completed')&&s.status==='done')
    ownerBtn='<button class="btn ghost sm" data-frwd="'+s.id+'" style="color:var(--hold);padding:2px 9px">↩ Reopen from here</button>';
  // admin/owner can map the right approver onto a not-yet-done step (fixes a name that didn't resolve)
  let assignBtn='';
  if((ME.owner||ME.admin)&&f.status==='running'&&s.status!=='done'&&s.actorKind!=='any'&&s.actorKind!=='raiser')
    assignBtn='<button class="btn ghost sm" data-fassign="'+s.id+'" style="color:var(--seal);padding:2px 9px">👤 Change approver</button>';
  const sysBtn=(ownerBtn||assignBtn)?'<div class="row" style="margin-top:6px;gap:6px;flex-wrap:wrap">'+ownerBtn+assignBtn+'</div>':'';
  // item 9: show clearly WHO the live step is pending with (the tagged person when parked, else the actors)
  let pendingWith='';
  if(s.status==='pending'){
    let holder;
    if(s.infoRequested){ const tg=infoTargets(s); holder=tg.length?user(flowActiveTag(s)||tg[0]).name:'the requester'; }
    else holder=actors;
    pendingWith='<div class="pending-with'+(s.infoRequested?' tagged':'')+'">Pending with <b>'+esc(holder)+'</b>'+(s.infoRequested&&s.infoBy?' <span class="pw-sub">· asked by '+esc(user(s.infoBy).name)+'</span>':'')+'</div>';
  }
  return '<div class="flow-step '+(parked?'parked':s.status==='pending'?'live':'')+' '+(s.status==='done'?'done':'')+'">'+
    '<span class="flow-dot"></span><div style="flex:1;min-width:0"><div class="row" style="gap:8px;flex-wrap:wrap"><b>'+esc(s.label)+'</b><span class="tag '+st[0]+'" style="font-size:11px">'+st[1]+'</span>'+(s.erpDone?'<span class="tag t-ok" style="font-size:11px">ERP ✓</span>':'')+'</div>'+
    '<div class="hint">'+esc(actors)+'</div>'+pendingWith+meta+files+sysBtn+'</div></div>';
}
/* item 10: the order an ask travels — "1. A ✓ → 2. B (now) → 3. C → back to asker" */
function flowTagChain(s){
  const tg=infoTargets(s); if(!tg.length) return '';
  const active=flowActiveTag(s), rep=s.infoReplies||[];
  const done=id=>rep.some(e=>(e.user_id||e.userId)===id);
  const chips=tg.map((id,i)=>{ const st=done(id)?'done':(id===active?'now':'next');
    return '<span class="tchain-chip tc-'+st+'">'+(i+1)+'. '+esc(user(id).name)+(st==='done'?' ✓':st==='now'?' · now':'')+'</span>'; });
  chips.push('<span class="tchain-chip tc-back">back to '+esc(s.infoBy?user(s.infoBy).name:'the approver')+'</span>');
  return '<div class="tchain">'+chips.join('<span class="tchain-arr">→</span>')+'</div>';
}
/* a step's comment thread: the ask + every reply, each with author and date/time,
   one below the other (Facebook-style). Everyone who can see the flow can read it;
   only tagged people can reply (that box lives in the right-hand panel). */
function flowCommentThread(s){
  const items=[];
  if(s.infoText) items.push({name:s.infoBy?user(s.infoBy).name:'Approver', at:s.infoAt, text:s.infoText, ask:true, to:infoTargets(s).map(id=>user(id).name).join(', ')});
  (s.infoReplies||[]).forEach(e=>items.push({name:e.name||user(e.user_id||e.userId).name, at:e.at?ts(e.at):0, text:e.text, ask:false}));
  if(!items.length && s.infoReply) items.push({name:'Reply', at:s.infoReplyAt, text:s.infoReply, ask:false});
  if(!items.length) return '';
  const rows=items.map(it=>'<div class="cmt"><div class="cmt-h"><b>'+esc(it.name)+'</b>'+(it.ask&&it.to?' <span class="cmt-to">asked '+esc(it.to)+'</span>':'')+(it.at?'<span class="cmt-t">'+esc(fmtDT(it.at))+'</span>':'')+'</div><div class="cmt-b">'+esc(it.text)+'</div></div>').join('');
  return '<details class="cmt-thread"><summary>Comments · '+items.length+'</summary><div class="cmt-list">'+rows+'</div></details>';
}
const flowActLabel=s=>({initiate:'Submit & sign',upload:'Upload & sign',approve:'Approve',confirm:'Confirm',data:'Enter details & sign',payment:'Initiate advice'})[s.action]||'Submit';
/* left: the read-only stage/step timeline. right: the current person's options. */
function viewFlowDetail(id){
  const f=DB.flows.find(x=>x.id===id);
  if(!f){ head('Flow','Not found'); return '<div class="card pad">This flow could not be found.</div>'; }
  head(f.ref,'Fixed flow · '+flowHeadLabel(f.head)+' · '+f.division+(f.title?' · '+f.title:''));
  let left='<div class="row" style="margin-bottom:12px"><button class="btn sm" id="fl-back">← Back</button><span style="margin-left:auto">'+flowStatusTag(f)+'</span>'+
    (flowCanDelete(f)?'<button class="btn bad sm" id="fl-del" style="margin-left:9px">Delete request</button>':'')+'</div>';
  flowStageList(f).forEach(stage=>{
    const steps=f.steps.filter(s=>s.stage===stage);
    const anyLive=steps.some(s=>s.status==='pending');
    const anyParked=steps.some(s=>s.status==='pending'&&s.infoRequested);   // with tagged people, not the approver
    left+='<div class="card" style="margin-bottom:12px'+(anyParked?';border-color:var(--hold)':anyLive?';border-color:var(--indigo)':'')+'"><div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line)"><h3>'+esc(stage)+'</h3></div>'+
      '<div style="padding:10px 16px">'+steps.map(s=>flowStepRow(f,s)).join('')+'</div></div>';
  });
  if(f.audit.length) left+='<div class="card" style="margin-bottom:12px"><div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line)"><h3>History</h3></div><div style="padding:10px 16px">'+
    f.audit.slice().reverse().map(a=>'<div class="hint" style="padding:3px 0"><b>'+esc(a.actorName||'')+'</b> — '+esc(a.action)+(a.detail?' · '+esc(a.detail):'')+' · '+esc(fmtDT(a.ts))+'</div>').join('')+'</div></div>';
  return '<div class="detail-grid"><div>'+left+'</div><div>'+flowSidePanel(f)+'</div></div>';
}
/* the right-hand options panel for whoever is viewing */
function flowSidePanel(f){
  const s=flowLive(f);
  if(!s) return '<div class="card pad"><h3>'+(f.status==='completed'?'Completed':f.status==='cancelled'?'Cancelled':'Nothing to do')+'</h3><p class="hint" style="margin-top:6px">This flow has no open step right now.</p></div>';
  const mine=s.actors.indexOf(ME.id)>-1||s.actorKind==='any', isReq=f.requesterId===ME.id;
  const canEsc=s.escalatable&&flowFirstApprovers(f).indexOf(ME.id)>-1;
  const withWho=s.actors.map(id=>user(id).name).join(', ')||'—';
  const tg=infoTargets(s);
  // item 10: with several people tagged it travels in order — only the CURRENT one may reply
  const active=flowActiveTag(s);
  const amRecipient = s.infoRequested && (tg.length?(active===ME.id):isReq);
  const prevReplies=(s.infoReplies||[]);
  if(amRecipient){
    const asReq = !tg.length && isReq;
    return '<div class="card pad tagme-panel"><h3>'+(tg.length?'You were tagged to check':'The approver needs more')+'</h3>'+
      '<p class="hint" style="margin-top:6px">'+(s.infoBy?esc(user(s.infoBy).name):'An approver')+' asked on <b>'+esc(s.label)+'</b>:</p>'+
      '<div class="banner hold" style="margin-top:8px"><div>'+esc(s.infoText)+'</div></div>'+
      (tg.length>1?'<div style="margin-top:10px">'+flowTagChain(s)+'</div>':'')+
      (prevReplies.length?'<div style="margin-top:10px"><div class="hint" style="font-weight:600">Replied before you</div>'+prevReplies.map(e=>'<div class="banner" style="margin-top:6px"><div class="hint"><b>'+esc(e.name||user(e.user_id).name)+'</b>'+(e.at?' · '+esc(fmtDT(ts(e.at))):'')+': '+esc(e.text)+'</div></div>').join('')+'</div>':'')+
      '<div style="margin-top:12px"><label for="fr-text">Your response</label><textarea id="fr-text" placeholder="Answer, or note what you changed"></textarea></div>'+
      '<div style="margin-top:10px"><label>Attach <span class="hint">optional'+(asReq?' — e.g. the corrected indent':'')+'</span></label><div id="fr-files"></div></div>'+
      (asReq?'<label style="display:flex;align-items:center;gap:9px;margin:10px 0 0"><input type="checkbox" id="fr-replace" style="width:auto"> <span><b>This replaces the original indent document</b><div class="hint">The attached file becomes the new indent at step 1.</div></span></label>':'')+
      '<div id="fr-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>'+
      '<button class="btn primary" id="fr-go" style="margin-top:12px;width:100%">Send response</button></div>';
  }
  // tagged, but someone earlier in the sequence still has to reply first
  if(s.infoRequested && tg.indexOf(ME.id)>-1 && !iReplied(s.infoReplies) && active && active!==ME.id){
    return '<div class="card pad"><h3>You are tagged — not your turn yet</h3>'+
      '<p class="hint" style="margin-top:6px">'+(s.infoBy?esc(user(s.infoBy).name):'An approver')+' asked: <b>'+esc(s.infoText)+'</b></p>'+
      '<div style="margin-top:10px">'+flowTagChain(s)+'</div>'+
      '<p class="hint" style="margin-top:10px">It comes to you after <b>'+esc(user(active).name)+'</b> replies. You will get a notification.</p></div>';
  }
  if(mine){
    if(s.infoRequested){ const who=tg.length?user(active||tg[0]).name:'the requester', tot=tg.length;
      let w='<div class="card pad"><h3>Waiting on '+esc(who)+'</h3><p class="hint" style="margin-top:6px">You asked: <b>'+esc(s.infoText)+'</b>. '+
        (tot>1?'It goes to each person in turn, then comes back to you.':'It comes back to you once they respond.')+' It is off your “Waiting on me” until then.</p>';
      if(tot>1) w+='<div style="margin-top:10px">'+flowTagChain(s)+'</div>';
      if((s.infoReplies||[]).length) w+=s.infoReplies.map(e=>'<div class="banner" style="margin-top:8px"><div class="hint"><b>'+esc(e.name||user(e.user_id).name)+'</b>'+(e.at?' · '+esc(fmtDT(ts(e.at))):'')+': '+esc(e.text)+'</div></div>').join('');
      return w+'</div>'; }
    const approving=(s.action==='approve'||s.action==='confirm');
    let body='<div class="card pad"><h3>'+esc(s.label)+'</h3><p class="hint" style="margin-top:4px">'+esc(f.ref)+' · '+esc(flowHeadLabel(f.head))+' · '+esc(f.division)+'</p>';
    if(s.infoReplies&&s.infoReplies.length) body+=s.infoReplies.map(e=>'<div class="banner" style="margin-top:8px"><div class="hint"><b>'+esc(e.name||user(e.user_id).name)+'</b> replied: '+esc(e.text)+'</div></div>').join('');
    else if(s.infoReply) body+='<div class="banner" style="margin-top:8px"><div class="hint">Replied: '+esc(s.infoReply)+'</div></div>';
    if(s.onHold) body+='<div class="banner hold" style="margin-top:12px"><div><b>On hold</b>'+(s.holdReason?' — '+esc(s.holdReason):'')+'. Resume to continue, or approve to pass it on.</div></div>';
    body+='<div class="grid" style="gap:9px;margin-top:14px">';
    if(s.canHold){
      // CNG approvals: Approve or Hold (pause), per the CNG flow
      body+='<button class="btn primary" data-fact="'+s.id+'">'+(s.action==='confirm'?'Confirm and pass on':'Approve and pass on')+'</button>'+
        (s.onHold?'<button class="btn" data-frelease="'+s.id+'">Resume (lift the hold)</button>'
                 :'<button class="btn hold" data-fhold="'+s.id+'">Hold (pause here)</button>');
    } else if(approving&&s.cmdDual){
      // Nishant's dual step: sign for himself (CMD still signs next), or sign as CMD too (clears the CMD desk)
      body+='<button class="btn primary" data-fact="'+s.id+'">Approve — send to CMD desk</button>'+
        '<button class="btn primary" data-factcmd="'+s.id+'" style="background:var(--seal);border-color:var(--seal)">Approve as CMD — clear CMD desk too</button>'+
        '<button class="btn hold" data-fask="'+s.id+'">Ask the requester for more</button>'+
        (s.canReject?'<button class="btn bad" data-freject="'+s.id+'">Reject and close</button>':'');
    } else if(approving){
      body+='<button class="btn primary" data-fact="'+s.id+'">'+(s.action==='confirm'?'Confirm and pass on':'Approve and pass on')+'</button>'+
        '<button class="btn" data-fcond="'+s.id+'">Approve with a condition</button>'+
        '<button class="btn hold" data-fask="'+s.id+'">Ask the requester for more</button>'+
        (s.canReject?'<button class="btn bad" data-freject="'+s.id+'">Reject and close</button>':'');
    } else {
      body+='<button class="btn primary" data-fact="'+s.id+'">'+flowActLabel(s)+'</button>'+
        '<button class="btn hold" data-fask="'+s.id+'">Ask the requester for more</button>'+
        (s.canReject?'<button class="btn bad" data-freject="'+s.id+'">Reject</button>':'');
    }
    if(canEsc) body+='<button class="btn hold" data-fesc="'+s.id+'">Escalate past CMD</button>';
    body+='</div>'+(s.cmdDual?'<p class="hint" style="margin-top:12px"><b>Approve</b> signs for you and the file still goes to the CMD desk. <b>Approve as CMD</b> signs for you and clears the CMD desk in one go, so the file moves straight on.</p>':'<p class="hint" style="margin-top:12px">The document cannot be changed from here. Ask the requester for more, or reject it and have it reissued.</p>')+'</div>';
    return body;
  }
  if(canEsc) return '<div class="card pad"><h3>'+esc(s.label)+'</h3><p class="hint" style="margin-top:6px">With '+esc(withWho)+'. As a division approver you can escalate it past CMD.</p><button class="btn hold" data-fesc="'+s.id+'" style="margin-top:12px;width:100%">Escalate past CMD</button></div>';
  return '<div class="card pad"><h3>With '+esc(withWho)+'</h3><p class="hint" style="margin-top:6px">Current step: <b>'+esc(s.label)+'</b>. You can watch its progress on the left.</p></div>';
}
function wireFlowDetail(v){
  if($('#fl-back',v)) $('#fl-back',v).onclick=()=>history.back();
  if($('#fl-del',v)) $('#fl-del',v).onclick=()=>flowCancelDialog(ROUTE.id);
  $$('[data-ffile]',v).forEach(b=>b.onclick=()=>{ const id=b.dataset.ffile;
    let rec=null; DB.flows.forEach(f=>f.steps.forEach(s=>s.files.forEach(fl=>{if(fl.id===id)rec=fl}))); if(rec) openViewer(rec); });
  $$('[data-freject]',v).forEach(b=>b.onclick=()=>flowReject(b.dataset.freject));
  $$('[data-fesc]',v).forEach(b=>b.onclick=()=>flowEscalate(b.dataset.fesc));
  $$('[data-fact]',v).forEach(b=>b.onclick=()=>flowAct(b.dataset.fact));
  $$('[data-factcmd]',v).forEach(b=>b.onclick=()=>flowAct(b.dataset.factcmd,'approve_cmd'));
  $$('[data-fcond]',v).forEach(b=>b.onclick=()=>flowCondDialog(b.dataset.fcond));
  $$('[data-fask]',v).forEach(b=>b.onclick=()=>flowAskDialog(b.dataset.fask));
  $$('[data-fhold]',v).forEach(b=>b.onclick=()=>flowHoldDialog(b.dataset.fhold));
  $$('[data-frelease]',v).forEach(b=>b.onclick=()=>flowReleaseHold(b.dataset.frelease));
  $$('[data-fsys]',v).forEach(b=>b.onclick=()=>flowSysApprove(b.dataset.fsys));
  $$('[data-fattach]',v).forEach(b=>b.onclick=()=>flowAttachDialog(b.dataset.fattach));
  $$('[data-frwd]',v).forEach(b=>b.onclick=()=>flowRewind(b.dataset.frwd));
  $$('[data-fassign]',v).forEach(b=>b.onclick=()=>flowAssignActor(b.dataset.fassign));
  // requester's reply panel (answer an "ask for more")
  const reply={files:[]};
  if($('#fr-files',v)) uploader($('#fr-files',v),reply.files,{mode:'support',single:false,label:'Attach the corrected document or anything asked'});
  if($('#fr-go',v)) $('#fr-go',v).onclick=async()=>{ const t=$('#fr-text',v).value.trim(); if(t.length<2){ $('#fr-err',v).textContent='Write a short response.'; return; }
    const rep=$('#fr-replace',v)?$('#fr-replace',v).checked:false;
    if(rep && !reply.files.length){ $('#fr-err',v).textContent='Attach the new document to replace the original.'; return; }
    $('#fr-go',v).disabled=true;
    // the original document the replace will drop (remove from storage best-effort)
    const flow=DB.flows.find(x=>x.id===ROUTE.id); const oldPaths=(rep&&flow&&flow.steps[0])?flow.steps[0].files.map(fl=>fl.path).filter(Boolean):[];
    try{ await rpc('flow_reply',{p_request:ROUTE.id,p_text:t,p_files:filesPayload(reply.files),p_replace:rep});
      if(oldPaths.length){ try{ await removeObjects(oldPaths); }catch(e){} }
      await load(['flows','notif'],[ROUTE.id]); toast(rep?'New document sent and the original replaced.':'Sent to the approver.','ok'); render(); }
    catch(e){ $('#fr-go',v).disabled=false; $('#fr-err',v).textContent=(e.message||'').replace(/^.*?: /,''); } };
}
/* item 14: site-proof steps (SRN "Service / material received proof", GRN "Material
   image at site"). One PO/WO can cover work at many stations, so every photo gets the
   STATION it is from and the DATE it was taken. Photos can come from the gallery here
   (they're usually taken earlier, on site), not only the live camera. */
const isSiteStep=s=>!!s&&(s.stage==='SRN'||s.stage==='GRN')&&(s.action==='upload'||s.needsFile);
const IMG_RX=/\.(jpe?g|png|webp|heic|heif)$/i;
const istToday=()=>new Date(Date.now()+5.5*3600e3).toISOString().slice(0,10);
function sitePhotoTagger(mount,list,meta){
  const paint=()=>{
    const today=istToday(), imgs=list.filter(f=>IMG_RX.test(f.name||''));
    if(!imgs.length){ mount.innerHTML=''; return; }
    mount.innerHTML='<div class="site-tags"><div class="hint" style="margin:0 0 8px">For each photo, pick the <b>station</b> and the <b>date</b> it was taken.</div>'+
      imgs.map(f=>{ const m=meta[f.path]||(meta[f.path]={station:'',date:today});
        return '<div class="site-tag-row"><div class="st-name" title="'+esc(f.name)+'">'+esc(f.name)+'</div>'+
          '<input type="text" list="dl-st-site" placeholder="Station" autocomplete="off" value="'+esc(m.station)+'" data-st="'+esc(f.path)+'">'+
          '<input type="date" max="'+today+'" value="'+esc(m.date)+'" data-sd="'+esc(f.path)+'"></div>'; }).join('')+
      (imgs.length>1?'<button type="button" class="btn ghost sm" data-stsame style="margin-top:2px">Same station &amp; date as the first photo for all</button>':'')+'</div>'+
      '<datalist id="dl-st-site">'+STATIONS.map(st=>'<option value="'+esc(st.name)+'">'+esc(st.code+' · '+st.state)+'</option>').join('')+'</datalist>';
    $$('[data-st]',mount).forEach(i=>i.oninput=()=>{ meta[i.dataset.st].station=i.value; });
    $$('[data-sd]',mount).forEach(i=>i.onchange=()=>{ meta[i.dataset.sd].date=i.value; });
    const same=$('[data-stsame]',mount); if(same) same.onclick=()=>{ const first=meta[imgs[0].path]; imgs.forEach(f=>{ meta[f.path].station=first.station; meta[f.path].date=first.date; }); paint(); };
  };
  paint(); return paint;
}
/* every photo must be tagged; returns {items} for flow_photo_tags, or {err} */
function siteTagItems(list,meta){
  const imgs=list.filter(f=>IMG_RX.test(f.name||'')), today=istToday();
  for(const f of imgs){ const m=meta[f.path];
    if(!m||!String(m.station||'').trim()) return {err:'Choose the station for every photo.'};
    if(!m.date) return {err:'Choose the date for every photo.'};
    if(m.date>today) return {err:'A photo date cannot be in the future.'}; }
  return {items:imgs.map(f=>({path:f.path,station:String(meta[f.path].station).trim(),photo_date:meta[f.path].date}))};
}
/* item 7: attach supporting documents to ANY step (step's people, raiser, admins) */
function flowAttachDialog(stepId){
  const x=flowFindStep(stepId); if(!x) return; const s=x.s; const local={files:[]}; const site=isSiteStep(s), meta={};
  modal({title:site?'Add site photos':'Attach a file',
    body:'<p style="margin-top:0">'+(site?'Add photos to <b>'+esc(s.label)+'</b> — each one with its station and date.':'Attach supporting documents to <b>'+esc(s.label)+'</b>.')+' Everyone who can see this flow will see them on this step.</p>'+
      '<div style="margin-top:8px"><div id="fat-files"></div></div><div id="fat-tags" style="margin-top:8px"></div>'+
      '<div id="fat-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="fat-go">Attach</button>',
    onOpen:(mv,cl)=>{
      const repaint=site?sitePhotoTagger($('#fat-tags',mv),local.files,meta):null;
      uploader($('#fat-files',mv),local.files,{mode:'support',single:false,gallery:site,onChange:repaint||undefined,
        label:site?'Add site photos from the gallery or camera — several at once is fine':'Add photos, PDF, Excel or Word — several at once is fine'});
      $('#fat-go',mv).onclick=async()=>{ if(!local.files.length) return $('#fat-err',mv).textContent='Pick at least one file.';
        let tags=null; if(site){ const r=siteTagItems(local.files,meta); if(r.err) return $('#fat-err',mv).textContent=r.err; tags=r.items; }
        $('#fat-go',mv).disabled=true;
        try{ if(tags&&tags.length) await rpc('flow_photo_tags',{p_items:tags});
          await rpc('flow_add_file',{p_step:stepId,p_files:filesPayload(local.files)}); cl(); await load(['flows','notif'],flowIdsOfStep(stepId)); toast(site?'Site photos added.':'File attached.','ok'); render(); }
        catch(e){ $('#fat-go',mv).disabled=false; $('#fat-err',mv).textContent=(e.message||'').replace(/^.*?: /,''); } }; }});
}
/* Approve with a condition — a normal approve whose condition rides in data_val */
function flowCondDialog(stepId){
  const x=flowFindStep(stepId); if(!x) return; const s=x.s; const local={files:[]}; let dt=''; const state={text:'',tagIds:[]};
  modal({title:'Approve with a condition',
    body:'<p style="margin-top:0">Approve <b>'+esc(s.label)+'</b> with a condition the people after you will see. Type <b>@</b> to tag a person in it.</p>'+
      '<div style="margin-top:8px"><label for="fcnd">Condition <span class="hint">type @ to tag</span></label>'+
      '<div style="position:relative"><textarea id="fcnd" placeholder="e.g. @Jai Singhal release only after the revised quote is attached"></textarea><div id="fcnd-sug" style="position:absolute;z-index:6;left:0;right:0;display:none"></div></div>'+
      '<div id="fcnd-tags" class="row" style="gap:6px;flex-wrap:wrap;margin-top:6px"></div></div>'+
      (s.needsDatetime?'<div style="margin-top:10px"><label for="fcnd-dt">Confirmation date & time</label><input type="datetime-local" id="fcnd-dt"></div>':'')+
      '<div style="margin-top:10px"><label>Supporting documents <span class="hint">optional</span></label><div id="fcnd-files"></div></div>'+
      '<div id="fcnd-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="fcnd-go">Continue</button>',
    onOpen:(mv,cl)=>{ uploader($('#fcnd-files',mv),local.files,{mode:'support',single:false,label:'Add supporting files (optional)'});
      wireMention(mv,'#fcnd','#fcnd-sug','#fcnd-tags',state);
      $('#fcnd-go',mv).onclick=()=>{ const cond=(state.text||$('#fcnd',mv).value).trim(); if(cond.length<3) return $('#fcnd-err',mv).textContent='Write the condition.';
        if(s.needsDatetime){ dt=$('#fcnd-dt',mv).value; if(!dt) return $('#fcnd-err',mv).textContent='Select the date & time.'; }
        const files=filesPayload(local.files); cl();
        flowPinThen(()=>flowCall(stepId,'act','Condition: '+cond, files.length?files:null, dt?new Date(dt).toISOString():null, {condition:cond}, 'Approved with a condition.')); }; }});
}
/* Ask the requester for more — soft send-back, nothing downstream resets */
/* Several tagged people travel in REPORTING ORDER: whoever reports (directly or
   indirectly) to another tagged person goes first; unrelated people keep the order
   they were tagged. Mirrors tag_order() in the database (which has the final say). */
function hierOrder(ids){
  ids=(ids||[]).slice(); if(ids.length<2) return ids;
  const under=(a,b)=>{ let u=user(a); const seen=new Set();
    for(let k=0;k<15&&u&&u.managerId&&!seen.has(u.managerId);k++){ if(u.managerId===b) return true; seen.add(u.managerId); u=DB.users.find(x=>x.id===u.managerId); }
    return false; };
  const below=id=>ids.filter(x=>x!==id&&under(x,id)).length;
  return ids.map((id,i)=>({id,i,n:below(id)})).sort((a,b)=>a.n-b.n||a.i-b.i).map(x=>x.id);
}
/* @-mention autocomplete: type @ to tag one or MANY people. state={text,tagIds:[]}. */
function wireMention(mv, taSel, sugSel, tagsSel, state, opts){
  const ta=$(taSel,mv), sug=$(sugSel,mv), tags=$(tagsSel,mv);
  if(!Array.isArray(state.tagIds)) state.tagIds=[];
  const paintTags=()=>{ if(!tags) return;
    const ordered=!!(opts&&opts.ordered)&&state.tagIds.length>1;   // item 10: show the travel order
    const shown=ordered?hierOrder(state.tagIds):state.tagIds;          // reporting order, same as the server uses
    tags.innerHTML=shown.map((id,i)=>'<span class="tag t-prog">'+(ordered?(i+1)+'. ':'@')+esc(user(id).name)+' <button class="btn ghost sm" data-untag="'+id+'" style="padding:0 5px">×</button></span>').join(ordered?' <span class="hint" style="align-self:center">→</span> ':' ')+
      (ordered?'<div class="hint" style="width:100%;margin-top:4px">It goes to them one at a time in <b>reporting order</b> — whoever reports to the other goes first, their manager checks after — then comes back to you. People with no “Reports to” link keep the order you tagged them.</div>':'');
    $$('[data-untag]',tags).forEach(b=>b.onclick=()=>{ state.tagIds=state.tagIds.filter(x=>x!==b.dataset.untag); paintTags(); }); };
  const token=()=>{ const v=ta.value, c=ta.selectionStart, up=v.slice(0,c), m=up.match(/@([A-Za-z0-9 .]*)$/); return m?{q:m[1],start:c-m[0].length}:null; };
  ta.oninput=()=>{ state.text=ta.value; const t=token(); if(!t||!sug){ if(sug)sug.style.display='none'; return; }
    const q=t.q.trim().toLowerCase(), hits=DB.users.filter(u=>u.active&&u.id!==ME.id&&state.tagIds.indexOf(u.id)<0&&u.name.toLowerCase().includes(q)).slice(0,6);
    if(!hits.length){ sug.style.display='none'; return; }
    sug.innerHTML='<div class="results">'+hits.map(u=>'<button data-mu="'+u.id+'"><div class="av sm">'+inits(u.name)+'</div><div style="min-width:0"><b>'+esc(u.name)+'</b><div class="hint">'+esc(u.role||'')+(u.dept?' · '+esc(u.dept):'')+'</div></div></button>').join('')+'</div>';
    sug.style.display='block';
    $$('[data-mu]',sug).forEach(b=>b.onclick=()=>{ const u=user(b.dataset.mu), before=ta.value.slice(0,t.start), after=ta.value.slice(ta.selectionStart);
      ta.value=before+'@'+u.name+' '+after; state.text=ta.value; if(state.tagIds.indexOf(u.id)<0) state.tagIds.push(u.id); sug.style.display='none'; paintTags(); ta.focus(); }); };
  paintTags();
}
function flowAskDialog(stepId){
  const x=flowFindStep(stepId); if(!x) return; const s=x.s; const state={text:'',tagIds:[]};
  modal({title:'Ask for more / tag people',
    body:'<p style="margin-top:0">Send <b>'+esc(s.label)+'</b> back without rejecting — nothing already approved changes. Type <b>@</b> to tag one or more people to check it. With several people it goes to them <b>one at a time, in reporting order</b> (whoever reports to the other goes first, their manager checks after), then comes back to you; it leaves your “Waiting on me” meanwhile. Leave it untagged to send to the requester.</p>'+
      '<div style="margin-top:8px"><label for="fask">What do you need? <span class="hint">type @ to tag — add as many as you like</span></label>'+
      '<div style="position:relative"><textarea id="fask" placeholder="e.g. @T Rao @Jai Singhal please re-check the amount"></textarea><div id="fask-sug" style="position:absolute;z-index:6;left:0;right:0;display:none"></div></div>'+
      '<div id="fask-tags" class="row" style="gap:6px;flex-wrap:wrap;margin-top:6px"></div></div>'+
      '<div id="fask-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn hold" id="fask-go">Send</button>',
    onOpen:(mv,cl)=>{ wireMention(mv,'#fask','#fask-sug','#fask-tags',state,{ordered:true});
      $('#fask-go',mv).onclick=()=>{ const t=(state.text||$('#fask',mv).value).trim(); if(t.length<3) return $('#fask-err',mv).textContent='Say what you need.'; cl();
        flowPinThen(()=>flowAskCall(stepId,t,hierOrder(state.tagIds))); }; }});
}
async function flowAskCall(stepId,remark,toIds){ busy(true);
  const tos=(toIds&&toIds.length)?toIds:null;
  try{ await rpc('flow_ask',{p_step:stepId,p_remark:remark,p_pin:flowCall._pin,p_tos:tos}); await load(['flows','notif'],flowIdsOfStep(stepId));
    toast(tos?('Tagged '+tos.map(id=>user(id).name).join(', ')+' to check.'):'Sent to the requester.','ok'); render(); }
  catch(e){ fail(e); } finally{ busy(false); } }
/* Super-admin override: system-approve every step up to and including this one */
function flowSysApprove(stepId){
  const x=flowFindStep(stepId); if(!x||!ME.owner) return; const f=x.f, s=x.s;
  const span=f.steps.filter(st=>st.pos>=f.currentPos&&st.pos<=s.pos&&(st.status==='pending'||st.status==='waiting')).length;
  const next=f.steps.find(st=>st.pos===s.pos+1);
  modal({title:'System-approve as super admin',
    body:'<p style="margin-top:0">Approve every step up to and including <b>'+esc(s.label)+'</b> in one go.</p>'+
      '<div class="banner" style="margin-top:8px"><div class="hint"><b>'+span+' step'+(span===1?'':'s')+'</b> will be marked <b style="color:var(--indigo)">System Approved — by super admin</b> and locked. '+
      (next?('It then sits live with <b>'+esc(next.actors.map(id=>user(id).name).join(', ')||'—')+'</b> at “'+esc(next.label)+'”, whose action buttons go active.'):'This <b>completes</b> the request.')+'</div></div>'+
      '<p class="hint" style="margin-top:8px">The full hierarchy stays visible to everyone. Signed with your PIN.</p>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="fsa-go">System-approve</button>',
    onOpen:(mv,cl)=>{ $('#fsa-go',mv).onclick=()=>{ cl(); flowPinThen(()=>flowSysCall(stepId)); }; }});
}
async function flowSysCall(stepId){ busy(true);
  try{ await rpc('flow_owner_approve',{p_step:stepId,p_pin:flowCall._pin}); await load(['flows','notif'],flowIdsOfStep(stepId)); toast('System-approved by super admin.','ok'); render(); }
  catch(e){ fail(e); } finally{ busy(false); } }
/* Super-admin step-back: reopen this step and clear every decision from here onward */
function flowRewind(stepId){
  const x=flowFindStep(stepId); if(!x||!ME.owner) return; const f=x.f, s=x.s;
  const cleared=f.steps.filter(st=>st.pos>=s.pos&&st.status!=='waiting').length;
  modal({title:'Reopen as super admin',
    body:'<p style="margin-top:0">Step back to <b>'+esc(s.label)+'</b> and make it live again.</p>'+
      '<div class="banner hold" style="margin-top:8px"><div class="hint">This clears <b>'+cleared+' decision'+(cleared===1?'':'s')+'</b> from this step onward — <b>system approvals and ordinary ones alike</b> — so the flow runs again from here. '+
      'It then sits live with <b>'+esc(s.actors.map(id=>user(id).name).join(', ')||'—')+'</b>, whose buttons go active.'+(f.status==='completed'?' The completed request reopens.':'')+'</div></div>'+
      '<p class="hint" style="margin-top:8px">Uploaded documents stay attached. Signed with your PIN.</p>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn hold" id="frw-go">Reopen from here</button>',
    onOpen:(mv,cl)=>{ $('#frw-go',mv).onclick=()=>{ cl(); flowPinThen(()=>flowRewindCall(stepId)); }; }});
}
async function flowRewindCall(stepId){ busy(true);
  try{ await rpc('flow_owner_rewind',{p_step:stepId,p_pin:flowCall._pin}); await load(['flows','notif'],flowIdsOfStep(stepId)); toast('Reopened from this step.','ok'); render(); }
  catch(e){ fail(e); } finally{ busy(false); } }
/* Admin/owner: map the right person onto a step whose approver didn't resolve (or needs changing) */
function flowAssignActor(stepId){
  const x=flowFindStep(stepId); if(!x||!(ME.owner||ME.admin)) return; const s=x.s;
  const cur=s.actors.map(id=>user(id).name).join(', ')||'— nobody yet —';
  // the blueprint name of this step (the part after the "—"), used to map it everywhere
  const mm=(s.label||'').match(/.*—\s*(.+)$/); const srcName=(mm?mm[1]:'').trim();
  const canAll=!!srcName && s.actorKind==='person';   // name→person map is unambiguous only for single-approver steps
  const opts=DB.users.filter(u=>u.active).slice().sort((a,b)=>a.name.localeCompare(b.name))
    .map(u=>'<option value="'+u.id+'">'+esc(u.name)+(u.empId?' ('+esc(u.empId)+')':'')+(u.dept?' — '+esc(u.dept):'')+'</option>').join('');
  modal({title:'Change approver',
    body:'<p class="hint" style="margin-top:0"><b>'+esc(s.label)+'</b><br>Currently with: <b>'+esc(cur)+'</b>. Pick the right person — they can act straight away, and the change is recorded in the trail.</p>'+
      '<div style="margin-top:12px"><label for="fa-u">Approver</label><select id="fa-u"><option value="">— choose a person —</option>'+opts+'</select></div>'+
      (canAll?'<label style="display:flex;align-items:flex-start;gap:9px;margin:14px 0 0"><input type="checkbox" id="fa-all" style="width:auto;margin-top:3px"> <span><b>Apply to every flow</b><div class="hint">Make “'+esc(srcName)+'” mean this person on <b>all</b> PO / WO / CNG flows — the ones running now and all new ones — until you change it again. Leave unticked to change only this one file.</div></span></label>':'<p class="hint" style="margin-top:10px">This changes the approver on this file only.</p>')+
      '<div id="fa-err" class="hint" style="color:var(--stop);margin-top:8px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="fa-go">Set approver</button>',
    onOpen:(mv,cl)=>{ $('#fa-go',mv).onclick=async()=>{ const uid=$('#fa-u',mv).value; if(!uid) return $('#fa-err',mv).textContent='Choose a person.';
      const all=canAll&&$('#fa-all',mv)&&$('#fa-all',mv).checked;
      $('#fa-go',mv).disabled=true;
      try{
        if(all){ const n=await rpc('admin_map_actor',{p_src:srcName,p_user:uid});
          try{ await rpc('flow_assign_actor',{p_step:stepId,p_user:uid}); }catch(e){}   // make sure THIS step updates too
          await load(['flows','notif']); cl();
          toast('Set for every flow. '+(n?('Updated '+n+' live file'+(n===1?'':'s')+'.'):'This file updated.'),'ok'); render(); }
        else { await rpc('flow_assign_actor',{p_step:stepId,p_user:uid}); await load(['flows','notif'],flowIdsOfStep(stepId)); cl(); toast('Approver updated on this file.','ok'); render(); }
      }
      catch(e){ $('#fa-go',mv).disabled=false; $('#fa-err',mv).textContent=(e&&e.message)||'Could not update.'; } }; }});
}
function flowFindStep(id){ for(const f of DB.flows) for(const s of f.steps) if(s.id===id) return {f,s}; return null; }
async function flowCall(stepId,kind,remark,files,datetime,data,okMsg){
  busy(true);
  try{ await rpc('flow_act',{p_step:stepId,p_kind:kind,p_remark:remark||'',p_pin:flowCall._pin,p_files:files||null,p_datetime:datetime||null,p_data:data||null});
    await load(['flows','notif'],flowIdsOfStep(stepId)); toast(okMsg||'Done.','ok'); render(); }
  catch(e){ fail(e); }
  finally{ busy(false); }
}
function flowPinThen(run){
  if(!pinOK(ME)) return modal({title:'Set your PIN first',body:'<p style="margin-top:0">Every action is signed with your daily PIN. You have not set one for '+esc(fmtD(Date.now()))+'.</p>',
    footer:'<button class="btn" data-x>Not now</button><button class="btn primary" id="g">Set PIN</button>',onOpen:(v,c)=>{$('#g',v).onclick=()=>{c();pinDialog()}}});
  modal({title:'Confirm with your PIN',body:'<p style="margin-top:0">Enter today\'s PIN to sign.</p>'+pinBoxes('fpb')+'<div id="fpe" style="color:var(--stop);font-size:13px;margin-top:8px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="fpg">Sign</button>',
    onOpen:(v,close)=>{ const code=wirePinBoxes(v,'fpb',()=>$('#fpg',v).click());
      $('#fpg',v).onclick=()=>{ flowCall._pin=code(); close(); run(); }; }});
}
function flowReject(stepId){
  const x=flowFindStep(stepId); if(!x) return;
  modal({title:'Send back for changes',body:'<p style="margin-top:0">Rejecting <b>'+esc(x.s.label)+'</b>.</p><div><label for="frr">Reason</label><textarea id="frr" placeholder="What needs to change"></textarea></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn bad" id="frg">Reject</button>',
    onOpen:(mv,cl)=>{$('#frg',mv).onclick=()=>{const reason=$('#frr',mv).value.trim(); if(reason.length<3) return toast('Add a reason.','bad'); cl();
      flowPinThen(()=>flowCall(stepId,'reject',reason,null,null,null,'Sent back for changes.')); }}});
}
/* CNG "Hold": pause the step in place (reason + PIN). It does not go back to the raiser. */
function flowHoldDialog(stepId){
  const x=flowFindStep(stepId); if(!x) return;
  modal({title:'Put this step on hold',
    body:'<p style="margin-top:0">Pausing <b>'+esc(x.s.label)+'</b>. It stays on this step (it does <b>not</b> go back to the raiser), reminders stop, and everyone can see it is on hold. You can resume it any time, or approve to pass it on.</p>'+
      '<div><label for="fhr">Reason for the hold</label><textarea id="fhr" placeholder="Why it is being paused"></textarea></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn hold" id="fhg">Hold</button>',
    onOpen:(mv,cl)=>{$('#fhg',mv).onclick=()=>{const reason=$('#fhr',mv).value.trim(); if(reason.length<3) return toast('Add a short reason.','bad'); cl();
      flowPinThen(()=>flowHoldCall(stepId,reason)); }}});
}
async function flowHoldCall(stepId,reason){ busy(true);
  try{ await rpc('flow_hold',{p_step:stepId,p_reason:reason,p_pin:flowCall._pin}); await load(['flows','notif'],flowIdsOfStep(stepId)); toast('Put on hold.','ok'); render(); }
  catch(e){ fail(e); } finally{ busy(false); } }
function flowReleaseHold(stepId){
  (async()=>{ busy(true);
    try{ await rpc('flow_release',{p_step:stepId}); await load(['flows','notif'],flowIdsOfStep(stepId)); toast('Resumed.','ok'); render(); }
    catch(e){ fail(e); } finally{ busy(false); } })();
}
function flowEscalate(stepId){
  const x=flowFindStep(stepId); if(!x) return;
  modal({title:'Escalate past CMD',body:'<p style="margin-top:0">This skips the CMD desk and sends it straight to <b>Nishant Bhandari</b> for approval, to speed up payment.</p>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn hold" id="feg">Escalate</button>',
    onOpen:(mv,cl)=>{$('#feg',mv).onclick=()=>{cl(); flowPinThen(()=>flowCall(stepId,'escalate','',null,null,null,'Escalated to Nishant.')); }}});
}
/* delete a whole flow: requester (before any approval) or an admin/owner (anytime) */
function flowCancelDialog(id){
  const f=DB.flows.find(x=>x.id===id); if(!f) return;
  const mine=f.requesterId===ME.id, approved=flowApprovedYet(f);
  modal({title:'Delete this request',
    body:'<p style="margin-top:0">Delete <b>'+esc(f.ref)+'</b> ('+esc(flowHeadLabel(f.head))+' · '+esc(f.division)+(f.title?' · '+esc(f.title):'')+')?</p>'+
      '<p class="hint">'+(mine&&!approved?'You raised this and no one has approved it yet, so you can remove it.':'Admin delete — this request is removed for everyone.')+' Every step, document and history row on it goes, and the deletion is logged permanently.</p>'+
      '<div style="margin-top:12px"><label for="fc-why">Reason</label><input id="fc-why" type="text" placeholder="e.g. raised the wrong indent"></div><div id="fc-err" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
    footer:'<button class="btn" data-x>Keep it</button><button class="btn bad" id="fc-go">Delete</button>',
    onOpen:(mv,cl)=>{ $('#fc-go',mv).onclick=async()=>{ const why=$('#fc-why',mv).value.trim(); if(why.length<3) return $('#fc-err',mv).textContent='Give a short reason.';
      $('#fc-go',mv).disabled=true;
      const paths=[]; f.steps.forEach(s=>s.files.forEach(fl=>fl.path&&paths.push(fl.path))); (f._files||[]).forEach(fl=>fl.path&&paths.push(fl.path));
      try{ try{ await removeObjects(paths); }catch(e){}
        await rpc('flow_cancel',{p_request:id,p_why:why}); cl(); await load(['flows','notif'],[id]); toast('Request deleted.','ok'); go({name:'mine'}); }
      catch(e){ $('#fc-go',mv).disabled=false; $('#fc-err',mv).textContent=(e.message||'').replace(/^.*?: /,''); } }; }});
}
function flowAct(stepId,kind){
  const x=flowFindStep(stepId); if(!x) return; const s=x.s, f=x.f;
  // CNG GRN preparation: Prashant records the received lines here; QRs mint on final approval
  const cngGrn=!!(f&&f.department==='CNG'&&s.stage==='GRN'&&s.substep===1);
  const grn={no:'',invoice:'',lines:[{code:'',acc:'',rate:''}]};
  if(cngGrn&&!garudaLoaded) loadGaruda();
  const local={files:[],support:[]};   // uploaded file records
  let dt=''; const dataFields={}; let payMode='full'; const advices=[{pct:'',rec:null},{pct:'',rec:null},{pct:'',rec:null},{pct:'',rec:null}];
  let body='<p style="margin-top:0">'+esc(s.label)+'</p>';
  if(cngGrn){
    body+='<div class="card pad" style="margin:4px 0 2px"><h4 style="margin:0 0 6px;font-size:13px">Received lines</h4>'+
      '<p class="hint" style="margin:0 0 10px">Add each item received against this PO and the quantity accepted. One QR sticker is made per accepted unit when the GRN is finally approved.</p>'+
      '<div class="grid g2" style="gap:10px"><div><label for="gr-no">GRN number</label><input id="gr-no" type="text" placeholder="e.g. GRN-9"></div>'+
      '<div><label for="gr-inv">Invoice number <span class="hint" style="font-weight:400">optional</span></label><input id="gr-inv" type="text"></div></div>'+
      '<div id="fa-grn-lines" style="margin-top:10px"></div>'+
      '<button class="btn sm" id="gr-add" style="margin-top:8px">+ Add a line</button>'+
      '<datalist id="cng-items-dl"></datalist></div>';
  }
  if(s.action==='payment'){
    body+='<div class="seg" id="fp-mode" style="margin:8px 0"><button data-m="full" class="on">Full advice</button><button data-m="partial">Partial advice</button></div>'+
      '<div id="fp-partial" class="hide"><div class="hint">Add up to 4 advices, each with its percentage and PDF.</div><div id="fp-adv"></div></div>'+
      '<div style="margin-top:10px"><label>Advice document</label><div id="fa-files"></div></div>';
  } else if(s.action==='data'){
    body+=s.fieldsSpec.map((lbl,i)=>'<div style="margin-top:8px"><label>'+esc(lbl)+'</label><input type="text" data-df="'+i+'"></div>').join('')+
      (s.needsFile?'<div style="margin-top:10px"><label>Attach copy</label><div id="fa-files"></div></div>':'');
  } else {
    if(s.needsFile){ const multiPO=(s.stage==='Purchase'&&s.action==='initiate');
      body+='<div style="margin-top:10px"><label>'+(multiPO?'Attach purchase order(s) — one indent can have several':isSiteStep(s)?'Site photos — add photos from every station where the work was done':'Upload document(s)')+'</label><div id="fa-files"></div>'+
        (isSiteStep(s)?'<div id="fa-sitetags" style="margin-top:8px"></div>':'')+'</div>'; }
  }
  if(s.needsDatetime) body+='<div style="margin-top:10px"><label for="fa-dt">Confirmation date & time</label><input type="datetime-local" id="fa-dt"></div>';
  // supporting documents are allowed on every step (quotations, comparisons, photos…)
  body+='<div style="margin-top:10px"><label>Supporting documents <span class="hint">optional</span></label><div id="fa-supp"></div></div>';
  body+='<div style="margin-top:10px"><label for="fa-rem">Remark <span class="hint">optional</span></label><input type="text" id="fa-rem"></div><div id="fa-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>';
  modal({title:flowActLabel(s),body:body,footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="fa-go">Continue</button>',
    onOpen:(mv,cl)=>{
      // item 14: at the site-proof step each photo gets its station + date (gallery allowed)
      const siteMeta={}, siteRepaint=$('#fa-sitetags',mv)?sitePhotoTagger($('#fa-sitetags',mv),local.files,siteMeta):null;
      flowAct._siteMeta=siteMeta;
      if($('#fa-files',mv)) uploader($('#fa-files',mv),local.files,siteRepaint
        ?{mode:'support',single:false,gallery:true,onChange:siteRepaint,label:'Add site photos from the gallery or camera — several at once is fine'}
        :{mode:'support',single:false,label:'Tap to upload (PDF, image, Excel, Word) — add more than one if needed'});
      if($('#fa-supp',mv)) uploader($('#fa-supp',mv),local.support,{mode:'support',single:false,label:'Add supporting files (optional)'});
      if($('#fp-adv',mv)){ const paint=()=>{ $('#fp-adv',mv).innerHTML=advices.map((a,i)=>'<div class="row" style="gap:8px;margin-top:6px;align-items:center"><input type="number" min="0" max="100" placeholder="%" data-pct="'+i+'" value="'+esc(a.pct)+'" style="width:80px"><div style="flex:1" id="adv-f-'+i+'"></div></div>').join('');
        advices.forEach((a,i)=>{ $('[data-pct="'+i+'"]',mv).oninput=e=>a.pct=e.target.value; a._list=a._list||[]; uploader($('#adv-f-'+i,mv),a._list,{mode:'support',single:true,label:'Advice '+(i+1)+' PDF'}); }); };
        paint(); }
      $$('#fp-mode button',mv).forEach(b=>b.onclick=()=>{payMode=b.dataset.m; $$('#fp-mode button',mv).forEach(x=>x.classList.toggle('on',x.dataset.m===payMode)); $('#fp-partial',mv).classList.toggle('hide',payMode!=='partial'); });
      if(cngGrn){
        const dl=$('#cng-items-dl',mv), fillDl=()=>{ if(dl&&!dl.children.length) dl.innerHTML=(DB.garudaItems||[]).map(i=>'<option value="'+esc(i.code)+'">'+esc(i.name)+'</option>').join(''); };
        fillDl(); if(!garudaLoaded) loadGaruda().then(fillDl);
        const no=$('#gr-no',mv); if(no) no.oninput=e=>grn.no=e.target.value; const inv=$('#gr-inv',mv); if(inv) inv.oninput=e=>grn.invoice=e.target.value;
        const paintLines=()=>{ const box=$('#fa-grn-lines',mv); if(!box) return;
          box.innerHTML=grn.lines.map((ln,i)=>'<div class="row" style="gap:8px;margin-top:6px;align-items:center;flex-wrap:wrap">'+
            '<input class="gl-code" data-i="'+i+'" list="cng-items-dl" placeholder="Item code" value="'+esc(ln.code)+'" style="flex:2;min-width:150px">'+
            '<input class="gl-acc" data-i="'+i+'" type="number" min="0" placeholder="Qty accepted" value="'+esc(ln.acc)+'" style="width:130px">'+
            '<input class="gl-rate" data-i="'+i+'" type="text" placeholder="Rate" value="'+esc(ln.rate)+'" style="width:90px">'+
            (grn.lines.length>1?'<button class="btn ghost sm gl-del" data-i="'+i+'" style="color:var(--stop);padding:0 8px">×</button>':'')+'</div>').join('');
          $$('.gl-code',box).forEach(el=>el.oninput=e=>grn.lines[+e.target.dataset.i].code=e.target.value.trim());
          $$('.gl-acc',box).forEach(el=>el.oninput=e=>grn.lines[+e.target.dataset.i].acc=e.target.value);
          $$('.gl-rate',box).forEach(el=>el.oninput=e=>grn.lines[+e.target.dataset.i].rate=e.target.value);
          $$('.gl-del',box).forEach(el=>el.onclick=()=>{ grn.lines.splice(+el.dataset.i,1); paintLines(); }); };
        paintLines();
        if($('#gr-add',mv)) $('#gr-add',mv).onclick=()=>{ grn.lines.push({code:'',acc:'',rate:''}); paintLines(); };
      }
      $('#fa-go',mv).onclick=()=>{
        const err=$('#fa-err',mv); err.textContent='';
        const primary=filesPayload(local.files), supp=filesPayload(local.support);
        let files=primary.concat(supp), data=null;
        if(s.needsFile && !primary.length && s.action!=='payment') return err.textContent='Upload the document first.';
        if(s.needsDatetime){ dt=$('#fa-dt',mv).value; if(!dt) return err.textContent='Select the date & time.'; }
        if(s.action==='data'){ let miss=false; s.fieldsSpec.forEach((lbl,i)=>{const val=$('[data-df="'+i+'"]',mv).value.trim(); if(!val)miss=true; dataFields[lbl]=val;}); if(miss) return err.textContent='Fill all the fields.'; data=dataFields; }
        if(s.action==='payment'){ data={mode:payMode};
          if(payMode==='partial'){ const adv=[]; advices.forEach((a,i)=>{ if(a.pct&&a._list&&a._list.length){ adv.push({pct:Number(a.pct),name:a._list[0].name,path:a._list[0].path}); files=files.concat(filesPayload(a._list)); } });
            if(!adv.length) return err.textContent='Add at least one advice with a % and PDF.'; data.advices=adv; }
          else if(!primary.length) return err.textContent='Upload the advice document.';
        }
        const remark=$('#fa-rem',mv).value.trim();
        let siteTags=null;
        if(isSiteStep(s)){ const r=siteTagItems(local.files,flowAct._siteMeta||{}); if(r.err) return err.textContent=r.err; siteTags=r.items; }
        let grnLots=null;
        if(cngGrn){ grnLots=grn.lines.filter(l=>l.code&&Number(l.acc)>0).map(l=>({item_code:l.code,order_qty:Number(l.acc)||0,delivered_qty:Number(l.acc)||0,accepted_qty:Number(l.acc)||0,rate:l.rate||'',grn_no:grn.no||'',invoice_no:grn.invoice||''}));
          if(!grnLots.length) return err.textContent='Add at least one item with a quantity accepted.'; }
        cl(); flowPinThen(async()=>{
          // save each photo's station + date first; the database attaches them as the step records the files
          if(siteTags&&siteTags.length){ try{ await rpc('flow_photo_tags',{p_items:siteTags}); }catch(e){ fail(e); return; } }
          if(grnLots){ try{ await rpc('cng_save_lots',{p_request:f.id,p_lots:grnLots}); }catch(e){ fail(e); return; } }
          flowCall(stepId,kind||'act',remark,files.length?files:null,dt?new Date(dt).toISOString():null,data,cngGrn?'GRN lines saved.':(kind==='approve_cmd'?'Approved as CMD — the CMD desk is cleared.':'Signed.')); });
      };
    }});
}

/* ============================================================
   Boot
   ============================================================ */
window.addEventListener('offline',()=>{if(!$('#off')){const d=document.createElement('div');d.id='off';d.className='offline';d.textContent='You are offline — changes cannot be saved until the connection is back.';document.body.appendChild(d)}});
window.addEventListener('online',()=>{const d=$('#off');if(d)d.remove();if(ME){ pendingFlowsAll=true; reloadSoon(DATA_PARTS); }});
/* When the app returns to the foreground: apply anything that arrived while it was
   in the background. It no longer re-downloads everything on every app switch (that
   was a big share of the data transfer) — only if the live connection dropped (the
   subscribe() handler catches that) or the app was away for more than 10 minutes.
   Keeps the requester's view in step with the gateman/HR after they sign. */
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='hidden'){ hiddenAt=Date.now(); return; }
  if(!ME) return;
  const away=hiddenAt?Date.now()-hiddenAt:0; hiddenAt=0;
  if(away>10*60000){ DATA_PARTS.forEach(p=>pendingParts.add(p)); pendingFlowsAll=true; }
  if(away>60*60000) pendingParts.add('people');
  if(pendingParts.size&&navigator.onLine){ clearTimeout(reloadT); reloadT=setTimeout(flushReload,300); }
  else if(renderSoon._due){ renderSoon._due=false; renderSoon(); }
});
if('serviceWorker' in navigator&&location.protocol==='https:') navigator.serviceWorker.register('sw.js').catch(()=>{});
document.title=CONFIG.APP_NAME||'SETU';

(async function boot(){
  // If a session looks stored, raise the splash at once so the sign-in page never
  // flashes (and can't be tapped) while the token is restored. Departments are
  // public reference data, loaded with everyone else after sign-in (paintSignIn
  // falls back to the seeded list), so there's no need to fetch them up front.
  try{ for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); if(k&&k.indexOf('sb-')===0&&/-auth-token$/.test(k)){ showSplash('Signing you in…'); break; } } }catch(e){}
  SB.auth.onAuthStateChange((event,session)=>{
    if(event==='SIGNED_OUT'){ leave(); return }
    if(event==='PASSWORD_RECOVERY'&&session){
      recovering=true;
      newPasswordDialog({title:'Set your new password',intro:'You arrived from a reset link. Choose a new password to finish.',
        onDone:()=>{ recovering=false; if(!ME) enter(session) }});
      return;
    }
    if(session&&!ME&&!recovering) enter(session);
  });
  const _pubTag=(location.hash.match(/^#g\/(.+)$/)||[])[1];   // a scanned public QR link
  const {data:{session}}=await SB.auth.getSession();
  if(session) enter(session);
  else if(_pubTag){ hideSplash(); garPublicView(decodeURIComponent(_pubTag)); }
  else { hideSplash(); paintSignIn(); }
})();
