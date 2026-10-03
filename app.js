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
let DB={users:[],requests:[],audit:[],templates:[],departments:[],projects:[],notifs:[],passes:[],flows:[]};
let STATIONS=[], ME=null, ROUTE={name:'dash'};
const byCode=new Map(), byName=new Map();
function indexStations(){ byCode.clear(); byName.clear();
  STATIONS.forEach(s=>{byCode.set(s.code.toUpperCase(),s);byName.set(s.name.toLowerCase(),s)}) }

let skipPop=false;   // set when a dialog rewinds its own history entry, so the router ignores that one pop
/* ---------- toast / modal ---------- */
function toast(m,k){const t=document.createElement('div');t.className='toast '+(k||'');t.textContent=m;$('#toasts').appendChild(t);
  setTimeout(()=>{t.style.transition='opacity .3s';t.style.opacity='0';setTimeout(()=>t.remove(),320)},3600)}
function modal({title,body,footer,cls,onOpen}){
  const v=document.createElement('div');v.className='veil';
  v.innerHTML='<div class="modal '+(cls||'')+'"><div class="h"><h3>'+esc(title)+'</h3><button class="btn ghost sm" data-x>Close</button></div>'+
    '<div class="c">'+body+'</div>'+(footer?'<div class="f">'+footer+'</div>':'')+'</div>';
  $('#modal-root').appendChild(v);
  const mid=uid(); let armed=false;
  const onPop=()=>{ v.remove(); window.removeEventListener('popstate',onPop) };
  const close=()=>{ v.remove(); window.removeEventListener('popstate',onPop);
    if(armed&&history.state&&history.state.mid===mid){ skipPop=true; history.back() } };
  /* the dialog is a history entry so the phone's back button closes it — but if another dialog
     just closed, its rewind is still in flight; arm only after that has landed, or this dialog
     would mistake the rewind for a back press and close itself immediately */
  const arm=()=>{ if(!v.isConnected) return; try{ history.pushState(Object.assign({},history.state||ROUTE,{modal:true,mid}),'') }catch(e){}
    window.addEventListener('popstate',onPop); armed=true };
  if(skipPop) window.addEventListener('popstate',()=>setTimeout(arm,0),{once:true}); else arm();
  v.addEventListener('click',e=>{if(e.target===v||e.target.hasAttribute('data-x'))close()});
  document.addEventListener('keydown',function k(e){if(e.key==='Escape'){close();document.removeEventListener('keydown',k)}});
  if(onOpen)onOpen(v,close); return {el:v,close};
}
/* every failed call surfaces its reason; the database writes them to be read */
const fail=e=>{const m=(e&&(e.message||e.error_description||e.hint))||'Something went wrong.';toast(m.replace(/^.*?: /,''),'bad');console.error(e)};
async function rpc(fn,args){const {data,error}=await SB.rpc(fn,args||{}); if(error) throw error; return data}
function busy(on){let v=$('#busy'); if(on&&!v){v=document.createElement('div');v.id='busy';v.className='busy-veil';v.innerHTML='<span class="spin"></span>';document.body.appendChild(v)} if(!on&&v)v.remove()}

/* ============================================================
   Loading everything this person is allowed to see
   ============================================================ */
async function load(){
  const q=[
    SB.from('profiles').select('*'),
    SB.from('requests').select('*').order('created_at',{ascending:false}),
    SB.from('steps').select('*').order('position'),
    SB.from('tasks').select('*').order('assigned_at'),
    SB.from('files').select('*').order('created_at'),
    SB.from('notes').select('*').order('created_at'),
    SB.from('audit').select('*').order('created_at',{ascending:false}).limit(500),
    SB.from('templates').select('*').order('name'),
    SB.from('departments').select('name').order('name'),
    SB.from('projects').select('name').order('name'),
    SB.from('stations').select('*').order('name'),
    SB.from('usage_daily').select('*'),
    SB.from('notifications').select('*').order('created_at',{ascending:false}).limit(60),
    SB.from('gate_passes').select('*').order('created_at',{ascending:false}).limit(3000),
    SB.from('flow_requests').select('*').order('created_at',{ascending:false}).limit(2000),
    SB.from('flow_steps').select('*').order('pos'),
    SB.from('flow_step_actors').select('*'),
    SB.from('flow_files').select('*').order('created_at'),
    SB.from('flow_audit').select('*').order('created_at',{ascending:false}).limit(1500)
  ];
  const r=await Promise.all(q);
  const bad=r.find(x=>x.error); if(bad) throw bad.error;
  const [prof,req,steps,tasks,files,notes,audit,tpl,dept,proj,st,usage,notif,passes,freq,fsteps,factors,ffiles,faudit]=r.map(x=>x.data||[]);

  DB.users=prof.map(p=>({id:p.id,name:p.name,email:p.email,role:p.role||'',dept:p.dept||'',
    admin:p.is_admin,owner:!!p.is_owner,manager:p.is_manager,seeAll:p.see_all,gateman:!!p.gateman,gateOnly:!!p.gate_only,hrHead:!!p.hr_head,active:p.active,mustChange:!!p.must_change_password,pages:Array.isArray(p.pages)?p.pages:null,
    managerId:p.manager_id,managerConfirmed:p.manager_confirmed,pinDate:p.pin_date,
    stats:{lastLogin:ts(p.last_login),logins:p.logins||0,activeMs:Number(p.active_ms)||0,daily:{}}}));
  const U={}; DB.users.forEach(u=>U[u.id]=u);
  usage.forEach(x=>{const u=U[x.user_id]; if(u) u.stats.daily[x.day]=Number(x.active_ms)||0});

  const R={};
  DB.requests=req.map(x=>R[x.id]={id:x.id,ref:x.ref,type:x.type,requesterId:x.requester_id,status:x.status,
    current:x.current_step,infoStep:x.info_step,f:x.fields||{},createdAt:ts(x.created_at),closedAt:ts(x.closed_at),
    chain:[],files:[],notes:[]});
  const S={};
  steps.forEach(s=>{const r=R[s.request_id]; if(!r) return;
    const step=S[s.id]={id:s.id,userId:s.user_id,status:s.status,remark:s.remark||'',condition:s.condition||'',
      actedAt:ts(s.acted_at),files:[],tasks:[]};
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
  DB.templates=tpl.map(t=>({id:t.id,name:t.name,ownerId:t.owner_id,shared:t.shared,steps:t.steps||[],createdAt:ts(t.created_at)}));
  DB.departments=dept.map(d=>d.name);
  DB.projects=proj.map(p=>p.name);
  STATIONS=st.map(s=>({code:s.code,name:s.name,state:s.state||''})); indexStations();
  DB.notifs=notif.map(x=>({id:x.id,requestId:x.request_id,kind:x.kind,title:x.title,body:x.body||'',ts:ts(x.created_at),read:!!x.read_at}));
  DB.passes=passes.map(g=>({id:g.id,ref:g.ref,kind:g.kind,employeeId:g.employee_id||'',name:g.emp_name||'',dept:g.dept||'',purpose:g.purpose||'',
    requesterId:g.requester_id,hodId:g.hod_id,hrId:g.hr_id,reqSelfie:g.requester_selfie,hodSelfie:g.hod_selfie,hrSelfie:g.hr_selfie,
    hodAt:ts(g.hod_at),hrAt:ts(g.hr_at),rejectBy:g.reject_by,rejectReason:g.reject_reason||'',rejectedAt:ts(g.rejected_at),
    gateBy:g.gate_by,outAt:ts(g.out_at),returnAt:ts(g.return_at),status:g.status,passDate:g.pass_date,createdAt:ts(g.created_at)}));

  // ALDS PO/WO flows
  const FR={};
  DB.flows=freq.map(x=>FR[x.id]={id:x.id,ref:x.ref,head:x.head,division:x.division,requesterId:x.requester_id,
    title:x.title||'',fields:x.fields||{},status:x.status,currentPos:x.current_pos,createdAt:ts(x.created_at),closedAt:ts(x.closed_at),
    steps:[],audit:[]});
  const FS={};
  fsteps.forEach(s=>{const f=FR[s.request_id]; if(!f) return;
    f.steps[s.pos]=FS[s.id]={id:s.id,pos:s.pos,stage:s.stage,substep:s.substep,label:s.label,actorKind:s.actor_kind,
      teamKey:s.team_key,action:s.action,needsFile:s.needs_file,needsDatetime:s.needs_datetime,fieldsSpec:s.fields_spec||[],
      canReject:s.can_reject,rejectTo:s.reject_to,escalatable:s.escalatable,status:s.status,actedBy:s.acted_by,actedAt:ts(s.acted_at),
      remark:s.remark||'',datetimeVal:ts(s.datetime_val),dataVal:s.data_val,actors:[],files:[]}});
  factors.forEach(a=>{const s=FS[a.step_id]; if(s) s.actors.push(a.user_id)});
  ffiles.forEach(f=>{const s=FS[f.step_id]; const rec={id:f.id,name:f.name,path:f.path,size:Number(f.size)||0,by:f.uploaded_by};
    if(s) s.files.push(rec); else if(FR[f.request_id]) FR[f.request_id]._files=(FR[f.request_id]._files||[]).concat(rec)});
  faudit.forEach(a=>{const f=FR[a.request_id]; if(f) f.audit.push({ts:ts(a.created_at),actorName:a.actor_name,action:a.action,detail:a.detail||''})});
  DB.flows.forEach(f=>f.steps=f.steps.filter(Boolean));

  const me=DB.users.find(u=>u.id===(ME&&ME.id));
  if(me) ME=me;
  // wipe gate selfies older than a week: remove my own old selfie files, then drop the references
  if(!load._expired){ load._expired=true; gpExpireSweep(); }
}
async function gpExpireSweep(){
  try{
    const cut=Date.now()-7*864e5, paths=[];
    DB.passes.forEach(g=>{ if(g.requesterId===ME.id&&g.createdAt<cut){ [g.reqSelfie,g.hodSelfie,g.hrSelfie].forEach(p=>{ if(p) paths.push(p) }) } });
    if(paths.length){ try{ await SB.storage.from('documents').remove(paths) }catch(e){} }
    await SB.rpc('gp_expire_photos');
  }catch(e){}
}
let reloadT=null;
async function reload(){ try{ await load(); render(); paintNav(); paintPin() }catch(e){ fail(e) } }   // paintNav also repaints the tab bar
function reloadSoon(){ clearTimeout(reloadT); reloadT=setTimeout(reload,600) }

/* ---------- model helpers (read-only views over what was loaded) ---------- */
const user=id=>DB.users.find(u=>u.id===id)||{name:'Unknown',role:'',email:'',id:'',dept:''};
function holder(r){ if(r.status==='Approved'||r.status==='Rejected')return null;
  if(r.status==='Info Requested')return user(r.requesterId);
  const s=r.chain[r.current]; return s?user(s.userId):null }
const isMyTurn=r=>r.status==='In Progress'&&r.chain[r.current]&&r.chain[r.current].userId===ME.id;
const needsMyInfo=r=>r.status==='Info Requested'&&r.requesterId===ME.id;
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
const gpClearedToday=()=>DB.passes.filter(g=>g.gateBy===ME.id&&g.passDate===DAY());   // what this gateman has cleared today
const gpAllToday=()=>DB.passes.filter(g=>g.passDate===DAY());
const gpAtGate=()=>isGateman(ME)?DB.passes.filter(g=>(g.status==='pending_gate'||g.status==='out')&&g.passDate===DAY()&&g.requesterId!==ME.id):[];   // a gateman clears others, never their own pass
const gpBadge=()=>gpMyNext().length+gpAtGate().length;
const GP_KINDS=[['early','Early going'],['halfday','Half day leave'],['official','Official work outpass']];
const gpKindNote=k=>k==='early'?('Early-going passes left this month: <b>'+Math.max(0,2-gpEarlyUsed())+' of 2</b>. The gateman signs you out — you are not returning.')
  :k==='halfday'?'Half day leave — the gateman signs you out; you are not expected back today.'
  :'Official work outpass — the gateman records your out-time and, when you return, the time back. Not capped.';
const gpKindLabel=g=>{const k=(typeof g==='string')?g:g.kind;const m=GP_KINDS.find(x=>x[0]===k);return m?m[1]:k;};
const gpEarlyUsed=()=>{const m=DAY().slice(0,7);return gpMine().filter(g=>g.kind==='early'&&g.status!=='rejected'&&String(g.passDate).slice(0,7)===m).length};
const GP_STATUS={pending_hod:['t-wait','With HOD'],pending_hr:['t-wait','With HR'],pending_gate:['t-prog','Cleared — show the gate'],out:['t-hold','Out'],closed:['t-ok','Closed'],rejected:['t-bad','Declined']};
const gpTag=g=>{const x=GP_STATUS[g.status]||['t-wait',g.status];return '<span class="tag '+x[0]+'">'+x[1]+'</span>'};

/* ---------- org structure: departments, their divisions, and the ALDS auto-hierarchies ---------- */
const DEPT_DIV={
  'ALDS':['ONM','Project','Retail','Transport'],
  'PCD':['Project','Operation','Purchase'],
  'HO':['Admin','HO-CNG'],
  'CNG':['Maintenance','Logistics','Project','IT Department','Accounts','Operation','Sales & Marketing','Store','Liaison']
};
const DEPTS=Object.keys(DEPT_DIV);
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
  const alias={'o&m':'ONM','onm':'ONM','o and m':'ONM','retail':'Retail','project':'Project','transport':'Transport'};
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
      '<input type="file" class="hide" '+(opts.single?'':'multiple ')+'accept="'+accept+'"'+(support?' capture="environment"':'')+'>'+
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
const lists=()=>'<datalist id="dl-role">'+uniqOf('role').map(d=>'<option value="'+esc(d)+'">').join('')+'</datalist>';
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

async function paintSignIn(){
  try{ const st=await rpc('system_state'); firstAccount=(st&&st.users===0) }catch(e){ firstAccount=false }
  if(firstAccount) signMode='signup';
  const signup=signMode==='signup';
  $('#si-swapwrap').classList.toggle('hide',firstAccount);
  $('#si-err').classList.add('hide');
  $('#si-title').textContent=firstAccount?'Set up the first account':(signup?'Create your account':'Sign in');
  $('#si-sub').textContent=firstAccount?'Nobody is registered yet. This first account runs the system and can register everyone else.'
    :(signup?'Once registered, anyone raising a request can add you to their approval chain.':'Use your work email and password.');
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
     '<div><label for="f-pass">Password</label><input id="f-pass" type="password" placeholder="At least 8 characters"></div>'+
     '<div class="hint">You can pick your manager once you are in, from your directory entry.</div></div>'
    :'<div class="grid" style="gap:12px"><div><label for="f-email">Work email</label><input id="f-email" type="email" autocomplete="username"></div>'+
     '<div><label for="f-pass">Password</label><input id="f-pass" type="password" autocomplete="current-password"></div>'+
     '<div style="text-align:right;margin-top:-4px"><button class="btn ghost sm" id="si-forgot" style="padding:0;font-weight:500">Forgot your password?</button></div></div>';
  $$('#si-fields input').forEach(i=>i.addEventListener('keydown',e=>{if(e.key==='Enter')$('#si-go').click()}));
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
      const {data,error}=await SB.auth.signUp({email,password:pass,options:{data:{name,role,dept}}});
      if(error) return siErr(error.message);
      if(!data.session){ siErr('Account created. Check your email for the confirmation link, then sign in.'); signMode='login'; return }
      return; // onAuthStateChange takes it from here
    }
    const {error}=await SB.auth.signInWithPassword({email,password:pass});
    if(error) return siErr(/invalid/i.test(error.message)?'Wrong email or password.':error.message);
  } finally { btn.disabled=false }
};
$('#signout').onclick=async()=>{ await SB.auth.signOut() };

async function enter(session){
  busy(true);
  try{
    ME={id:session.user.id};
    await load();
    if(!ME.name){ toast('Your directory entry has not been created yet. Try again in a moment.','bad'); busy(false); return }
    if(!ME.active){ toast('This account is switched off. Ask an administrator.','bad'); await SB.auth.signOut(); busy(false); return }
    await SB.rpc('record_login');
    $('#signin').classList.add('hide'); $('#app').classList.remove('hide');
    $('#me-av').textContent=inits(ME.name); $('#me-name').textContent=ME.name; $('#me-role').textContent=ME.role;
    pushRegister();
    paintPin(); const h=routeFromHash();
    const home=(GATE_ONLY()||HR_HEAD())?{name:'gate'}:(((h&&h.name!=='detail')||(h&&DB.requests.some(r=>r.id===h.id)))?h:{name:'dash'});
    go(home,true); subscribe();
    const incomplete=()=>!ME.role||(!ME.admin&&(!ME.dept||DB.departments.indexOf(ME.dept)<0));
    // gate-only accounts don't approve anything: no PIN, no directory-completion nag, no pending-work popup
    if(ME.mustChange) setTimeout(()=>newPasswordDialog({title:'Choose your own password',intro:'You signed in with a temporary password from your administrator. Pick your own to continue.',
        onDone:async()=>{ try{ await rpc('password_changed') }catch(e){} ME.mustChange=false; if(!restrictedAcct()&&incomplete()) profileDialog(); else if(!restrictedAcct()&&!pinOK(ME)) pinDialog() }}),300);
    else if(restrictedAcct()) {}
    else if(incomplete()) setTimeout(profileDialog,400);
    else if(!pinOK(ME)) setTimeout(pinDialog,450);
    else setTimeout(pendingPopup,500);
  }catch(e){ fail(e) } finally { busy(false) }
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
    onOpen:(v,close)=>{ $$('[data-go]',v).forEach(b=>b.onclick=()=>{close();go({name:b.dataset.go})}); }});
}
function leave(){ pushForget(); ME=null; unsubscribe(); $('#app').classList.add('hide'); $('#signin').classList.remove('hide'); signMode='login'; paintSignIn() }

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
  return '<div class="hint" style="font-weight:600;color:var(--ink-soft);margin-top:2px">Pages they can open</div>'+
    '<div id="'+id+'" style="display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;margin-top:6px">'+
    OPTIONAL_PAGES.map(pg=>'<label style="display:flex;align-items:center;gap:8px;margin:0;font-size:13.5px"><input type="checkbox" value="'+pg.k+'" style="width:auto" '+(set.indexOf(pg.k)>-1?'checked':'')+'> '+esc(pg.label)+'</label>').join('')+'</div>'+
    '<div class="hint" style="margin-top:6px">Dashboard, Notifications, Waiting on me, Tasks given to me, Needs my input and My requests are always available — they carry the work. Admins always see every page.</div>';
}
const readChecklist=(id,v)=>$$('#'+id+' input:checked',v).map(c=>c.value);

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
      '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="cu-see" style="width:auto"> <span><b>Can see every request</b><div class="hint">Oversight without admin rights, e.g. audit.</div></span></label>'+
      '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="cu-gateonly" style="width:auto"> <span><b>Gate Pass only</b><div class="hint">Signs in to the Gate Pass page and nothing else.</div></span></label>'+
      '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="cu-hrhead" style="width:auto"> <span><b>HR Head (Gate Pass reports)</b><div class="hint">Views every gate pass + the Reports page. Restricted to those.</div></span></label>'+
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
      $('#cu-go',v).onclick=async()=>{
        const body={name:$('#cu-name',v).value.trim(),email:$('#cu-email',v).value.trim().toLowerCase(),role:$('#cu-role',v).value.trim(),dept:$('#cu-dept',v).value,
          manager_id:$('#cu-mgr',v).value||null,is_manager:$('#cu-man',v).checked,see_all:$('#cu-see',v).checked,is_admin:sysRole()==='admin',
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
  const {error}=await SB.storage.from('documents').remove(paths); if(error) throw error; return paths.length }
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
  modal({title:'Delete all data',
    body:'<p style="margin-top:0">This removes <b>every request, ALDS PO/WO flow and gate pass in the system</b> — with all steps, tasks, notes, documents, selfies, notifications and audit rows, and clears the usage counters. Accounts, teams, saved hierarchies and masters stay. All reference numbers restart at 1001.</p>'+
      '<p class="hint">Meant for one moment: the end of testing, before the first real entry. It is logged permanently.</p>'+
      '<div style="margin-top:14px"><label for="pa-c">Type <b>DELETE EVERYTHING</b> to confirm</label><input id="pa-c" type="text" autocomplete="off"></div>'+
      '<div style="margin-top:12px"><label for="pa-why">Why</label><input id="pa-why" type="text" placeholder="e.g. end of testing, going live"></div><div id="pa-err" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn bad" id="pa-go">Delete everything</button>',
    onOpen:(v,close)=>{$('#pa-go',v).onclick=async()=>{const c=$('#pa-c',v).value, why=$('#pa-why',v).value.trim();
      if(c!=='DELETE EVERYTHING') return $('#pa-err',v).textContent='Type it exactly, in capitals.';
      if(why.length<4) return $('#pa-err',v).textContent='Say why.';
      $('#pa-go',v).disabled=true;
      try{ const paths=await rpc('all_file_paths'); await removeObjects(paths);
        const res=await rpc('purge_all_requests',{p_confirm:c,p_why:why}); close(); await load(); toast('Cleared '+res.requests+' requests, '+res.flows+' flows and '+res.gate_passes+' gate passes. Entry starts fresh from 1001.','ok'); go({name:'dash'}) }
      catch(e){ $('#pa-go',v).disabled=false; $('#pa-err',v).textContent=(e.message||'').replace(/^.*?: /,'') }}}});
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
function wireInbox(v){
  $$('[data-n]',v).forEach(el=>el.onclick=async()=>{const x=DB.notifs.find(y=>y.id===+el.dataset.n); if(!x) return;
    if(!x.read){ x.read=true; SB.rpc('mark_read',{p_ids:[x.id]}).then(()=>paintNav()) }
    if(x.requestId&&DB.requests.some(r=>r.id===x.requestId)) go({name:'detail',id:x.requestId}); else render()});
  if($('#nb-all',v)) $('#nb-all',v).onclick=async()=>{ await SB.rpc('mark_all_read'); DB.notifs.forEach(x=>x.read=true); paintNav(); render() };
}
/* opening a request settles everything about it */
function readForRequest(id){ const mine=(DB.notifs||[]).filter(x=>x.requestId===id&&!x.read); if(!mine.length) return;
  mine.forEach(x=>x.read=true); SB.rpc('mark_request_read',{p_request:id}).then(()=>paintNav()) }
/* the Median app: tell OneSignal who this is, so pushes reach the right phone */
function pushRegister(){
  try{
    const m=window.median||window.gonative; if(!m||!m.onesignal||!ME) return;
    if(m.onesignal.login) m.onesignal.login({externalId:ME.id});
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
  const m=modal({title:opts.title||'Set a new password',
    body:'<p class="hint" style="margin-top:0">'+esc(opts.intro||'Choose a password of at least 8 characters. You stay signed in on this device afterwards.')+'</p>'+
      '<div class="grid" style="gap:12px;margin-top:14px"><div><label for="np1">New password</label><input id="np1" type="password" autocomplete="new-password"></div>'+
      '<div><label for="np2">Type it again</label><input id="np2" type="password" autocomplete="new-password"></div></div>'+
      '<div id="np-err" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
    footer:(opts.cancellable?'<button class="btn" data-x>Cancel</button>':'')+'<button class="btn primary" id="np-go">Save password</button>',
    onOpen:(v,close)=>{
      $('#np1',v).focus(); $$('input',v).forEach(i=>i.addEventListener('keydown',e=>{if(e.key==='Enter')$('#np-go',v).click()}));
      $('#np-go',v).onclick=async()=>{
        const a=$('#np1',v).value,b=$('#np2',v).value,err=$('#np-err',v);
        if(a.length<8) return err.textContent='At least 8 characters.';
        if(a!==b) return err.textContent='The two entries do not match.';
        $('#np-go',v).disabled=true;
        const {error}=await SB.auth.updateUser({password:a});
        if(error){ $('#np-go',v).disabled=false; return err.textContent=/same/i.test(error.message)?'That is already your password. Pick a different one.':error.message }
        close(); toast('Password saved.','ok'); if(opts.onDone) opts.onDone();
      };
    }});
  if(!opts.cancellable){ /* a recovery session must end in a new password: no click-away, no escape */
    m.el.onclick=e=>{ if(e.target===m.el) e.stopPropagation() };
    const x=$('[data-x]',m.el); if(x) x.remove();
  }
}
let recovering=false;

/* ---------- realtime: refresh when something visible changes ---------- */
let channel=null;
function subscribe(){
  unsubscribe();
  channel=SB.channel('setu-live')
    .on('postgres_changes',{event:'*',schema:'public',table:'requests'},reloadSoon)
    .on('postgres_changes',{event:'*',schema:'public',table:'steps'},reloadSoon)
    .on('postgres_changes',{event:'*',schema:'public',table:'tasks'},reloadSoon)
    .on('postgres_changes',{event:'*',schema:'public',table:'gate_passes'},reloadSoon)
    .on('postgres_changes',{event:'*',schema:'public',table:'flow_requests'},reloadSoon)
    .on('postgres_changes',{event:'*',schema:'public',table:'flow_steps'},reloadSoon)
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'notifications',filter:'user_id=eq.'+ME.id},p=>{
      const x=p.new||{}; toast(x.title||'Something landed on your desk.','ok'); reloadSoon();
      if(document.visibilityState!=='visible'&&'Notification' in window&&Notification.permission==='granted'){
        try{ const nn=new Notification(x.title||'SETU',{body:(x.body||'').split('\n')[0],icon:'icon-192.png',tag:'setu-'+x.id});
          nn.onclick=()=>{window.focus(); if(x.request_id) go({name:'detail',id:x.request_id}); nn.close()} }catch(e){}
      }})
    .subscribe();
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
  {k:'tpl',label:'Saved hierarchies'},
  {k:'team',label:'My team (managers only)'},
  {k:'all',label:'Requests I can see'},
  {k:'report',label:'Reports'},
  {k:'people',label:'People & masters'},
  {k:'usage',label:'Usage'}
];
const DEFAULT_PAGES=['new','tpl','team','all','report'];   // a plain user's standard set
function allowedPages(u){
  if(u.admin||u.owner) return OPTIONAL_PAGES.map(p=>p.k);   // admins run the system: every page
  if(Array.isArray(u.pages)) return u.pages;                // explicitly set
  return DEFAULT_PAGES;                                     // role default
}
const canSeePage=k=>{ const set=allowedPages(ME); return set.indexOf(k)>-1 };
const GATE_ONLY=()=>!!(ME&&ME.gateOnly&&!ME.admin&&!ME.owner);   // gate-only accounts see only the Gate Pass page
// restricted accounts (gate-only or HR head) are limited to the Gate Pass page and, if allowed, the Reports page
const restrictedAcct=()=>GATE_ONLY()||!!(ME&&ME.hrHead&&!ME.admin&&!ME.owner);
const restrictedPage=k=>!restrictedAcct()||k==='gate'||k==='gpreport';
const PAGES=[
  {k:'dash',label:'Dashboard',grp:'Overview'},
  {k:'inbox',label:'Notifications',grp:'Overview',badge:()=>unread().length},
  {k:'new',label:'Raise a request',grp:'Overview'},
  {k:'gate',label:'Gate Pass',grp:'Overview',badge:()=>gpBadge()},
  {k:'gpreport',label:'Gate Pass Reports',grp:'Overview',when:()=>canSeeReports()},
  {k:'queue',label:'Waiting on me',grp:'My work',badge:()=>myQueue().length+flowMyTurn().length},
  {k:'tasks',label:'Tasks given to me',grp:'My work',badge:()=>myTasks().length},
  {k:'stuck',label:'Needs my input',grp:'My work',badge:()=>myStuck().length},
  {k:'mine',label:'My requests',grp:'My work'},
  {k:'tpl',label:'Saved hierarchies',grp:'My work',badge:()=>myTemplates().length},
  {k:'team',label:'My team',grp:'My work',when:()=>isManager(ME),badge:()=>pendingTeam(ME.id).length},
  {k:'all',label:'Requests I can see',grp:'Records'},
  {k:'report',label:'Reports',grp:'Records'},
  {k:'people',label:'People & masters',grp:'Records'},
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
  const desk=myQueue().length+myTasks().length+myStuck().length+flowMyTurn().length, un=unread().length;
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
      '<button data-act="pin">'+(pinOK(ME)?"Reset today's PIN":"Set today's PIN")+'</button>'+
      '<button data-act="me">My directory entry</button><button data-act="pw">Change password</button>'+
      '<button data-act="out" style="color:var(--stop)">Sign out</button></div>'+
      '<div class="hint" style="margin-top:12px;text-align:center">'+esc(ME.name)+' · '+esc(ME.role||'')+'<br>Built by Sunny Gupta</div>',
    onOpen:(v,close)=>{
      $$('[data-go]',v).forEach(b=>b.onclick=()=>{close();go({name:b.dataset.go})});
      $$('[data-act]',v).forEach(b=>b.onclick=()=>{close();const a=b.dataset.act;
        if(a==='pin')pinDialog(); else if(a==='me')profileDialog(); else if(a==='pw')newPasswordDialog({title:'Change your password',cancellable:true}); else if(a==='out')SB.auth.signOut()});
    }});
}
/* every screen is a history entry, so the Android back button (and the browser's)
   steps back through screens instead of leaving the app */
const routeHash=r=>'#'+r.name+(r.id?'/'+r.id:'');
const go=(r,replace)=>{
  ROUTE=r;
  try{ const url=location.pathname+location.search+routeHash(r);
    if(replace||!history.state) history.replaceState(r,'',url); else if(routeHash(history.state)!==routeHash(r)) history.pushState(r,'',url) }catch(e){}
  paintNav();paintPin();render();window.scrollTo(0,0);
};
window.addEventListener('popstate',e=>{
  if(skipPop){ skipPop=false; return }              // a dialog closed itself and rewound its own entry
  if($('.veil')) return;                            // back pressed with a dialog open: the dialog handles it, the screen stays
  if(ME&&e.state&&e.state.name){ ROUTE=e.state; paintNav(); paintPin(); render(); window.scrollTo(0,0) }
});
/* deep links: opening .../#detail/<id> lands on that request once signed in */
function routeFromHash(){ const m=location.hash.match(/^#([a-z]+)(?:\/([\w-]+))?$/); return m?{name:m[1],id:m[2]}:null }
const head=(t,s)=>{$('#page-title').textContent=t;$('#page-sub').textContent=s||''};
function render(){
  if(!ME) return;
  if(restrictedAcct()&&!restrictedPage(ROUTE.name)) ROUTE={name:'gate'};   // restricted accounts stay within Gate Pass / Reports
  if(ROUTE.name==='gpreport'&&!canSeeReports()) ROUTE={name:GATE_ONLY()||HR_HEAD()?'gate':'dash'};
  if(OPTIONAL_PAGES.some(o=>o.k===ROUTE.name)&&!canSeePage(ROUTE.name)) ROUTE={name:'dash'};
  const v=$('#view');
  switch(ROUTE.name){
    case 'dash': v.innerHTML=viewDash(); wireDash(v); break;
    case 'inbox': v.innerHTML=viewInbox(); wireInbox(v); break;
    case 'new': v.innerHTML=viewNew(); wireNew(v); break;
    case 'queue': v.innerHTML=viewList(myQueue(),'Waiting on me','Requests that cannot move until you act.','Nothing is waiting on you','Requests land here the moment the person before you signs off.')+flowSection('turn'); wireList(v); wireFlowRows(v); break;
    case 'tasks': v.innerHTML=viewTasks(); wireList(v); break;
    case 'stuck': v.innerHTML=viewList(myStuck(),'Needs my input','An approver has asked you for more before they will sign.','No one has asked you for anything','If an approver needs a clarification, it comes back here.'); wireList(v); break;
    case 'mine': v.innerHTML=viewList(DB.requests.filter(r=>r.requesterId===ME.id),'My requests','Everything you have raised.','You have not raised anything yet','Start with Raise a request.')+flowSection('mine'); wireList(v); wireFlowRows(v); break;
    case 'tpl': v.innerHTML=viewTpl(); wireTpl(v); break;
    case 'team': v.innerHTML=viewTeam(); wireTeam(v); break;
    case 'all': v.innerHTML=viewAll()+flowSection('all'); wireList(v); wireFlowRows(v);
      head(ME.admin||ME.seeAll?'All requests':'Requests I can see',ME.admin||ME.seeAll?'You can see every chain in the system':'Only chains you raised, approve, or were given a task in'); break;
    case 'report': v.innerHTML=viewReport(); wireReport(v); head('Reports','Filter the record and download it'); break;
    case 'usage': v.innerHTML=viewUsage(); wireUsage(v); break;
    case 'people': v.innerHTML=viewPeople(); wirePeople(v); head('People & masters','Directory, station master and the permanence rule'); break;
    case 'detail': v.innerHTML=viewDetail(ROUTE.id); wireDetail(v); break;
    case 'gate': v.innerHTML=viewGate(); wireGate(v); break;
    case 'gpreport': v.innerHTML=viewGpReport(); wireGpReport(v); break;
    case 'flowdetail': v.innerHTML=viewFlowDetail(ROUTE.id); wireFlowDetail(v); break;
  }
}

/* ============================================================
   Dashboard
   ============================================================ */
const stat=(k,v,s,acc)=>'<div class="card stat" style="--acc:'+(acc||'var(--indigo)')+'"><div class="k">'+esc(k)+'</div><div class="v num">'+esc(String(v))+'</div><div class="hint">'+esc(s||'')+'</div></div>';
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
  const feed=DB.audit.slice(0,14);
  return warn+'<div class="grid g4">'+
    stat('Waiting on me',q.length,q.length?'Act to unblock the chain':'You are all clear','var(--indigo)')+
    stat('Tasks given to me',tk.length,tk.length?'Close these to unblock a manager':'No task assigned to you','var(--cyan)')+
    stat('Needs my input',st.length,st.length?'Someone asked you for more':'Nothing sent back to you','var(--hold)')+
    stat('Open beyond 7 days',aged,'Out of '+open.length+' open requests',aged?'var(--stop)':'var(--seal)')+'</div>'+
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
       '<div style="min-width:0"><div style="font-size:13.5px"><b>'+esc(a.actorName)+'</b> '+esc(a.action.toLowerCase())+' <a href="#" data-r="'+a.reqId+'">'+esc(a.ref)+'</a></div>'+
       '<div class="hint">'+esc(fmtDT(a.ts))+(a.detail?' · '+esc(a.detail):'')+'</div></div></div>').join('')+'</div>'
      :'<div class="empty"><h3>No activity yet</h3><p class="hint">Raise the first request to start the record.</p></div>')+'</div></div>';
}
function wireDash(v){
  if($('#d-pin',v)) $('#d-pin',v).onclick=pinDialog;
  if($('#d-all',v)) $('#d-all',v).onclick=()=>go({name:'all'});
  $$('tr[data-r]',v).forEach(t=>t.onclick=()=>go({name:'detail',id:t.dataset.r}));
  $$('a[data-r]',v).forEach(a=>a.onclick=e=>{e.preventDefault();go({name:'detail',id:a.dataset.r})});
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
const isFlowDraft=()=>!!(draft&&draft.f&&draft.f.department==='ALDS'&&flowDivOf(draft.f.division));
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
  return '<div class="grid g2">'+
    '<div><label for="o-dept">Department '+req+'</label><select id="o-dept"><option value="">Choose…</option>'+
      DEPTS.map(d=>'<option '+(f.department===d?'selected':'')+'>'+esc(d)+'</option>').join('')+'</select></div>'+
    '<div><label for="o-div">Division '+req+'</label><select id="o-div"'+(f.department?'':' disabled')+'><option value="">'+(f.department?'Choose…':'Pick a department first')+'</option>'+
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
  const bind=(id,key,num)=>{const el=$(id,body);if(el)el.oninput=()=>{f[key]=num?(el.value===''?'':Number(el.value)):el.value}};
  bind('#i-no','indentNo');bind('#i-date','indentDate');bind('#i-rem','remarks');bind('#w-no','orderNo');bind('#w-date','woDate');bind('#w-vn','vendorName');bind('#w-va','vendorAddress');
  bind('#w-vs','vendorState');bind('#w-vsc','vendorStateCode');bind('#w-vp','vendorPan');bind('#w-vg','vendorGstin');bind('#w-vc','vendorContact');bind('#w-ba','billingAddress');bind('#w-rem','remarks');
  bind('#w-ap','amountPre',1);bind('#w-aq','amountPost',1);bind('#i-erp','erpCreated');bind('#w-erp','erpCreated');
  const cat=$('#i-cat',body); if(cat) cat.onchange=()=>{f.category=cat.value;paintSite($('#i-sitewrap',body))};
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
  if(!f.division) return note.textContent='Choose a division.';
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
  const head=t==='indent'?'PO':'WO', div=flowDivOf(f.division);
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
      draft=null; toast('ALDS '+head+' flow created and signed at step 1.','ok'); go({name:'flowdetail',id});
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
   list.map(r=>'<tr data-r="'+r.id+'"><td><b>'+esc(docTitle(r))+'</b><div class="hint">'+esc(r.ref)+' · '+esc(user(r.requesterId).name)+'</div></td><td class="hint meta">'+esc(typeLabel(r))+'</td>'+
   '<td class="num meta">'+(r.type==='workorder'?money(r.f.amountPost):'—')+'</td><td class="hint num meta">'+esc(fmtD(r.createdAt))+'</td><td class="meta">'+tagFor(r)+'</td><td class="hint pos">'+esc(stepLabel(r))+'</td></tr>').join('')+'</tbody></table>';
}
function viewList(list,t,s,et,es){ head(t,s);
  if(!list.length) return '<div class="card"><div class="empty"><h3>'+esc(et)+'</h3><p class="hint">'+esc(es)+'</p></div></div>';
  return '<div class="card">'+rowsHTML(list.slice().sort((a,b)=>b.createdAt-a.createdAt))+'</div>'; }
const wireList=v=>$$('tr[data-r]',v).forEach(t=>t.onclick=()=>go({name:'detail',id:t.dataset.r}));
function viewTasks(){
  head('Tasks given to me','Work a manager has assigned you inside a request');
  const l=myTasks();
  if(!l.length) return '<div class="card"><div class="empty"><h3>No tasks assigned to you</h3><p class="hint">When a manager breaks their step into pieces, your piece lands here.</p></div></div>';
  return '<div class="card"><table class="cards"><thead><tr><th>Request</th><th>Given by</th><th>Given</th><th>The task</th></tr></thead><tbody>'+
    l.map(r=>{const m=myOpenTask(r);return '<tr data-r="'+r.id+'"><td><b>'+esc(docTitle(r))+'</b><div class="hint">'+esc(typeLabel(r))+' · '+esc(r.ref)+'</div></td><td class="hint meta">from '+esc(user(m.step.userId).name)+'</td><td class="hint num meta">'+esc(fmtD(m.task.assignedAt))+'</td><td class="pos">'+esc(m.task.task)+'</td></tr>'}).join('')+'</tbody></table></div>';
}
let allF={q:'',status:'',type:''};
function viewAll(){
  let l=visible().sort((a,b)=>b.createdAt-a.createdAt);
  if(allF.status) l=l.filter(r=>r.status===allF.status); if(allF.type) l=l.filter(r=>r.type===allF.type);
  if(allF.q){const q=allF.q.toLowerCase();l=l.filter(r=>(docTitle(r)+' '+r.ref+' '+user(r.requesterId).name+' '+(r.f.remarks||'')).toLowerCase().includes(q))}
  return '<div class="card pad" style="margin-bottom:16px"><div class="row filters-row" style="flex-wrap:wrap;gap:12px"><div style="flex:1;min-width:220px"><input id="a-q" type="text" placeholder="Search number, site, vendor, requester or remark" value="'+esc(allF.q)+'"></div>'+
    '<select id="a-ty" style="width:auto"><option value="">Both types</option><option value="indent" '+(allF.type==='indent'?'selected':'')+'>Indent</option><option value="workorder" '+(allF.type==='workorder'?'selected':'')+'>Work order</option></select>'+
    '<select id="a-st" style="width:auto"><option value="">Every status</option>'+['In Progress','Info Requested','Approved','Rejected'].map(s=>'<option '+(allF.status===s?'selected':'')+'>'+s+'</option>').join('')+'</select></div></div>'+
    (l.length?'<div class="card">'+rowsHTML(l)+'</div>':'<div class="card"><div class="empty"><h3>Nothing matches that</h3></div></div>');
}
document.addEventListener('input',e=>{if(e.target.id==='a-q'){allF.q=e.target.value;const p=e.target.selectionStart;render();const n=$('#a-q');if(n){n.focus();n.setSelectionRange(p,p)}}});
document.addEventListener('change',e=>{if(e.target.id==='a-st'){allF.status=e.target.value;render()} if(e.target.id==='a-ty'){allF.type=e.target.value;render()}});

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
  head(docTitle(r),typeLabel(r)+' · '+r.ref+' · raised by '+user(r.requesterId).name+' on '+fmtD(r.createdAt));
  const mine=isMyTurn(r), info=needsMyInfo(r), f=r.f, mt=myOpenTask(r);
  const mayExtend=(r.requesterId===ME.id||ME.admin||ME.owner)&&r.status!=='Rejected';
  let banner='';
  if(mayExtend&&r.status==='Approved') banner='<div class="banner hold"><div><b>This closed after only '+r.chain.length+' approver'+(r.chain.length>1?'s':'')+'.</b><div class="hint" style="color:var(--hold)">If more people still need to sign, add them — the request reopens and moves to the next one. Reopening is recorded.</div></div><button class="btn hold sm" style="margin-left:auto" id="d-extend">Add approvers</button></div>';
  else if(mayExtend&&r.status==='In Progress'&&!holder(r)) banner='<div class="banner hold"><div><b>This request has no one left to act on it.</b><div class="hint" style="color:var(--hold)">Add the next approver(s) to keep it moving.</div></div><button class="btn hold sm" style="margin-left:auto" id="d-extend">Add approvers</button></div>';
  if(mt) banner='<div class="banner live"><div><b>You have a task on this request.</b><div class="hint">Close it below and it goes back to '+esc(user(r.chain[mt.stepIndex].userId).name)+'.</div></div></div>';
  else if(mine) banner='<div class="banner live"><div><b>This is with you.</b><div class="hint">Everyone after you is locked out until you act. Open the attached document before signing.</div></div></div>';
  else if(info) banner='<div class="banner hold"><div><b>'+esc(user(r.chain[r.infoStep].userId).name)+' has asked you for more.</b><div class="hint">Reply at step '+(r.infoStep+2)+' below. The chain picks up where it stopped.</div></div></div>';
  else if(r.status==='In Progress') banner='<div class="banner live"><div><b>With '+esc(user(r.chain[r.current].userId).name)+' at step '+(r.current+2)+'.</b><div class="hint">You can follow the whole chain, but only the holder can act.</div></div></div>';

  let nodes='<div class="node done"><div class="dot">1</div><div class="body"><div class="row"><div><h4>'+esc(user(r.requesterId).name)+'</h4><div class="meta">'+esc(user(r.requesterId).role)+(user(r.requesterId).dept?' · '+esc(user(r.requesterId).dept):'')+' — raised this request</div></div>'+
    '<span class="tag t-ok" style="margin-left:auto">Raised</span></div><div class="meta" style="margin-top:6px">'+esc(fmtDT(r.createdAt))+'</div>'+fileListHTML(r.files)+'</div></div>';
  r.chain.forEach((s,i)=>{
    const u=user(s.userId), prevDept=deptAt(r,i-1), thisDept=deptAt(r,i);
    if(thisDept&&prevDept&&thisDept!==prevDept) nodes+='<div class="handover"><span>'+esc(prevDept)+'</span><i></i><b>'+esc(thisDept)+'</b></div>';
    const live=(r.status==='In Progress'&&i===r.current)||(r.status==='Info Requested'&&i===r.infoStep);
    const cls=s.status==='approved'?'done':s.status==='conditional'?'done cond':s.status==='rejected'?'stop':s.status==='info'?'hold':live?'live':s.status==='waiting'?'locked':'';
    const tag={approved:'<span class="tag t-ok">Approved</span>',conditional:'<span class="tag t-ok">Approved with a condition</span>',rejected:'<span class="tag t-bad">Rejected</span>',info:'<span class="tag t-hold">Asked for more</span>',
      pending:stepBlocked(s)?'<span class="tag t-hold">Work given out</span>':'<span class="tag t-prog">Holding it now</span>',waiting:'<span class="tag t-wait">Waiting turn</span>'}[s.status]||'';
    const dot=(s.status==='approved'||s.status==='conditional')?'✓':s.status==='rejected'?'✕':s.status==='info'?'?':String(i+2);
    nodes+='<div class="node '+cls+'" id="step-'+i+'"><div class="dot">'+dot+'</div><div class="body"><div class="row"><div><h4>'+esc(u.name)+(isManager(u)?' <span class="hint" style="font-weight:400">· manager</span>':'')+'</h4><div class="meta">'+esc(u.role)+(u.dept?' · '+esc(u.dept):'')+'</div></div><span style="margin-left:auto">'+tag+'</span></div>'+
      (s.actedAt?'<div class="meta" style="margin-top:6px">'+esc(fmtDT(s.actedAt))+'</div>':'')+(s.condition?'<div class="said"><b>Condition:</b> '+esc(s.condition)+'</div>':'')+(s.remark?'<div class="said">'+esc(s.remark)+'</div>':'')+
      (s.status==='waiting'?'<div class="meta" style="margin-top:6px">Opens once step '+(i+1)+' is done.</div>':'')+fileListHTML(s.files)+subBranchHTML(r,s)+'</div></div>';
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
    panel='<div class="card pad" style="border-color:var(--hold)"><h3>Reply to step '+(r.infoStep+2)+'</h3><p class="hint" style="margin-top:5px">This goes straight back to '+esc(user(r.chain[r.infoStep].userId).name)+'. Earlier approvals stand.</p>'+
      '<div style="margin-top:14px"><label for="i-reply">Your reply</label><textarea id="i-reply" placeholder="Answer what was asked."></textarea></div><div style="margin-top:12px"><label>Add documents</label><div id="i-files"></div></div>'+
      '<button class="btn primary" id="i-send" style="width:100%;margin-top:14px">Send back to '+esc(user(r.chain[r.infoStep].userId).name.split(' ')[0])+'</button></div>';
  } else {
    const h=holder(r);
    panel='<div class="card pad"><h3>'+(h?'Sitting with '+esc(h.name):'Closed')+'</h3><p class="hint" style="margin-top:6px">'+(h?'Nothing for you to do until it reaches you.':(r.status==='Approved'?'Approved by everyone in the chain on '+esc(fmtD(r.closedAt))+'.':'Closed on '+esc(fmtD(r.closedAt))+'. Raise a fresh request if the document is reissued.'))+'</p>'+
      ((r.requesterId===ME.id||ME.admin||ME.owner)&&r.status==='Approved'?'<div class="sep"></div><button class="btn sm" id="d-extend2">Add more approvers</button>':'')+
      (inChain(r)||ME.admin?'<div class="sep"></div><label for="nt">Leave a note</label><textarea id="nt" placeholder="A comment for the chain. It does not move the request."></textarea><button class="btn sm" id="ntb" style="margin-top:9px">Post note</button>':'')+'</div>';
  }
  const facts='<div class="card pad" style="margin-bottom:16px">'+(r.type==='workorder'?'<div class="amount num">'+money(f.amountPost)+'</div><div class="hint">'+money(f.amountPre)+' before GST'+(f.amountPre&&f.amountPost?' · GST '+money(f.amountPost-f.amountPre):'')+'</div>':'<div class="amount num">'+esc(docNo(r))+'</div>')+
    '<div style="margin:8px 0 14px">'+tagFor(r)+'</div><dl class="kv"><dt>Reference</dt><dd class="num">'+esc(r.ref)+'</dd><dt>Type</dt><dd>'+esc(typeLabel(r))+'</dd>'+(f.department?'<dt>Department</dt><dd>'+esc(f.department)+'</dd>':'')+(f.division?'<dt>Division</dt><dd>'+esc(f.division)+'</dd>':'')+(f.erpCreated?'<dt>ERP prepared</dt><dd>'+esc(f.erpCreated)+'</dd>':'')+
    (r.type==='indent'?'<dt>Category</dt><dd>'+esc(f.category||'—')+'</dd><dt>'+(f.category==='Project'?'Project':'Site')+'</dt><dd>'+esc(f.category==='Project'?(f.projectName||'—'):(f.siteName||'—'))+(f.siteCode?' ('+esc(f.siteCode)+')':'')+'</dd><dt>Indent date</dt><dd>'+esc(fmtD(f.indentDate))+'</dd>'
      :'<dt>Order date</dt><dd>'+esc(fmtD(f.woDate))+'</dd><dt>Site</dt><dd>'+esc(f.siteName||'—')+(f.siteCode?' ('+esc(f.siteCode)+')':'')+'</dd><dt>Vendor</dt><dd>'+esc(f.vendorName||'—')+'</dd>'+
       (f.vendorAddress?'<dt>Address</dt><dd>'+esc(f.vendorAddress)+'</dd>':'')+(f.vendorState?'<dt>State</dt><dd>'+esc(f.vendorState)+(f.vendorStateCode?' ('+esc(f.vendorStateCode)+')':'')+'</dd>':'')+
       (f.vendorGstin?'<dt>GSTIN</dt><dd class="num">'+esc(f.vendorGstin)+'</dd>':'')+(f.vendorPan?'<dt>PAN</dt><dd class="num">'+esc(f.vendorPan)+'</dd>':'')+(f.vendorContact?'<dt>Contact</dt><dd>'+esc(f.vendorContact)+'</dd>':'')+(f.billingAddress?'<dt>Billing to</dt><dd>'+esc(f.billingAddress)+'</dd>':''))+
    '<dt>Raised</dt><dd>'+esc(fmtD(r.createdAt))+'</dd><dt>Approvers</dt><dd>'+r.chain.length+' in sequence</dd></dl>'+(f.remarks?'<div class="sep"></div><div class="hint" style="margin-bottom:5px">Remarks</div><div style="white-space:pre-wrap">'+esc(f.remarks)+'</div>':'')+
    ((r.requesterId===ME.id||ME.admin)&&r.status!=='Rejected'&&r.status!=='Info Requested'&&!isMyTurn(r)?'<div class="sep"></div><button class="btn sm" id="d-extend" style="width:100%">'+(r.status==='Approved'?'Reopen and add the next approver':'Add the next approver')+'</button>':'')+
    (ME.owner?'<div class="sep"></div><button class="btn ghost sm" id="d-purge" style="color:var(--stop);padding:0">Delete this request (owner only)</button>':'')+'</div>';
  return '<button class="btn ghost sm" id="d-back" style="margin-bottom:12px">Back</button>'+banner+'<div class="detail-grid"><div><div class="card pad"><h3 style="margin-bottom:16px">The chain</h3><div class="rail">'+nodes+'</div></div>'+notes+'</div><div>'+facts+panel+'</div></div>';
}
function wireDetail(v){
  const r=DB.requests.find(x=>x.id===ROUTE.id); if(!r) return;
  $('#d-back',v).onclick=()=>go({name:'all'});
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
    $('#a-info',v).onclick=()=>{if(!rem()){toast('Tell the requester exactly what you need.','bad');$('#d-rem',v).focus();return} act('info','send '+docNo(r)+' back for more detail')};
    $('#a-no',v).onclick=()=>{if(!rem()){toast('Say why you are rejecting it before you close it.','bad');$('#d-rem',v).focus();return} act('reject','reject '+docNo(r))};
  }
  if(needsMyInfo(r)){
    const files=[]; uploader($('#i-files',v),files,{mode:'support',label:'Add the photos or documents that were asked for'});
    $('#i-send',v).onclick=async()=>{const t=$('#i-reply',v).value.trim(); if(!t&&!files.length){toast('Add a reply or at least one document.','bad');return}
      busy(true); try{ await rpc('reply_info',{p_request:r.id,p_text:t,p_files:filesPayload(files)}); await after('Sent back to '+user(r.chain[r.infoStep].userId).name+'.') }catch(e){fail(e)} finally{busy(false)} };
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
  const A=[['Reference','Type','Document No','Category','Site / Project','Site code','Date on document','Vendor','Vendor GSTIN','Amount before GST','Amount after GST','Remarks','Raised by','Department','Raised on','Status','Currently with','Approval chain','Closed on','Days taken','Documents']];
  l.forEach(r=>{const u=user(r.requesterId),h=holder(r),f=r.f;
    A.push([r.ref,typeLabel(r),docNo(r),f.category||'',f.category==='Project'?(f.projectName||''):(f.siteName||''),f.siteCode||'',fmtD(r.type==='indent'?f.indentDate:f.woDate),f.vendorName||'',f.vendorGstin||'',f.amountPre||'',f.amountPost||'',String(f.remarks||'').replace(/\n+/g,' '),u.name,u.dept||'',fmtD(r.createdAt),r.status,h?h.name:'—',r.chain.map(s=>user(s.userId).name).join(' > '),r.closedAt?fmtD(r.closedAt):'',r.closedAt?((r.closedAt-r.createdAt)/864e5).toFixed(1):'',r.files.map(x=>x.name).join('; ')])});
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
let usageSort='today', storageInfo=null;
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
    '<div class="card scroll-x"><table style="min-width:980px"><thead><tr><th>Person</th><th>Department</th><th>Last signed in</th><th>Today</th><th>7 days</th><th>This month</th><th>All time</th><th>Sign-ins</th><th>Raised</th><th>Decisions</th><th>Tasks</th></tr></thead><tbody>'+
    us.map(u=>{const st=statsOf(u),w=workOf(u);return '<tr><td><div class="row" style="gap:10px"><div class="av sm">'+inits(u.name)+'</div><div><b>'+esc(u.name)+'</b>'+(activeToday(u)?' <span class="tag t-ok">active today</span>':'')+'<div class="hint">'+esc(u.email)+'</div></div></div></td><td class="hint">'+esc(u.dept||'')+'</td><td class="hint">'+(st.lastLogin?esc(fmtDT(st.lastLogin)):'Never signed in')+'</td>'+
      '<td class="num">'+hms(spanMs(u,1))+'</td><td class="num">'+hms(spanMs(u,7))+'</td><td class="num">'+hms(monthMs(u))+'</td><td class="num">'+hms(st.activeMs)+'</td><td class="num">'+(st.logins||0)+'</td><td class="num">'+w.raised+'</td><td class="num">'+w.acted+'</td><td class="num">'+w.tasks+'</td></tr>'}).join('')+'</tbody></table></div>'+
    '<div class="row" style="margin-top:16px;gap:10px;flex-wrap:wrap"><button class="btn primary" id="ux-dl">Download usage</button><span class="hint">Time counts only while the tab is open and in front, so it reflects attention rather than a window left running. Recorded on the server, so phone and laptop add up to one figure per person.</span></div>';
}
function wireUsage(v){
  $$('.tabs button',v).forEach(b=>b.onclick=()=>{usageSort=b.dataset.s;render()});
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
function viewPeople(){
  const typed={}; DB.requests.forEach(r=>{const n=r.f.siteName; if(n&&!byName.has(String(n).toLowerCase())) typed[n]=1}); const unlisted=Object.keys(typed);
  const stuck=DB.requests.filter(r=>r.status==='In Progress'&&r.chain[r.current]);
  return '<div class="card pad" style="margin-bottom:16px"><div class="row" style="flex-wrap:wrap"><div><h3>'+DB.users.filter(u=>u.active).length+' people can be added to a chain</h3><p class="hint" style="margin-top:4px">Anyone registered shows up when a requester searches for approvers. Create accounts here, or let people register themselves from the sign-in screen and set their access afterwards.</p></div>'+
    '<div class="row hdr-actions" style="margin-left:auto;gap:8px">'+(ME.admin?'<button class="btn primary" id="p-new">Create an account</button>':'')+(ME.admin?'<button class="btn" id="p-seed">Create ALDS people</button>':'')+'<button class="btn" id="p-pw">Change password</button><button class="btn" id="p-me">My directory entry</button></div></div></div>'+
   '<div class="card"><table class="cards people"><thead><tr><th>Name</th><th>Designation</th><th>Department</th><th>Reports to</th><th>Access</th><th>PIN</th><th></th></tr></thead><tbody>'+
   DB.users.map(u=>{const mgr=u.managerId?user(u.managerId):null, badges=(u.owner?'<span class="tag" style="background:#1A1338;color:#fff;border-color:#1A1338">Super admin</span> ':'')+(u.admin&&!u.owner?'<span class="tag t-prog">Admin</span> ':'')+(u.manager?'<span class="tag t-ok">Manager</span> ':'')+(u.seeAll&&!u.admin?'<span class="tag t-wait">Sees all</span>':'');
     return '<tr'+(u.active?'':' style="opacity:.55"')+'><td><div class="row" style="gap:10px"><div class="av sm">'+inits(u.name)+'</div><div><b>'+esc(u.name)+'</b>'+(u.id===ME.id?' <span class="hint">(you)</span>':'')+(u.active?'':' <span class="tag t-bad">off</span>')+'<div class="hint">'+esc(u.email)+'</div></div></div></td><td class="meta">'+esc(u.role||'')+'</td>'+
     '<td class="hint meta">'+esc(u.dept||(u.admin?'no department':''))+'</td><td class="hint meta">'+(mgr?'reports to '+esc(mgr.name)+(u.managerConfirmed?'':' <span class="tag t-hold">unconfirmed</span>'):'')+'</td><td class="meta">'+(badges||'')+'</td><td class="meta">'+(pinOK(u)?'<span class="tag t-ok">PIN set</span>':'<span class="tag t-wait">No PIN today</span>')+'</td>'+
     '<td class="acts" style="text-align:right;white-space:nowrap">'+(ME.admin&&(!u.owner||u.id===ME.id)?'<button class="btn sm" data-ed="'+u.id+'">Edit</button>':(u.owner?'<span class="hint">only the owner</span>':''))+
     (ME.owner&&!u.owner?' <button class="btn sm" data-rmu="'+u.id+'" style="color:var(--stop)">Remove</button>':'')+'</td></tr>'}).join('')+'</tbody></table></div>'+
   (ME.admin?'<div class="card pad" style="margin-top:16px"><h3>Departments</h3><p class="hint" style="margin-top:5px">A request shows a handover whenever it crosses from one of these to another, so keep the list tight.</p><div class="row" style="flex-wrap:wrap;gap:7px;margin-top:12px">'+
     DB.departments.map(d=>'<span class="tag t-wait">'+esc(d)+' <button class="btn ghost sm" data-dd="'+esc(d)+'" style="padding:0 4px" title="Remove">×</button></span>').join('')+'</div><div class="row" style="gap:8px;margin-top:14px"><input id="dp-new" type="text" placeholder="Add a department" style="max-width:280px"><button class="btn sm" id="dp-add">Add</button></div></div>':'')+
   (ME.admin?'<div class="card pad" style="margin-top:16px"><h3>Requests stuck on an absent approver</h3><p class="hint" style="margin-top:5px">Only an admin can move a request off someone who is unavailable. The original assignment stays in the trail.</p>'+
     (stuck.length?'<div style="margin-top:12px">'+stuck.map(r=>'<div class="filerow"><div style="min-width:0;flex:1"><b>'+esc(docTitle(r))+'</b><div class="hint">'+esc(r.ref)+' · with '+esc(user(r.chain[r.current].userId).name)+' for '+daysBetween(r.chain[r.current].actedAt||r.createdAt,Date.now())+' days</div></div><button class="btn sm" data-re="'+r.id+'">Reassign</button></div>').join('')+'</div>':'<p class="hint" style="margin-top:10px">Nothing is currently in progress.</p>')+'</div>':'')+
   '<div class="grid g2" style="margin-top:16px;align-items:start"><div class="card pad"><h3>Station master</h3><p class="hint" style="margin-top:5px">'+STATIONS.length+' stations loaded.'+(ME.admin?' Upload a replacement to refresh the list — the columns must stay ERP Code, Station Name, State.':'')+'</p>'+(ME.admin?'<div id="p-mast" style="margin-top:12px"></div>':'')+'</div>'+
   '<div class="card pad"><h3>Typed, not in the master</h3>'+(unlisted.length?'<p class="hint" style="margin-top:5px">Typed by requesters and not found in the station master. Worth adding.</p><ul style="margin:10px 0 0;padding-left:18px">'+unlisted.map(n=>'<li>'+esc(n)+'</li>').join('')+'</ul>':'<p class="hint" style="margin-top:5px">Nothing so far — every site used has matched the master.</p>')+
     '<div class="sep"></div><h3>Project names</h3><p class="hint" style="margin-top:5px">'+DB.projects.map(esc).join(', ')+'</p></div></div>'+
   (ME.owner?'<div class="card pad" style="margin-top:16px;border-color:var(--stop)"><h3>Owner controls — testing and the go-live reset</h3>'+
     '<p class="hint" style="margin-top:5px">Only the system owner sees this. Deleting is the one exception to the permanent record and every use is logged where nobody, including you, can remove it. Use it to clear test data; once real requests exist, leave it alone.</p>'+
     '<div class="row" style="gap:9px;margin-top:12px;flex-wrap:wrap"><button class="btn bad sm" id="p-purge-all">Delete all data (reset to zero)</button>'+
     '<span class="hint">Single requests are deleted from the request itself. Test accounts have a Remove button in the table above.</span></div></div>':'')+
   '<div class="card pad" style="margin-top:16px"><h3>The record is permanent</h3><p class="hint" style="margin-top:5px">Requests, approvals, conditions and the audit trail cannot be deleted or edited once recorded'+(ME.owner?', except by the system owner through the controls above, and those deletions are themselves recorded permanently':' — the database has no way to do it')+'. Corrections are added as new entries so the original stays visible.</p></div>';
}
function wirePeople(v){
  $('#p-me',v).onclick=profileDialog;
  if($('#p-new',v)) $('#p-new',v).onclick=createUserDialog;
  if($('#p-seed',v)) $('#p-seed',v).onclick=seedAldsPeopleDialog;
  if($('#p-purge-all',v)) $('#p-purge-all',v).onclick=purgeAllDialog;
  $$('[data-rmu]',v).forEach(b=>b.onclick=()=>purgeUserDialog(user(b.dataset.rmu)));
  $('#p-pw',v).onclick=()=>newPasswordDialog({title:'Change your password',cancellable:true});
  $$('[data-ed]',v).forEach(b=>b.onclick=()=>{const u=user(b.dataset.ed);
    modal({title:'Edit '+u.name,body:'<div class="grid" style="gap:13px"><div class="grid g2"><div><label for="e-role">Designation</label><input id="e-role" type="text" value="'+esc(u.role||'')+'" list="dl-role"></div><div><label for="e-dept">Department</label><select id="e-dept">'+deptOptions(u.dept)+'</select></div></div>'+
        '<div><label for="e-mgr">Reports to</label><select id="e-mgr">'+mgrOptions(u.managerId,u.id)+'</select></div><div class="sep" style="margin:2px 0"></div>'+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-man" style="width:auto" '+(u.manager?'checked':'')+'> <span><b>Manager</b><div class="hint">Can assign work to their team inside a request.</div></span></label>'+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-see" style="width:auto" '+(u.seeAll?'checked':'')+'> <span><b>Can see every request</b><div class="hint">For audit or finance oversight, without full admin rights.</div></span></label>'+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-gate" style="width:auto" '+(u.gateman?'checked':'')+'> <span><b>Gateman</b><div class="hint">Clears people out at the gate: sees the approval selfies and closes each gate pass.</div></span></label>'+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-gateonly" style="width:auto" '+(u.gateOnly?'checked':'')+'> <span><b>Gate Pass only</b><div class="hint">This account signs in to the Gate Pass page and nothing else — no dashboard, requests or records.</div></span></label>'+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-hrhead" style="width:auto" '+(u.hrHead?'checked':'')+'> <span><b>HR Head (Gate Pass reports)</b><div class="hint">Sees every gate pass (view only) and the Gate Pass Reports page. Restricted to those two pages.</div></span></label>'+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-adm" style="width:auto" '+(u.admin?'checked':'')+' '+(u.id===ME.id||u.owner||!ME.owner?'disabled':'')+'> <span><b>Administrator</b><div class="hint">'+(u.owner?'The system owner is always an administrator. This cannot be changed by anyone.':(ME.owner?'A system role, separate from the flow: creates accounts, sets access, manages masters, sees every request.':'Only the system owner can grant or remove this.'))+'</div></span></label>'+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-act" style="width:auto" '+(u.active?'checked':'')+' '+(u.id===ME.id||u.owner?'disabled':'')+'> <span><b>Account active</b><div class="hint">'+(u.owner?'The system owner account cannot be switched off.':'Switched-off people cannot sign in or be added to chains.')+'</div></span></label>'+
        (u.admin||u.owner?'<div class="sep" style="margin:2px 0"></div><div class="hint">This account is an administrator, so it sees every page.</div>':'<div class="sep" style="margin:2px 0"></div>'+pagesChecklist('e-pages',allowedPages(u)))+'</div>'+lists()+'<div id="e-err" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
      footer:'<button class="btn bad" id="e-reset" style="margin-right:auto">Reset password</button><button class="btn" data-x>Cancel</button><button class="btn primary" id="eg">Save</button>',
      onOpen:(mv,cl)=>{
        $('#e-reset',mv).onclick=()=>{ cl(); resetPasswordDialog(u) };
        $('#eg',mv).onclick=async()=>{const d=$('#e-dept',mv).value; const adm=u.id===ME.id?true:$('#e-adm',mv).checked;
        if(!d&&!adm) return $('#e-err',mv).textContent='Choose a department, or make them an administrator.';
        try{ await rpc('admin_update_profile',{p_user:u.id,p_role:$('#e-role',mv).value.trim(),p_dept:d||null,p_manager:$('#e-mgr',mv).value||null,p_is_manager:$('#e-man',mv).checked,p_see_all:$('#e-see',mv).checked,p_is_admin:adm,p_active:u.id===ME.id?true:$('#e-act',mv).checked});
          if($('#e-gate',mv)&&$('#e-gate',mv).checked!==!!u.gateman) await rpc('set_gateman',{p_user:u.id,p_on:$('#e-gate',mv).checked});
          if($('#e-gateonly',mv)&&$('#e-gateonly',mv).checked!==!!u.gateOnly) await rpc('set_gate_only',{p_user:u.id,p_on:$('#e-gateonly',mv).checked});
          if($('#e-hrhead',mv)&&$('#e-hrhead',mv).checked!==!!u.hrHead) await rpc('set_hr_head',{p_user:u.id,p_on:$('#e-hrhead',mv).checked});
          if(!adm&&$('#e-pages',mv)) await rpc('set_pages',{p_user:u.id,p_pages:readChecklist('e-pages',mv)});
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
let gpDraft=null, gateTab='desk';
async function selfieUpload(blob){
  const path=ME.id+'/gate-'+uid()+'.jpg';
  const {error}=await SB.storage.from('documents').upload(path,blob,{contentType:'image/jpeg',upsert:false});
  if(error) throw error;
  return path;
}
/* opens the front camera, lets you capture and confirm one frame, uploads it,
   and resolves to the stored path (or null if the person backed out) */
function captureSelfie(title){
  return new Promise(resolve=>{
    let stream=null, path=null, done=false, previewBlob=null;
    const finish=v=>{ if(done)return; done=true; if(stream)stream.getTracks().forEach(t=>t.stop()); resolve(v); };
    modal({title:title||'Take a live selfie',cls:'selfie',
      body:'<div id="sf-stage" class="selfie-stage"><div class="selfie-hint"><span class="spin"></span> Starting the camera…</div></div>'+
           '<div id="sf-msg" class="hint" style="margin-top:8px;text-align:center">Fit your face inside the circle and look at the camera. The photo is live and time-stamped — it cannot be uploaded, and a held-up photograph will not line up in the ring.</div>',
      footer:'<button class="btn" data-x>Cancel</button><button class="btn" id="sf-retake" style="display:none">Retake</button><button class="btn primary" id="sf-shoot" disabled>Capture</button>',
      onOpen:(v,cl)=>{
        const stage=$('#sf-stage',v), msg=$('#sf-msg',v), shoot=$('#sf-shoot',v), retake=$('#sf-retake',v);
        const obs=new MutationObserver(()=>{ if(!v.isConnected){ obs.disconnect(); finish(path) } });
        obs.observe(v.parentNode||document.body,{childList:true});
        const showLive=()=>{ const video=document.createElement('video'); video.autoplay=true; video.playsInline=true; video.setAttribute('playsinline','');
          video.muted=true; video.className='selfie-video mirror'; video.srcObject=stream; stage.innerHTML=''; stage.appendChild(video); video.play().catch(()=>{});
          const ring=document.createElement('div'); ring.className='selfie-ring'; stage.appendChild(ring);   // face guide: a real face fills the oval, a held-up photo won't line up
          shoot.textContent='Capture'; shoot.dataset.mode='cap'; shoot.disabled=false; retake.style.display='none'; };
        (async()=>{
          const md=navigator.mediaDevices;
          if(!md||!md.getUserMedia){
            const secure=window.isSecureContext!==false && location.protocol==='https:';
            stage.innerHTML='<div class="selfie-err">The camera isn’t available to the app.'+
              '<div class="hint" style="margin-top:6px">'+(secure
                ? 'On the mobile app this usually means the app has not been given camera permission. Open your phone’s Settings → Apps → SETU → Permissions and allow the Camera, then reopen SETU.'
                : 'The page must be opened over a secure (https) connection for the camera to work.')+'</div></div>';
            return;
          }
          // try the front camera; fall back to any camera if the WebView rejects the constraints
          const tries=[{video:{facingMode:{ideal:'user'}},audio:false},{video:{facingMode:'user'},audio:false},{video:true,audio:false}];
          let err=null;
          for(const c of tries){ try{ stream=await md.getUserMedia(c); err=null; break; }catch(e){ err=e; } }
          if(!stream){
            const name=(err&&(err.name||err.message))||'unknown';
            const why=/NotAllowed|Security|Permission/i.test(name)
                ? 'Camera permission was blocked. On the mobile app: phone Settings → Apps → SETU → Permissions → allow Camera, then reopen. In a browser: tap the address bar’s site settings and allow the camera.'
              : /NotFound|Overconstrained/i.test(name) ? 'No usable camera was found on this device.'
              : /NotReadable|InUse|Track/i.test(name) ? 'The camera is busy in another app. Close other camera apps and try again.'
              : 'The camera could not start ('+esc(String(name))+').';
            stage.innerHTML='<div class="selfie-err">Camera didn’t open.<div class="hint" style="margin-top:6px">'+why+'</div></div>';
            return;
          }
          showLive();
        })();
        shoot.onclick=async()=>{
          if(shoot.dataset.mode==='use'){
            shoot.disabled=true; retake.style.display='none'; msg.textContent='Saving…';
            try{ path=await selfieUpload(previewBlob); cl(); }
            catch(e){ msg.textContent='Could not save the photo. Try again.'; shoot.disabled=false; retake.style.display=''; }
            return;
          }
          const video=$('.selfie-video',stage); if(!video) return;
          const w=video.videoWidth||720, h=video.videoHeight||720, edge=1000, scale=Math.min(1,edge/Math.max(w,h));
          const cv=document.createElement('canvas'); cv.width=Math.round(w*scale); cv.height=Math.round(h*scale);
          cv.getContext('2d').drawImage(video,0,0,cv.width,cv.height);
          previewBlob=await new Promise(res=>cv.toBlob(res,'image/jpeg',0.82));
          stage.innerHTML='<img class="selfie-video" src="'+cv.toDataURL('image/jpeg',0.82)+'" alt="selfie preview">';
          shoot.textContent='Use this photo'; shoot.dataset.mode='use'; retake.style.display='';
        };
        retake.onclick=showLive;
      }});
  });
}
async function showSelfie(path,label){
  if(!path){ toast('That photo was kept for 7 days and has since been wiped.','hold'); return; }
  const {el}=modal({title:label||'Selfie',cls:'selfie',body:'<div id="sv-stage" class="selfie-stage"><span class="spin"></span></div>'+
    '<div class="hint" style="margin-top:8px;text-align:center">Selfies are removed 7 days after the pass; the approval record stays.</div>'});
  try{ const blob=await fetchFile({path}); const url=URL.createObjectURL(blob);
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
  const thumb=(path,cap,sub)=>'<div class="gp-th"><div class="gp-th-img" data-selfiethumb="'+esc(path||'')+'" data-slabel="'+esc(cap)+'">'+
      (path?'<span class="spin"></span>':'<span class="gp-th-none">no photo</span>')+'</div>'+
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
async function loadSelfieThumbs(v){
  for(const el of $$('[data-selfiethumb]',v)){
    const path=el.dataset.selfiethumb; if(!path){ continue; }
    try{ const blob=await fetchFile({path}); const url=URL.createObjectURL(blob);
      el.innerHTML='<img src="'+url+'" alt="selfie">'; el.classList.add('has');
      el.onclick=()=>showSelfie(path,el.dataset.slabel||'Selfie'); }
    catch(e){ el.innerHTML='<span class="gp-th-none">expired</span>'; }
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
      busy(true); try{ await rpc('gp_sign',{p_id:g.id,p_person:picked.id,p_selfie:p}); await load(); cl(); toast(role+' signed.','ok'); render(); }
      catch(e){ $('#gs-err',b).textContent=(e.message||'').replace(/^.*?: /,''); }finally{ busy(false); } };
    $('#gs-decline',b).onclick=()=>renderDecline(mv,cl);
  }
  function renderDecline(mv,cl){
    const b=$('#gs-body',mv);
    b.innerHTML='<p style="margin-top:0"><b>'+esc(picked.name)+'</b> ('+role+') is declining this pass.</p><div><label for="gs-reason">Reason (optional)</label><textarea id="gs-reason" placeholder="e.g. Not required today."></textarea></div>'+
      '<div class="row" style="gap:9px;margin-top:12px"><button class="btn" id="gs-back">Back</button><button class="btn bad" id="gs-do">Confirm decline</button></div><div id="gs-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>';
    $('#gs-back',b).onclick=()=>renderHandoff(mv,cl);
    $('#gs-do',b).onclick=async()=>{ busy(true);
      try{ await rpc('gp_reject',{p_id:g.id,p_person:picked.id,p_reason:$('#gs-reason',b).value.trim()}); await load(); cl(); toast('Pass declined.','ok'); render(); }
      catch(e){ $('#gs-err',b).textContent=(e.message||'').replace(/^.*?: /,''); }finally{ busy(false); } };
  }
}
/* ---- compact console row (used for 100s of entries) ---- */
function gpGateBtnLabel(g){ return g.status==='out'?'Return &amp; close':(g.kind==='official'?'Sign out':'Approve &amp; close'); }
function gpRow(g,opts){
  opts=opts||{};
  const names=['Requester','HOD','HR'], sels=[g.reqSelfie,g.hodSelfie,g.hrSelfie];
  const th=sels.map((p,i)=>'<span class="gp-mini" data-selfiethumb="'+esc(p||'')+'" data-slabel="'+names[i]+' — '+esc(g.name||'')+'">'+(p?'':'<span class="gp-mini-x">·</span>')+'</span>').join('');
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
/* the gateman/HR-head console: dense rows, newest live at the top */
function gateConsole(){
  const gm=isGateman(ME);
  let h='';
  if(gm){
    const needs=gpAtGate();
    h+=gpSection('At the gate',needs.length,
      needs.length
        ? '<div style="padding:10px 16px 0" class="hint">Tap a photo to enlarge. New passes arrive here live.</div><table class="cards gp-dense"><tbody>'+needs.map(g=>gpRow(g,{action:'<button class="btn primary sm" data-gate="'+g.id+'">'+gpGateBtnLabel(g)+'</button>'})).join('')+'</tbody></table>'
        : '<div class="empty" style="padding:24px 16px"><h3>No one at the gate right now</h3><p class="hint">Cleared passes land here the moment HR signs — live.</p></div>');
    const done=gpClearedToday();
    h+=gpSection('Cleared today',done.length,
      done.length ? '<table class="cards gp-dense"><tbody>'+done.map(g=>gpRow(g,{})).join('')+'</tbody></table>'
        : '<div class="empty" style="padding:18px 16px"><p class="hint">Nothing cleared yet today.</p></div>');
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
  const d=gpDraft||(gpDraft={kind:'early',employeeId:'',name:ME.name||'',dept:ME.dept||'',purpose:'',selfie:null});
  h+='<div class="card pad"><h3>Create a pass</h3>'+
    '<div style="margin:12px 0"><label for="g-kind">Type of pass</label><select id="g-kind">'+
      GP_KINDS.map(k=>'<option value="'+k[0]+'" '+(d.kind===k[0]?'selected':'')+'>'+esc(k[1])+'</option>').join('')+'</select></div>'+
    '<div class="hint" id="g-kindnote" style="margin:-4px 0 12px">'+gpKindNote(d.kind)+'</div>'+
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
  head('Gate Pass','Take an early-going or official outpass — a live selfie is your signature');
  return gateCreateAndMine();
}
function wireGate(v){
  // console tabs (gateman / HR head)
  $$('[data-gt]',v).forEach(b=>b.onclick=()=>{ gateTab=b.dataset.gt; render(); });
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
  // kind dropdown
  const gk=$('#g-kind',v); if(gk) gk.onchange=()=>{ d.kind=gk.value; $('#g-kindnote',v).innerHTML=gpKindNote(d.kind); };
  const bind=(id,key)=>{const el=$(id,v); if(el) el.oninput=()=>d[key]=el.value; if(el&&el.tagName==='SELECT') el.onchange=()=>d[key]=el.value;};
  bind('#g-emp','employeeId'); bind('#g-name','name'); bind('#g-dept','dept'); bind('#g-purpose','purpose');
  if($('#g-dept',v)) $('#g-dept',v).value=d.dept||'';
  $('#g-clear',v).onclick=()=>{gpDraft=null;render()};
  $('#g-send',v).onclick=async()=>{
    const err=$('#g-err',v); err.textContent='';
    if(!d.name.trim()) return err.textContent='Enter your name.';
    if(!d.purpose.trim()) return err.textContent='Enter the purpose.';
    if(!d.selfie) return err.textContent='Take your live selfie — it is your signature.';
    if(d.kind==='early'&&gpEarlyUsed()>=2) return err.textContent='You have already used both early-going passes this month.';
    busy(true);
    try{ await rpc('gp_create',{p_kind:d.kind,p_employee_id:d.employeeId.trim(),p_name:d.name.trim(),p_dept:d.dept,p_purpose:d.purpose.trim(),p_selfie:d.selfie});
      gpDraft=null; await load(); toast('Pass created. Now take it to an HOD for their selfie.','ok'); render(); }
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
    busy(true); try{ const r=await rpc('gp_gate',{p_id:g.id}); await load(); toast(r==='out'?'Out-time recorded.':'Closed.','ok'); render(); }catch(e){ fail(e); }finally{ busy(false); } });
  // selfie view buttons inside timelines
  $$('[data-selfie]',v).forEach(b=>b.onclick=()=>showSelfie(b.dataset.selfie||null,b.dataset.slabel||'Selfie'));
  loadSelfieThumbs(v);   // gateman console: load the side-by-side approval selfies
}

/* ============================================================
   Gate Pass Reports — interactive graphs + downloads
   ============================================================ */
let gpRepFilter=null;
function gpRepDefaults(){ const to=DAY(); const d=new Date(); d.setDate(d.getDate()-29);
  return {from:d.toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}),to:to,type:'all',dept:'all'}; }
function gpRepData(){ const f=gpRepFilter;
  return DB.passes.filter(g=>{ const d=String(g.passDate||'').slice(0,10);
    if(f.from&&d<f.from) return false; if(f.to&&d>f.to) return false;
    if(f.type!=='all'&&g.kind!==f.type) return false;
    if(f.dept!=='all'&&(g.dept||'')!==f.dept) return false; return true; }); }
const gpAgg=(rows,keyFn)=>{ const m={}; rows.forEach(g=>{const k=keyFn(g)||'—'; m[k]=(m[k]||0)+1}); return Object.entries(m).map(([label,value])=>({label,value})); };
function gpBar(title,rows,color){
  const max=Math.max(1,...rows.map(r=>r.value));
  const body=rows.length?rows.map(r=>'<div class="gpr-bar"><div class="gpr-bar-l" title="'+esc(r.label)+'">'+esc(r.label)+'</div>'+
      '<div class="gpr-bar-t"><i style="width:'+Math.round(r.value/max*100)+'%'+(color?';background:'+color:'')+'"></i></div>'+
      '<div class="gpr-bar-v num">'+r.value+'</div></div>').join('')
    :'<div class="hint" style="padding:12px 2px">No data in this range.</div>';
  return '<div class="card pad"><h3>'+esc(title)+'</h3><div style="margin-top:12px">'+body+'</div></div>';
}
function gpRepBody(){
  const rows=gpRepData(), byType=k=>rows.filter(g=>g.kind===k).length;
  const kpis='<div class="grid g4" style="margin:14px 0">'+
    stat('Total passes',rows.length,'In the selected range','var(--indigo)')+
    stat('Early / Half / Official',byType('early')+' / '+byType('halfday')+' / '+byType('official'),'By type','var(--cyan)')+
    stat('Currently out',rows.filter(g=>g.status==='out').length,'Official, not back yet',rows.some(g=>g.status==='out')?'var(--hold)':'var(--seal)')+
    stat('Rejected',rows.filter(g=>g.status==='rejected').length,'Declined by HOD or HR','var(--stop)')+'</div>';
  const deptAgg=gpAgg(rows,g=>g.dept).sort((a,b)=>b.value-a.value);
  const typeAgg=GP_KINDS.map(k=>({label:k[1],value:byType(k[0])}));
  const statusAgg=[['With HOD','pending_hod'],['With HR','pending_hr'],['At gate','pending_gate'],['Out','out'],['Closed','closed'],['Rejected','rejected']].map(([lbl,st])=>({label:lbl,value:rows.filter(g=>g.status===st).length}));
  const m={}; rows.forEach(g=>{const k=String(g.passDate||'').slice(0,10); m[k]=(m[k]||0)+1}); const dayAgg=Object.keys(m).sort().map(k=>({label:k.slice(5),value:m[k]}));
  const personAgg=gpAgg(rows,g=>g.name||user(g.requesterId).name).sort((a,b)=>b.value-a.value).slice(0,10);
  const multi=personAgg.filter(p=>p.value>1).length;
  return kpis+
    '<div class="grid g2" style="gap:14px;align-items:start">'+
      gpBar('Passes by department',deptAgg,'var(--indigo)')+
      gpBar('Passes by type',typeAgg,'var(--cyan)')+
      gpBar('Passes by day',dayAgg,'var(--seal)')+
      gpBar('By status',statusAgg,'var(--hold)')+
    '</div>'+
    gpBar('People with the most passes'+(multi?' · '+multi+' took more than one':''),personAgg,'var(--indigo-deep)');
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
function gpRepRows(){ return gpRepData().map(g=>({
  Ref:g.ref, Type:gpKindLabel(g), Name:g.name||user(g.requesterId).name, 'Employee ID':g.employeeId||'',
  Department:g.dept||'', Purpose:g.purpose||'', Status:(GP_STATUS[g.status]||['',g.status])[1],
  HOD:g.hodId?user(g.hodId).name:'', HR:g.hrId?user(g.hrId).name:'', 'Cleared by':g.gateBy?user(g.gateBy).name:'',
  Created:fmtDT(g.createdAt),'HOD signed':fmtDT(g.hodAt),'HR signed':fmtDT(g.hrAt),'Out':fmtDT(g.outAt),'Return':fmtDT(g.returnAt),'Pass date':g.passDate })); }
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
  const f=gpRepFilter, upd=()=>{ $('#gpr-body',v).innerHTML=gpRepBody(); };
  const set=(id,key)=>{const el=$(id,v); if(el) el.onchange=()=>{ f[key]=el.value; upd(); };};
  set('#gr-from','from'); set('#gr-to','to'); set('#gr-type','type'); set('#gr-dept','dept');
  if($('#gr-reset',v)) $('#gr-reset',v).onclick=()=>{ gpRepFilter=gpRepDefaults(); render(); };
  if($('#gr-xlsx',v)) $('#gr-xlsx',v).onclick=()=>gpRepDownload('xlsx');
  if($('#gr-csv',v)) $('#gr-csv',v).onclick=()=>gpRepDownload('csv');
}

/* ============================================================
   Seed the named ALDS flow accounts (admin) — placeholder emails,
   each gets a temporary password the owner can distribute and edit later.
   ============================================================ */
const ALDS_PEOPLE=[
  ['Sanjay Palod','Approver'],['Rakesh Sharma','Approver'],['T Rao','Approver'],['Jatin Vora','Purchase Head'],
  ['Jagdish Thawre','Approver'],['Rajiv Shah','Approver'],['Hardik Khara','Approver'],['Jai Singhal','Approver'],
  ['Jinesh Khara','Approver'],['Prachi Khara','Approver'],['CMD','CMD Desk'],['Nishant Bhandari','Escalation'],
  ['Narendra Meshram','Accounts'],['Shilpa Shelare','Accounts'],['Akshay Ingole','Accounts'],
  ['Pritam Varade','Accounts (Retail)'],['Akash Meshram','Accounts (Retail)'],['Prashant Bhoyar','Accounts (Retail)']
];
const aldsEmail=n=>n.toLowerCase().replace(/[^a-z0-9]+/g,'.').replace(/^\.|\.$/g,'')+(n.toUpperCase()==='CMD'?'.desk':'')+'@confidencegroup.in';
function seedAldsPeopleDialog(){
  const existing=new Set(DB.users.map(u=>flowNorm(u.name)));
  const todo=ALDS_PEOPLE.filter(p=>!existing.has(flowNorm(p[0])));
  modal({title:'Create ALDS flow accounts',
    body:'<p style="margin-top:0">This creates the named people used by the ALDS PO/WO flows, each with a placeholder email and a temporary password you can hand out and edit later.</p>'+
      '<div class="hint">'+(todo.length?('To create ('+todo.length+'): '+todo.map(p=>esc(p[0])).join(', ')):'All of them already exist — nothing to create.')+'</div>'+
      '<div class="hint" style="margin-top:8px">Afterwards, map the <b>Purchase team</b> members under <b>Jatin Vora</b> (edit each purchase person → Reports to: Jatin Vora).</div>'+
      '<div id="seed-out" style="margin-top:10px"></div>',
    footer:'<button class="btn" data-x>Close</button>'+(todo.length?'<button class="btn primary" id="seed-go">Create '+todo.length+' accounts</button>':''),
    onOpen:(v,cl)=>{ if(!$('#seed-go',v)) return;
      $('#seed-go',v).onclick=async()=>{ $('#seed-go',v).disabled=true; const out=$('#seed-out',v); const made=[];
        for(const [name,role] of todo){ out.innerHTML='Creating <b>'+esc(name)+'</b>…';
          try{ const {data,error}=await SB.functions.invoke('admin-create-user',{body:{name,email:aldsEmail(name),role,dept:'ALDS',mode:'password',password:''}});
            if(error||!data||data.error){ made.push([name,aldsEmail(name),'(exists / error)']); }
            else made.push([name,data.email,data.tempPassword||'—']); }
          catch(e){ made.push([name,aldsEmail(name),'(error)']); }
        }
        await load();
        out.innerHTML='<div class="hint" style="margin-bottom:6px">Done. Temporary passwords (copy and keep safe):</div>'+
          '<table class="cards"><tbody>'+made.map(m=>'<tr><td><b>'+esc(m[0])+'</b><div class="hint">'+esc(m[1])+'</div></td><td class="meta num">'+esc(m[2])+'</td></tr>').join('')+'</tbody></table>';
        render();
      };
    }});
}

/* ============================================================
   ALDS PO / WO fixed flows (Stage 2 UI)
   ============================================================ */
const flowHeadLabel=h=>h==='PO'?'ALDS PO (Indent)':'ALDS WO (Work order)';
const flowNorm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const ACCT_NAMES=['narendra meshram','shilpa shelare','akshay ingole','pritam varade','akash meshram','prashant bhoyar'];
const inAccountsTeam=()=>{const n=flowNorm(ME&&ME.name); return ACCT_NAMES.some(x=>n.indexOf(x)>-1)||!!(ME&&(ME.admin||ME.owner))};
const flowLive=f=>f.steps.find(s=>s.status==='pending');
const flowIsMine=f=>{const s=flowLive(f); return !!(s&&s.actors.indexOf(ME.id)>-1)};
const flowCanEscalate=f=>{const s=flowLive(f); return !!(s&&s.escalatable&&inAccountsTeam())};
const flowMyTurn=()=>DB.flows.filter(f=>f.status==='running'&&(flowIsMine(f)||flowCanEscalate(f)));
const flowMine=()=>DB.flows.filter(f=>f.requesterId===ME.id);
const flowStageList=f=>{const order=[],seen={}; f.steps.forEach(s=>{if(!seen[s.stage]){seen[s.stage]=1;order.push(s.stage)}}); return order;};
const flowWhere=f=>{ if(f.status==='completed') return 'Completed'; const s=flowLive(f); return s?(s.stage+' · '+s.label):'—'; };
const flowStatusTag=f=>f.status==='completed'?'<span class="tag t-ok">Completed</span>':f.status==='cancelled'?'<span class="tag t-bad">Cancelled</span>':'<span class="tag t-prog">In progress</span>';

function flowRow(f){
  const s=flowLive(f), withWho=s?s.actors.map(id=>user(id).name).slice(0,3).join(', ')+(s.actors.length>3?' +'+(s.actors.length-3):''):'';
  return '<tr data-flow="'+f.id+'"><td><b>'+esc(f.ref)+'</b> <span class="hint">'+esc(flowHeadLabel(f.head))+' · '+esc(f.division)+'</span>'+
    '<div class="hint">'+esc(f.title||'(no title)')+' · by '+esc(user(f.requesterId).name)+' · '+esc(fmtD(f.createdAt))+'</div>'+
    '<div class="hint">'+esc(flowWhere(f))+(withWho?' — with '+esc(withWho):'')+'</div></td>'+
    '<td class="meta">'+flowStatusTag(f)+(flowIsMine(f)?'<div class="hint" style="color:var(--indigo)">Your turn</div>':'')+'</td></tr>';
}
/* ALDS flows surfaced inside the normal lists (Waiting on me / My requests / All).
   They are raised from the Raise-a-request page, so there is no separate raise tab. */
function flowSection(ctx){
  let list;
  if(ctx==='turn') list=flowMyTurn();
  else if(ctx==='mine') list=flowMine();
  else list=DB.flows.slice();
  if(!list.length) return '';
  list.sort((a,b)=>b.createdAt-a.createdAt);
  const label=ctx==='turn'?'ALDS flows waiting on me':ctx==='mine'?'My ALDS flows':'ALDS PO / WO flows';
  return '<div class="card" style="margin-top:16px"><div class="row" style="padding:14px 18px;border-bottom:1px solid var(--line)"><h3>'+label+'</h3><span class="tag t-prog" style="margin-left:auto">'+list.length+'</span></div>'+
    '<table class="cards"><tbody>'+list.map(flowRow).join('')+'</tbody></table></div>';
}
function wireFlowRows(v){ $$('[data-flow]',v).forEach(tr=>tr.onclick=()=>go({name:'flowdetail',id:tr.dataset.flow})); }
/* ---- detail: the stage → sub-step chain, visible to all, act only at your point ---- */
const FLOW_ST={waiting:['t-wait','Waiting'],pending:['t-prog','Now here'],done:['t-ok','Done'],skipped:['t-hold','Skipped']};
function flowStepRow(f,s){
  const st=FLOW_ST[s.status]||['t-wait',s.status];
  const actors=s.actors.map(id=>user(id).name).join(', ')||'—';
  let meta='';
  if(s.status==='done'){ meta='<div class="hint">'+(s.actedBy?esc(user(s.actedBy).name):'—')+' · '+esc(fmtDT(s.actedAt))+(s.remark?' · '+esc(s.remark):'')+'</div>'; }
  if(s.datetimeVal) meta+='<div class="hint">Confirmed: '+esc(fmtDT(s.datetimeVal))+'</div>';
  if(s.dataVal&&s.action==='data') meta+='<div class="hint">'+Object.entries(s.dataVal).map(([k,val])=>esc(k)+': '+esc(val)).join(' · ')+'</div>';
  if(s.dataVal&&s.action==='payment') meta+='<div class="hint">'+esc((s.dataVal.mode||'').toUpperCase())+(s.dataVal.advices?' · '+s.dataVal.advices.map(a=>a.pct+'%').join(', '):'')+'</div>';
  const files=s.files.length?'<div class="row" style="gap:6px;flex-wrap:wrap;margin-top:4px">'+s.files.map(fl=>'<button class="btn sm" data-ffile="'+fl.id+'">'+esc(fl.name)+'</button>').join('')+'</div>':'';
  const mine=s.status==='pending'&&s.actors.indexOf(ME.id)>-1;
  const canEsc=s.status==='pending'&&s.escalatable&&inAccountsTeam();
  let act='';
  if(mine){ act='<div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn primary sm" data-fact="'+s.id+'">'+flowActLabel(s)+'</button>'+
    (s.canReject?'<button class="btn bad sm" data-freject="'+s.id+'">Reject</button>':'')+'</div>'; }
  else if(canEsc){ act='<div class="row" style="gap:8px;margin-top:8px"><button class="btn hold sm" data-fesc="'+s.id+'">Escalate past CMD</button></div>'; }
  return '<div class="flow-step '+(s.status==='pending'?'live':'')+' '+(s.status==='done'?'done':'')+'">'+
    '<span class="flow-dot"></span><div style="flex:1;min-width:0"><div class="row" style="gap:8px;flex-wrap:wrap"><b>'+esc(s.label)+'</b><span class="tag '+st[0]+'" style="font-size:11px">'+st[1]+'</span></div>'+
    '<div class="hint">'+esc(actors)+'</div>'+meta+files+act+'</div></div>';
}
const flowActLabel=s=>({initiate:'Submit & sign',upload:'Upload & sign',approve:'Approve',confirm:'Confirm',data:'Enter details & sign',payment:'Initiate advice'})[s.action]||'Submit';
function viewFlowDetail(id){
  const f=DB.flows.find(x=>x.id===id);
  if(!f){ head('Flow','Not found'); return '<div class="card pad">This flow could not be found.</div>'; }
  head(f.ref,flowHeadLabel(f.head)+' · '+f.division+(f.title?' · '+f.title:''));
  let h='<div class="row" style="margin-bottom:12px"><button class="btn sm" id="fl-back">← Back</button><span style="margin-left:auto">'+flowStatusTag(f)+'</span></div>';
  flowStageList(f).forEach(stage=>{
    const steps=f.steps.filter(s=>s.stage===stage);
    const anyLive=steps.some(s=>s.status==='pending');
    h+='<div class="card" style="margin-bottom:12px'+(anyLive?';border-color:var(--indigo)':'')+'"><div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line)"><h3>'+esc(stage)+'</h3></div>'+
      '<div style="padding:10px 16px">'+steps.map(s=>flowStepRow(f,s)).join('')+'</div></div>';
  });
  if(f.audit.length) h+='<div class="card" style="margin-bottom:12px"><div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line)"><h3>History</h3></div><div style="padding:10px 16px">'+
    f.audit.slice().reverse().map(a=>'<div class="hint" style="padding:3px 0"><b>'+esc(a.actorName||'')+'</b> — '+esc(a.action)+(a.detail?' · '+esc(a.detail):'')+' · '+esc(fmtDT(a.ts))+'</div>').join('')+'</div></div>';
  return h;
}
function wireFlowDetail(v){
  if($('#fl-back',v)) $('#fl-back',v).onclick=()=>history.back();
  $$('[data-ffile]',v).forEach(b=>b.onclick=()=>{ const id=b.dataset.ffile;
    let rec=null; DB.flows.forEach(f=>f.steps.forEach(s=>s.files.forEach(fl=>{if(fl.id===id)rec=fl}))); if(rec) openViewer(rec); });
  $$('[data-freject]',v).forEach(b=>b.onclick=()=>flowReject(b.dataset.freject));
  $$('[data-fesc]',v).forEach(b=>b.onclick=()=>flowEscalate(b.dataset.fesc));
  $$('[data-fact]',v).forEach(b=>b.onclick=()=>flowAct(b.dataset.fact));
}
function flowFindStep(id){ for(const f of DB.flows) for(const s of f.steps) if(s.id===id) return {f,s}; return null; }
async function flowCall(stepId,kind,remark,files,datetime,data,okMsg){
  busy(true);
  try{ await rpc('flow_act',{p_step:stepId,p_kind:kind,p_remark:remark||'',p_pin:flowCall._pin,p_files:files||null,p_datetime:datetime||null,p_data:data||null});
    await load(); toast(okMsg||'Done.','ok'); render(); }
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
function flowEscalate(stepId){
  const x=flowFindStep(stepId); if(!x) return;
  modal({title:'Escalate past CMD',body:'<p style="margin-top:0">This skips the CMD desk and sends it straight to <b>Nishant Bhandari</b> for approval, to speed up payment.</p>',
    footer:'<button class="btn" data-x>Cancel</button><button class="btn hold" id="feg">Escalate</button>',
    onOpen:(mv,cl)=>{$('#feg',mv).onclick=()=>{cl(); flowPinThen(()=>flowCall(stepId,'escalate','',null,null,null,'Escalated to Nishant.')); }}});
}
function flowAct(stepId){
  const x=flowFindStep(stepId); if(!x) return; const s=x.s;
  const local={files:[],support:[]};   // uploaded file records
  let dt=''; const dataFields={}; let payMode='full'; const advices=[{pct:'',rec:null},{pct:'',rec:null},{pct:'',rec:null},{pct:'',rec:null}];
  let body='<p style="margin-top:0">'+esc(s.label)+'</p>';
  if(s.action==='payment'){
    body+='<div class="seg" id="fp-mode" style="margin:8px 0"><button data-m="full" class="on">Full advice</button><button data-m="partial">Partial advice</button></div>'+
      '<div id="fp-partial" class="hide"><div class="hint">Add up to 4 advices, each with its percentage and PDF.</div><div id="fp-adv"></div></div>'+
      '<div style="margin-top:10px"><label>Advice document</label><div id="fa-files"></div></div>';
  } else if(s.action==='data'){
    body+=s.fieldsSpec.map((lbl,i)=>'<div style="margin-top:8px"><label>'+esc(lbl)+'</label><input type="text" data-df="'+i+'"></div>').join('')+
      (s.needsFile?'<div style="margin-top:10px"><label>Attach copy</label><div id="fa-files"></div></div>':'');
  } else {
    if(s.needsFile) body+='<div style="margin-top:10px"><label>Upload document</label><div id="fa-files"></div></div>';
  }
  if(s.needsDatetime) body+='<div style="margin-top:10px"><label for="fa-dt">Confirmation date & time</label><input type="datetime-local" id="fa-dt"></div>';
  body+='<div style="margin-top:10px"><label for="fa-rem">Remark <span class="hint">optional</span></label><input type="text" id="fa-rem"></div><div id="fa-err" style="color:var(--stop);font-size:13px;margin-top:8px"></div>';
  modal({title:flowActLabel(s),body:body,footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="fa-go">Continue</button>',
    onOpen:(mv,cl)=>{
      if($('#fa-files',mv)) uploader($('#fa-files',mv),local.files,{mode:'support',single:(s.action!=='payment'),label:'Tap to upload (PDF, image, Excel, Word)'});
      if($('#fp-adv',mv)){ const paint=()=>{ $('#fp-adv',mv).innerHTML=advices.map((a,i)=>'<div class="row" style="gap:8px;margin-top:6px;align-items:center"><input type="number" min="0" max="100" placeholder="%" data-pct="'+i+'" value="'+esc(a.pct)+'" style="width:80px"><div style="flex:1" id="adv-f-'+i+'"></div></div>').join('');
        advices.forEach((a,i)=>{ $('[data-pct="'+i+'"]',mv).oninput=e=>a.pct=e.target.value; a._list=a._list||[]; uploader($('#adv-f-'+i,mv),a._list,{mode:'support',single:true,label:'Advice '+(i+1)+' PDF'}); }); };
        paint(); }
      $$('#fp-mode button',mv).forEach(b=>b.onclick=()=>{payMode=b.dataset.m; $$('#fp-mode button',mv).forEach(x=>x.classList.toggle('on',x.dataset.m===payMode)); $('#fp-partial',mv).classList.toggle('hide',payMode!=='partial'); });
      $('#fa-go',mv).onclick=()=>{
        const err=$('#fa-err',mv); err.textContent='';
        let files=filesPayload(local.files), data=null;
        if(s.needsFile && !files.length && s.action!=='payment') return err.textContent='Upload the document first.';
        if(s.needsDatetime){ dt=$('#fa-dt',mv).value; if(!dt) return err.textContent='Select the date & time.'; }
        if(s.action==='data'){ let miss=false; s.fieldsSpec.forEach((lbl,i)=>{const val=$('[data-df="'+i+'"]',mv).value.trim(); if(!val)miss=true; dataFields[lbl]=val;}); if(miss) return err.textContent='Fill all the fields.'; data=dataFields; }
        if(s.action==='payment'){ data={mode:payMode};
          if(payMode==='partial'){ const adv=[]; advices.forEach((a,i)=>{ if(a.pct&&a._list&&a._list.length){ adv.push({pct:Number(a.pct),name:a._list[0].name,path:a._list[0].path}); files=files.concat(filesPayload(a._list)); } });
            if(!adv.length) return err.textContent='Add at least one advice with a % and PDF.'; data.advices=adv; }
          else if(!files.length) return err.textContent='Upload the advice document.';
        }
        const remark=$('#fa-rem',mv).value.trim();
        cl(); flowPinThen(()=>flowCall(stepId,'act',remark,files.length?files:null,dt?new Date(dt).toISOString():null,data,'Signed.'));
      };
    }});
}

/* ============================================================
   Boot
   ============================================================ */
window.addEventListener('offline',()=>{if(!$('#off')){const d=document.createElement('div');d.id='off';d.className='offline';d.textContent='You are offline — changes cannot be saved until the connection is back.';document.body.appendChild(d)}});
window.addEventListener('online',()=>{const d=$('#off');if(d)d.remove();if(ME)reload()});
if('serviceWorker' in navigator&&location.protocol==='https:') navigator.serviceWorker.register('sw.js').catch(()=>{});
document.title=CONFIG.APP_NAME||'SETU';

(async function boot(){
  try{ const {data}=await SB.from('departments').select('name').order('name'); if(data) DB.departments=data.map(d=>d.name) }catch(e){}
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
  const {data:{session}}=await SB.auth.getSession();
  if(session) enter(session); else paintSignIn();
})();
