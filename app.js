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
let DB={users:[],requests:[],audit:[],templates:[],departments:[],projects:[]};
let STATIONS=[], ME=null, ROUTE={name:'dash'};
const byCode=new Map(), byName=new Map();
function indexStations(){ byCode.clear(); byName.clear();
  STATIONS.forEach(s=>{byCode.set(s.code.toUpperCase(),s);byName.set(s.name.toLowerCase(),s)}) }

/* ---------- toast / modal ---------- */
function toast(m,k){const t=document.createElement('div');t.className='toast '+(k||'');t.textContent=m;$('#toasts').appendChild(t);
  setTimeout(()=>{t.style.transition='opacity .3s';t.style.opacity='0';setTimeout(()=>t.remove(),320)},3600)}
function modal({title,body,footer,cls,onOpen}){
  const v=document.createElement('div');v.className='veil';
  v.innerHTML='<div class="modal '+(cls||'')+'"><div class="h"><h3>'+esc(title)+'</h3><button class="btn ghost sm" data-x>Close</button></div>'+
    '<div class="c">'+body+'</div>'+(footer?'<div class="f">'+footer+'</div>':'')+'</div>';
  $('#modal-root').appendChild(v);
  const close=()=>{ v.remove(); window.removeEventListener('popstate',onPop); if(history.state&&history.state.modal){ skipPop=true; history.back() } };
  v.addEventListener('click',e=>{if(e.target===v||e.target.hasAttribute('data-x'))close()});
  try{ history.pushState(Object.assign({},history.state||ROUTE,{modal:true}),''); }catch(e){}
  const onPop=()=>{ v.remove(); window.removeEventListener('popstate',onPop) };
  window.addEventListener('popstate',onPop);
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
    SB.from('usage_daily').select('*')
  ];
  const r=await Promise.all(q);
  const bad=r.find(x=>x.error); if(bad) throw bad.error;
  const [prof,req,steps,tasks,files,notes,audit,tpl,dept,proj,st,usage]=r.map(x=>x.data||[]);

  DB.users=prof.map(p=>({id:p.id,name:p.name,email:p.email,role:p.role||'',dept:p.dept||'',
    admin:p.is_admin,owner:!!p.is_owner,manager:p.is_manager,seeAll:p.see_all,active:p.active,
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

  const me=DB.users.find(u=>u.id===(ME&&ME.id));
  if(me) ME=me;
}
let reloadT=null;
async function reload(){ try{ await load(); render(); paintNav(); paintPin() }catch(e){ fail(e) } }
function reloadSoon(){ clearTimeout(reloadT); reloadT=setTimeout(reload,600) }

/* ---------- model helpers (read-only views over what was loaded) ---------- */
const user=id=>DB.users.find(u=>u.id===id)||{name:'Unknown',role:'',email:'',id:'',dept:''};
function holder(r){ if(r.status==='Approved'||r.status==='Rejected')return null;
  if(r.status==='Info Requested')return user(r.requesterId);
  const s=r.chain[r.current]; return s?user(s.userId):null }
const isMyTurn=r=>r.status==='In Progress'&&r.chain[r.current]&&r.chain[r.current].userId===ME.id;
const needsMyInfo=r=>r.status==='Info Requested'&&r.requesterId===ME.id;
const isManager=u=>!!(u&&u.manager);
const teamOf=id=>DB.users.filter(u=>u.active&&u.managerId===id&&u.managerConfirmed);
const pendingTeam=id=>DB.users.filter(u=>u.active&&u.managerId===id&&!u.managerConfirmed);
const managers=()=>DB.users.filter(u=>u.active&&u.manager);
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
function parseIndent(doc){
  const L=doc.all, out={}, conf={};
  const no=grab(L,/Indent\s*No\.?\s*:?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/i); if(no){out.indentNo=no;conf.indentNo='hi'}
  const dt=grab(L,/Indent\s*Date\s*:?\s*(\d{2}-\d{2}-\d{4})/i); if(dt){out.indentDate=toISO(dt);conf.indentDate='hi'}
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
    mount.innerHTML='<div class="drop" tabindex="0" role="button">'+(opts.label||(support?'Add photos, Excel, Word or PDF in support of the document':'Attach the ERP document — PDF, Excel or Word'))+'</div>'+
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
const mgrOptions=sel=>'<option value="">Nobody — I am not under a manager here</option>'+
  managers().filter(m=>!ME||m.id!==ME.id).map(m=>'<option value="'+m.id+'" '+(sel===m.id?'selected':'')+'>'+esc(m.name)+' — '+esc(m.dept||'')+'</option>').join('');
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
    paintPin(); const h=routeFromHash(); go((h&&h.name!=='detail')||(h&&DB.requests.some(r=>r.id===h.id))?h:{name:'dash'},true); subscribe();
    if(!ME.role||!ME.dept) setTimeout(profileDialog,400);
    else if(!pinOK(ME)) setTimeout(pinDialog,450);
  }catch(e){ fail(e) } finally { busy(false) }
}
function leave(){ ME=null; unsubscribe(); $('#app').classList.add('hide'); $('#signin').classList.remove('hide'); signMode='login'; paintSignIn() }

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
    .subscribe();
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
  ins.forEach((el,i)=>{el.addEventListener('input',()=>{el.value=el.value.replace(/\D/g,'');if(el.value&&ins[i+1])ins[i+1].focus()});
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
  if(pinOK(ME)){c.classList.add('ok');$('#pinchip-txt').textContent='PIN active · '+tillMidnight()+' left'}
  else{c.classList.remove('ok');$('#pinchip-txt').textContent="Set today's PIN"} }
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
const PAGES=[
  {k:'dash',label:'Dashboard',grp:'Overview'},
  {k:'new',label:'Raise a request',grp:'Overview'},
  {k:'queue',label:'Waiting on me',grp:'My work',badge:()=>myQueue().length},
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
  PAGES.filter(p=>!p.when||p.when()).forEach(p=>{ if(p.grp!==g){g=p.grp;h+='<div class="grp">'+esc(g)+'</div>'}
    const n=p.badge?p.badge():0;
    h+='<button data-k="'+p.k+'" class="'+(ROUTE.name===p.k?'on':'')+'">'+esc(p.label)+(n?'<span class="pill">'+n+'</span>':'')+'</button>'});
  $('#nav').innerHTML=h;
  $$('#nav button').forEach(b=>b.onclick=()=>go({name:b.dataset.k}));
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
let skipPop=false;
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
  const v=$('#view');
  switch(ROUTE.name){
    case 'dash': v.innerHTML=viewDash(); wireDash(v); break;
    case 'new': v.innerHTML=viewNew(); wireNew(v); break;
    case 'queue': v.innerHTML=viewList(myQueue(),'Waiting on me','Requests that cannot move until you act.','Nothing is waiting on you','Requests land here the moment the person before you signs off.'); wireList(v); break;
    case 'tasks': v.innerHTML=viewTasks(); wireList(v); break;
    case 'stuck': v.innerHTML=viewList(myStuck(),'Needs my input','An approver has asked you for more before they will sign.','No one has asked you for anything','If an approver needs a clarification, it comes back here.'); wireList(v); break;
    case 'mine': v.innerHTML=viewList(DB.requests.filter(r=>r.requesterId===ME.id),'My requests','Everything you have raised.','You have not raised anything yet','Start with Raise a request.'); wireList(v); break;
    case 'tpl': v.innerHTML=viewTpl(); wireTpl(v); break;
    case 'team': v.innerHTML=viewTeam(); wireTeam(v); break;
    case 'all': v.innerHTML=viewAll(); wireList(v);
      head(ME.admin||ME.seeAll?'All requests':'Requests I can see',ME.admin||ME.seeAll?'You can see every chain in the system':'Only chains you raised, approve, or were given a task in'); break;
    case 'report': v.innerHTML=viewReport(); wireReport(v); head('Reports','Filter the record and download it'); break;
    case 'usage': v.innerHTML=viewUsage(); wireUsage(v); break;
    case 'people': v.innerHTML=viewPeople(); wirePeople(v); head('People & masters','Directory, station master and the permanence rule'); break;
    case 'detail': v.innerHTML=viewDetail(ROUTE.id); wireDetail(v); break;
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
    '<td class="hint num">'+daysBetween(r.createdAt,Date.now())+'d</td><td>'+tagFor(r)+'</td></tr>';
  const warn=!pinOK(ME)?'<div class="banner hold"><div><b>Your PIN is not set for today.</b><div class="hint" style="color:var(--hold)">You cannot approve, reject or send anything back until you set it.</div></div><button class="btn hold sm" style="margin-left:auto" id="d-pin">Set PIN</button></div>':'';
  const feed=DB.audit.slice(0,14);
  return warn+'<div class="grid g4">'+
    stat('Waiting on me',q.length,q.length?'Act to unblock the chain':'You are all clear','var(--indigo)')+
    stat('Tasks given to me',tk.length,tk.length?'Close these to unblock a manager':'No task assigned to you','var(--cyan)')+
    stat('Needs my input',st.length,st.length?'Someone asked you for more':'Nothing sent back to you','var(--hold)')+
    stat('Open beyond 7 days',aged,'Out of '+open.length+' open requests',aged?'var(--stop)':'var(--seal)')+'</div>'+
  '<div class="grid g2" style="margin-top:18px;align-items:start">'+
   '<div class="card"><div class="row" style="padding:16px 18px;border-bottom:1px solid var(--line)"><h3>Waiting on me</h3>'+(q.length?'<span class="tag t-prog" style="margin-left:auto">'+q.length+'</span>':'')+'</div>'+
     (q.length?'<table><tbody>'+q.map(line).join('')+'</tbody></table>':'<div class="empty"><h3>Nothing on your desk</h3><p class="hint">Requests appear the moment the person before you signs off.</p></div>')+'</div>'+
   '<div class="card"><div class="row" style="padding:16px 18px;border-bottom:1px solid var(--line)"><h3>Sent back to me</h3>'+(st.length?'<span class="tag t-hold" style="margin-left:auto">'+st.length+'</span>':'')+'</div>'+
     (st.length?'<table><tbody>'+st.map(r=>'<tr data-r="'+r.id+'"><td><b>'+esc(docTitle(r))+'</b><div class="hint">Stuck at step '+(r.infoStep+2)+' with '+esc(user(r.chain[r.infoStep].userId).name)+'</div></td></tr>').join('')+'</tbody></table>'
       :'<div class="empty"><h3>Nothing held up</h3><p class="hint">If an approver wants more, it comes back here and opens at that step.</p></div>')+'</div></div>'+
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
function viewNew(){
  head('Raise a request','Attach the ERP document, check what was read from it, then set the chain');
  if(!draft||draft.type!==formTab) draft={type:formTab,files:[],support:[],chain:[],f:{category:'O&M'},conf:{},meta:{}};
  return '<div class="tabs"><button data-t="indent" class="'+(formTab==='indent'?'on':'')+'">Indent</button>'+
    '<button data-t="workorder" class="'+(formTab==='workorder'?'on':'')+'">Work order</button></div>'+
    '<div id="form-body">'+(formTab==='indent'?indentForm():woForm())+'</div>'+
    '<div class="row" style="margin-top:18px;gap:10px;flex-wrap:wrap"><button class="btn primary" id="n-send">Send for approval</button>'+
    '<button class="btn" id="n-clear">Clear form</button><span class="hint" id="n-note"></span></div>';
}
const txt=(id,label,val,conf,ph)=>'<div class="auto '+(conf||'')+'"><label for="'+id+'">'+esc(label)+(conf?'<span class="flag '+conf+'">'+(conf==='hi'?'from PDF':'check this')+'</span>':'')+'</label>'+
  '<input id="'+id+'" type="text" value="'+esc(val||'')+'"'+(ph?' placeholder="'+esc(ph)+'"':'')+'></div>';
const area=(id,label,val,conf,ph)=>'<div class="auto '+(conf||'')+'"><label for="'+id+'">'+esc(label)+(conf?'<span class="flag '+conf+'">from PDF</span>':'')+'</label>'+
  '<textarea id="'+id+'"'+(ph?' placeholder="'+esc(ph)+'"':'')+'>'+esc(val||'')+'</textarea></div>';
const uploadCard=()=>'<div class="card pad"><h3>The ERP document</h3><p class="hint" style="margin-top:5px">The indent or work order PDF the ERP generated. The fields below fill in from it — every one of them stays editable.</p><div id="n-files" style="margin-top:14px"></div></div>'+
  '<div class="card pad'+(draft.files.length?'':' hide')+'" id="n-supp-card"><h3>Supporting documents <span class="hint" style="font-weight:400">optional</span></h3>'+
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
function indentForm(){
  const f=draft.f,c=draft.conf;
  return '<div class="detail-grid"><div class="grid" style="gap:16px">'+uploadCard()+
   '<div class="card pad"><h3>Indent details</h3><div class="grid" style="gap:14px;margin-top:14px">'+
     '<div class="grid g2">'+txt('i-no','Indent number',f.indentNo,c.indentNo,'IH26605-007')+
       '<div><label for="i-cat">Category</label><select id="i-cat">'+['O&M','Project'].map(x=>'<option '+(f.category===x?'selected':'')+'>'+x+'</option>').join('')+'</select></div></div>'+
     '<div id="i-sitewrap"></div>'+
     '<div class="grid g2"><div class="auto '+(c.indentDate||'')+'"><label for="i-date">Date of indent'+(c.indentDate?'<span class="flag hi">from PDF</span>':'')+'</label><input id="i-date" type="date" value="'+esc(f.indentDate||'')+'"></div><div></div></div>'+
     area('i-rem','Remarks',f.remarks,c.remarks,'What this indent is for.')+'</div></div></div><div>'+chainCard()+'</div></div>';
}
function woForm(){
  const f=draft.f,c=draft.conf;
  return '<div class="detail-grid"><div class="grid" style="gap:16px">'+uploadCard()+
   '<div class="card pad"><h3>Work order details</h3><div class="grid" style="gap:14px;margin-top:14px">'+
     '<div class="grid g2">'+txt('w-no','Work order number',f.orderNo,c.orderNo,'WW25121-001')+
       '<div class="auto '+(c.woDate||'')+'"><label for="w-date">Work order date'+(c.woDate?'<span class="flag hi">from PDF</span>':'')+'</label><input id="w-date" type="date" value="'+esc(f.woDate||'')+'"></div></div>'+
     '<div id="w-sitewrap"></div><div class="sep"></div><h4 style="font-size:12.5px;color:var(--steel);font-weight:600">VENDOR</h4>'+
     txt('w-vn','Vendor name',f.vendorName,c.vendorName)+area('w-va','Vendor address',f.vendorAddress,c.vendorAddress)+
     '<div class="grid g3">'+txt('w-vs','State',f.vendorState,c.vendorState)+txt('w-vsc','State code',f.vendorStateCode,c.vendorStateCode)+txt('w-vp','PAN',f.vendorPan,c.vendorPan)+'</div>'+
     '<div class="grid g2">'+txt('w-vg','GSTIN',f.vendorGstin,c.vendorGstin)+txt('w-vc','Contact',f.vendorContact,c.vendorContact)+'</div>'+
     '<div class="sep"></div>'+area('w-ba','Billing address',f.billingAddress,c.billingAddress)+
     '<div class="grid g3"><div class="auto '+(c.amountPre||'')+'"><label for="w-ap">Amount before GST'+(c.amountPre?'<span class="flag hi">from PDF</span>':'')+'</label><input id="w-ap" type="number" step="0.01" value="'+esc(f.amountPre)+'"></div>'+
       '<div class="auto '+(c.amountPost||'')+'"><label for="w-aq">Amount after GST'+(c.amountPost?'<span class="flag hi">from PDF</span>':'')+'</label><input id="w-aq" type="number" step="0.01" value="'+esc(f.amountPost)+'"></div>'+
       '<div><label>GST (derived)</label><input type="text" id="w-gst" readonly style="background:var(--surface-2)"></div></div><div id="w-gstwarn" class="hint"></div>'+
     '<div><label for="w-rem">Remarks</label><textarea id="w-rem" placeholder="Why this work order needs approval.">'+esc(f.remarks||'')+'</textarea><div class="hint">Work orders carry no remark field, so this one is yours to write.</div></div>'+
   '</div></div></div><div>'+chainCard()+'</div></div>';
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
    onChange:list=>{const c=$('#n-supp-card',body); if(c) c.classList.toggle('hide',list.length===0)},
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
  paintSite($('#i-sitewrap',body)||$('#w-sitewrap',body));
  const bind=(id,key,num)=>{const el=$(id,body);if(el)el.oninput=()=>{f[key]=num?(el.value===''?'':Number(el.value)):el.value}};
  bind('#i-no','indentNo');bind('#i-date','indentDate');bind('#i-rem','remarks');bind('#w-no','orderNo');bind('#w-date','woDate');bind('#w-vn','vendorName');bind('#w-va','vendorAddress');
  bind('#w-vs','vendorState');bind('#w-vsc','vendorStateCode');bind('#w-vp','vendorPan');bind('#w-vg','vendorGstin');bind('#w-vc','vendorContact');bind('#w-ba','billingAddress');bind('#w-rem','remarks');
  bind('#w-ap','amountPre',1);bind('#w-aq','amountPost',1);
  const cat=$('#i-cat',body); if(cat) cat.onchange=()=>{f.category=cat.value;paintSite($('#i-sitewrap',body))};
  const gst=()=>{const g=$('#w-gst',body); if(!g) return; const a=Number(f.amountPre)||0,b=Number(f.amountPost)||0; g.value=(a&&b)?money(b-a):'—';
    const w=$('#w-gstwarn',body); w.textContent=(a&&b&&b<a)?'The after-GST amount is lower than the before-GST amount. Check both figures.':''; w.style.color=(a&&b&&b<a)?'var(--stop)':''};
  ['#w-ap','#w-aq'].forEach(s=>{const e=$(s,body);if(e)e.addEventListener('input',gst)}); gst();

  const find=$('#n-find',body), res=$('#n-res',body), tplSave=$('#n-tplsave',body);
  const showSave=()=>{if(tplSave)tplSave.classList.toggle('hide',draft.chain.length===0)};
  const paintChain=()=>{
    const c=$('#n-chain',body); if(!c) return; showSave();
    if(!draft.chain.length){c.innerHTML='<div class="empty" style="padding:26px 12px"><h3>No approvers yet</h3><p class="hint">A request needs at least one.</p></div>';return}
    c.innerHTML='<div class="picked"><div class="r" style="background:var(--surface-2)"><span class="seq">1</span><div class="av sm">'+inits(ME.name)+'</div><div><b>'+esc(ME.name)+'</b><div class="hint">You — raising this request</div></div></div>'+
      draft.chain.map((id,i)=>{const u=user(id);return '<div class="r"><span class="seq">'+(i+2)+'</span><div class="av sm">'+inits(u.name)+'</div><div style="min-width:0;flex:1"><b>'+esc(u.name)+'</b><div class="hint">'+esc(u.role)+(u.dept?' · '+esc(u.dept):'')+'</div></div>'+
        '<button class="btn sm" data-up="'+i+'" '+(i===0?'disabled':'')+'>↑</button><button class="btn sm" data-dn="'+i+'" '+(i===draft.chain.length-1?'disabled':'')+'>↓</button><button class="btn sm" data-rm="'+i+'">Remove</button></div>'}).join('')+'</div>';
    $$('[data-up]',c).forEach(b=>b.onclick=()=>{const i=+b.dataset.up;[draft.chain[i-1],draft.chain[i]]=[draft.chain[i],draft.chain[i-1]];paintChain()});
    $$('[data-dn]',c).forEach(b=>b.onclick=()=>{const i=+b.dataset.dn;[draft.chain[i+1],draft.chain[i]]=[draft.chain[i],draft.chain[i+1]];paintChain()});
    $$('[data-rm]',c).forEach(b=>b.onclick=()=>{draft.chain.splice(+b.dataset.rm,1);paintChain()});
  };
  paintChain();
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
  return '<table><thead><tr><th>Request</th><th>Type</th><th>Amount</th><th>Raised</th><th>Status</th><th>Position</th></tr></thead><tbody>'+
   list.map(r=>'<tr data-r="'+r.id+'"><td><b>'+esc(docTitle(r))+'</b><div class="hint">'+esc(r.ref)+' · '+esc(user(r.requesterId).name)+'</div></td><td class="hint">'+esc(typeLabel(r))+'</td>'+
   '<td class="num">'+(r.type==='workorder'?money(r.f.amountPost):'—')+'</td><td class="hint num">'+esc(fmtD(r.createdAt))+'</td><td>'+tagFor(r)+'</td><td class="hint">'+esc(stepLabel(r))+'</td></tr>').join('')+'</tbody></table>';
}
function viewList(list,t,s,et,es){ head(t,s);
  if(!list.length) return '<div class="card"><div class="empty"><h3>'+esc(et)+'</h3><p class="hint">'+esc(es)+'</p></div></div>';
  return '<div class="card">'+rowsHTML(list.slice().sort((a,b)=>b.createdAt-a.createdAt))+'</div>'; }
const wireList=v=>$$('tr[data-r]',v).forEach(t=>t.onclick=()=>go({name:'detail',id:t.dataset.r}));
function viewTasks(){
  head('Tasks given to me','Work a manager has assigned you inside a request');
  const l=myTasks();
  if(!l.length) return '<div class="card"><div class="empty"><h3>No tasks assigned to you</h3><p class="hint">When a manager breaks their step into pieces, your piece lands here.</p></div></div>';
  return '<div class="card"><table><thead><tr><th>Request</th><th>Given by</th><th>The task</th><th>Given</th></tr></thead><tbody>'+
    l.map(r=>{const m=myOpenTask(r);return '<tr data-r="'+r.id+'"><td><b>'+esc(docTitle(r))+'</b><div class="hint">'+esc(typeLabel(r))+' · '+esc(r.ref)+'</div></td><td class="hint">'+esc(user(m.step.userId).name)+'</td><td>'+esc(m.task.task)+'</td><td class="hint num">'+esc(fmtD(m.task.assignedAt))+'</td></tr>'}).join('')+'</tbody></table></div>';
}
let allF={q:'',status:'',type:''};
function viewAll(){
  let l=visible().sort((a,b)=>b.createdAt-a.createdAt);
  if(allF.status) l=l.filter(r=>r.status===allF.status); if(allF.type) l=l.filter(r=>r.type===allF.type);
  if(allF.q){const q=allF.q.toLowerCase();l=l.filter(r=>(docTitle(r)+' '+r.ref+' '+user(r.requesterId).name+' '+(r.f.remarks||'')).toLowerCase().includes(q))}
  return '<div class="card pad" style="margin-bottom:16px"><div class="row" style="flex-wrap:wrap;gap:12px"><div style="flex:1;min-width:220px"><input id="a-q" type="text" placeholder="Search number, site, vendor, requester or remark" value="'+esc(allF.q)+'"></div>'+
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
  let banner='';
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
      (inChain(r)||ME.admin?'<div class="sep"></div><label for="nt">Leave a note</label><textarea id="nt" placeholder="A comment for the chain. It does not move the request."></textarea><button class="btn sm" id="ntb" style="margin-top:9px">Post note</button>':'')+'</div>';
  }
  const facts='<div class="card pad" style="margin-bottom:16px">'+(r.type==='workorder'?'<div class="amount num">'+money(f.amountPost)+'</div><div class="hint">'+money(f.amountPre)+' before GST'+(f.amountPre&&f.amountPost?' · GST '+money(f.amountPost-f.amountPre):'')+'</div>':'<div class="amount num">'+esc(docNo(r))+'</div>')+
    '<div style="margin:8px 0 14px">'+tagFor(r)+'</div><dl class="kv"><dt>Reference</dt><dd class="num">'+esc(r.ref)+'</dd><dt>Type</dt><dd>'+esc(typeLabel(r))+'</dd>'+
    (r.type==='indent'?'<dt>Category</dt><dd>'+esc(f.category||'—')+'</dd><dt>'+(f.category==='Project'?'Project':'Site')+'</dt><dd>'+esc(f.category==='Project'?(f.projectName||'—'):(f.siteName||'—'))+(f.siteCode?' ('+esc(f.siteCode)+')':'')+'</dd><dt>Indent date</dt><dd>'+esc(fmtD(f.indentDate))+'</dd>'
      :'<dt>Order date</dt><dd>'+esc(fmtD(f.woDate))+'</dd><dt>Site</dt><dd>'+esc(f.siteName||'—')+(f.siteCode?' ('+esc(f.siteCode)+')':'')+'</dd><dt>Vendor</dt><dd>'+esc(f.vendorName||'—')+'</dd>'+
       (f.vendorAddress?'<dt>Address</dt><dd>'+esc(f.vendorAddress)+'</dd>':'')+(f.vendorState?'<dt>State</dt><dd>'+esc(f.vendorState)+(f.vendorStateCode?' ('+esc(f.vendorStateCode)+')':'')+'</dd>':'')+
       (f.vendorGstin?'<dt>GSTIN</dt><dd class="num">'+esc(f.vendorGstin)+'</dd>':'')+(f.vendorPan?'<dt>PAN</dt><dd class="num">'+esc(f.vendorPan)+'</dd>':'')+(f.vendorContact?'<dt>Contact</dt><dd>'+esc(f.vendorContact)+'</dd>':'')+(f.billingAddress?'<dt>Billing to</dt><dd>'+esc(f.billingAddress)+'</dd>':''))+
    '<dt>Raised</dt><dd>'+esc(fmtD(r.createdAt))+'</dd><dt>Approvers</dt><dd>'+r.chain.length+' in sequence</dd></dl>'+(f.remarks?'<div class="sep"></div><div class="hint" style="margin-bottom:5px">Remarks</div><div style="white-space:pre-wrap">'+esc(f.remarks)+'</div>':'')+'</div>';
  return '<button class="btn ghost sm" id="d-back" style="margin-bottom:12px">Back</button>'+banner+'<div class="detail-grid"><div><div class="card pad"><h3 style="margin-bottom:16px">The chain</h3><div class="rail">'+nodes+'</div></div>'+notes+'</div><div>'+facts+panel+'</div></div>';
}
function wireDetail(v){
  const r=DB.requests.find(x=>x.id===ROUTE.id); if(!r) return;
  $('#d-back',v).onclick=()=>go({name:'all'});
  let allFiles=r.files.slice(); r.chain.forEach(s=>{allFiles=allFiles.concat(s.files||[]);tasksOf(s).forEach(t=>{allFiles=allFiles.concat(t.files||[])})});
  bindFiles(v,allFiles);
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
    $('#a-ok',v).onclick=()=>act('approve','approve '+docNo(r));
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
    c.innerHTML='<div class="picked">'+tplDraft.steps.map((id,i)=>{const u=user(id);return '<div class="r"><span class="seq">'+(i+1)+'</span><div class="av sm">'+inits(u.name)+'</div><div style="min-width:0;flex:1"><b>'+esc(u.name)+'</b><div class="hint">'+esc(u.role||'')+(u.dept?' · '+esc(u.dept):'')+'</div></div>'+
      '<button class="btn sm" data-up="'+i+'" '+(i===0?'disabled':'')+'>↑</button><button class="btn sm" data-dn="'+i+'" '+(i===tplDraft.steps.length-1?'disabled':'')+'>↓</button><button class="btn sm" data-rm="'+i+'">Remove</button></div>'}).join('')+'</div><div class="hint" style="margin-top:9px">The person raising a request is always the first node, so this list starts at their first approver.</div>';
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
  head('My team','Confirm who reports to you, then you can assign them work inside a request');
  const team=teamOf(ME.id), pend=pendingTeam(ME.id);
  const load2=u=>DB.requests.reduce((n,r)=>n+r.chain.reduce((m,s)=>m+tasksOf(s).filter(t=>t.userId===u.id&&t.status==='open').length,0),0);
  return (pend.length?'<div class="card pad" style="margin-bottom:16px;border-color:var(--hold)"><h3>Waiting for you to confirm</h3><p class="hint" style="margin-top:5px">These people picked you as their manager. Confirm only the ones who really report to you — an unconfirmed person cannot be assigned work.</p><div style="margin-top:12px">'+
    pend.map(u=>'<div class="filerow"><div class="av sm">'+inits(u.name)+'</div><div style="min-width:0;flex:1"><b>'+esc(u.name)+'</b><div class="hint">'+esc(u.role)+' · '+esc(u.dept||'')+'</div></div><button class="btn sm ok" data-yes="'+u.id+'">Confirm</button><button class="btn sm" data-no="'+u.id+'">Not my team</button></div>').join('')+'</div></div>':'')+
   '<div class="card pad" style="margin-bottom:16px"><div class="row" style="flex-wrap:wrap"><div><h3>'+team.length+' confirmed team member'+(team.length===1?'':'s')+'</h3><p class="hint" style="margin-top:4px">You can hand any of them a task when a request reaches your step.</p></div><button class="btn primary" id="t-add" style="margin-left:auto">Add someone to my team</button></div></div>'+
   (team.length?'<div class="card"><table><thead><tr><th>Name</th><th>Designation</th><th>Department</th><th>Open tasks</th><th></th></tr></thead><tbody>'+team.map(u=>'<tr><td><div class="row" style="gap:10px"><div class="av sm">'+inits(u.name)+'</div><div><b>'+esc(u.name)+'</b><div class="hint">'+esc(u.email)+'</div></div></div></td><td>'+esc(u.role||'')+'</td><td class="hint">'+esc(u.dept||'')+'</td><td class="num">'+(load2(u)||'—')+'</td><td style="text-align:right"><button class="btn sm" data-rm="'+u.id+'">Remove</button></td></tr>').join('')+'</tbody></table></div>'
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
  return '<div class="card pad" style="margin-bottom:16px"><div class="grid" style="grid-template-columns:repeat(6,minmax(0,1fr));gap:12px">'+
    '<div><label for="r-f">From</label><input id="r-f" type="date" value="'+rep.from+'"></div><div><label for="r-t">Until</label><input id="r-t" type="date" value="'+rep.to+'"></div>'+
    '<div><label for="r-ty">Type</label><select id="r-ty"><option value="">Both</option><option value="indent" '+(rep.type==='indent'?'selected':'')+'>Indent</option><option value="workorder" '+(rep.type==='workorder'?'selected':'')+'>Work order</option></select></div>'+
    '<div><label for="r-s">Status</label><select id="r-s"><option value="">All</option>'+['In Progress','Info Requested','Approved','Rejected'].map(s=>'<option '+(rep.status===s?'selected':'')+'>'+s+'</option>').join('')+'</select></div>'+
    '<div><label for="r-rq">Raised by</label><select id="r-rq"><option value="">Anyone</option>'+opts+'</select></div><div><label for="r-ap">Approver</label><select id="r-ap"><option value="">Anyone</option>'+opts+'</select></div></div>'+
    '<div class="row" style="margin-top:14px;flex-wrap:wrap"><button class="btn primary" id="r-x">Download spreadsheet</button><button class="btn ghost sm" id="r-cl">Clear filters</button>'+
    '<span class="hint" style="margin-left:auto">'+l.length+' requests · work order value '+money(val||0)+' · average clearance '+avg+' days</span></div></div>'+
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
    '<div class="card" style="overflow-x:auto"><table style="min-width:980px"><thead><tr><th>Person</th><th>Department</th><th>Last signed in</th><th>Today</th><th>7 days</th><th>This month</th><th>All time</th><th>Sign-ins</th><th>Raised</th><th>Decisions</th><th>Tasks</th></tr></thead><tbody>'+
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
      '<div style="margin-top:13px"><label for="q-m">Reports to</label><select id="q-m">'+mgrOptions(ME.managerId)+'</select><div class="hint">Your manager confirms this before they can assign you work.</div></div><div id="q-e" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
    footer:'<button class="btn" data-x>Later</button><button class="btn primary" id="q-g">Save and continue</button>',
    onOpen:(v,c)=>{$('#q-g',v).onclick=async()=>{const r=$('#q-r',v).value.trim(),d=$('#q-d',v).value,m=$('#q-m',v).value||null;
      if(r.length<2) return $('#q-e',v).textContent='Enter your designation.'; if(!d) return $('#q-e',v).textContent='Choose your department.';
      try{ await rpc('update_my_profile',{p_role:r,p_dept:d,p_manager:m}); await load(); c(); $('#me-role').textContent=ME.role; render(); paintNav(); toast('Directory entry updated.','ok'); if(!pinOK(ME))setTimeout(pinDialog,350) }
      catch(e){ $('#q-e',v).textContent=(e.message||'').replace(/^.*?: /,'') }}}});
}
function viewPeople(){
  const typed={}; DB.requests.forEach(r=>{const n=r.f.siteName; if(n&&!byName.has(String(n).toLowerCase())) typed[n]=1}); const unlisted=Object.keys(typed);
  const stuck=DB.requests.filter(r=>r.status==='In Progress'&&r.chain[r.current]);
  return '<div class="card pad" style="margin-bottom:16px"><div class="row" style="flex-wrap:wrap"><div><h3>'+DB.users.filter(u=>u.active).length+' people can be added to a chain</h3><p class="hint" style="margin-top:4px">Anyone registered shows up when a requester searches for approvers. New people register themselves from the sign-in screen; an admin then sets their access here.</p></div>'+
    '<div class="row" style="margin-left:auto;gap:8px"><button class="btn" id="p-pw">Change password</button><button class="btn" id="p-me">My directory entry</button></div></div></div>'+
   '<div class="card"><table><thead><tr><th>Name</th><th>Designation</th><th>Department</th><th>Reports to</th><th>Access</th><th>PIN</th><th></th></tr></thead><tbody>'+
   DB.users.map(u=>{const mgr=u.managerId?user(u.managerId):null, badges=(u.owner?'<span class="tag" style="background:#1A1338;color:#fff;border-color:#1A1338">System owner</span> ':'')+(u.admin&&!u.owner?'<span class="tag t-prog">Admin</span> ':'')+(u.manager?'<span class="tag t-ok">Manager</span> ':'')+(u.seeAll&&!u.admin?'<span class="tag t-wait">Sees all</span>':'');
     return '<tr'+(u.active?'':' style="opacity:.55"')+'><td><div class="row" style="gap:10px"><div class="av sm">'+inits(u.name)+'</div><div><b>'+esc(u.name)+'</b>'+(u.id===ME.id?' <span class="hint">(you)</span>':'')+(u.active?'':' <span class="tag t-bad">off</span>')+'<div class="hint">'+esc(u.email)+'</div></div></div></td><td>'+esc(u.role||'')+'</td>'+
     '<td class="hint">'+esc(u.dept||'')+'</td><td class="hint">'+(mgr?esc(mgr.name)+(u.managerConfirmed?'':' <span class="tag t-hold">unconfirmed</span>'):'—')+'</td><td>'+(badges||'<span class="hint">—</span>')+'</td><td>'+(pinOK(u)?'<span class="tag t-ok">Set</span>':'<span class="tag t-wait">Not set</span>')+'</td>'+
     '<td style="text-align:right">'+(ME.admin&&(!u.owner||u.id===ME.id)?'<button class="btn sm" data-ed="'+u.id+'">Edit</button>':(u.owner?'<span class="hint">only the owner</span>':''))+'</td></tr>'}).join('')+'</tbody></table></div>'+
   (ME.admin?'<div class="card pad" style="margin-top:16px"><h3>Departments</h3><p class="hint" style="margin-top:5px">A request shows a handover whenever it crosses from one of these to another, so keep the list tight.</p><div class="row" style="flex-wrap:wrap;gap:7px;margin-top:12px">'+
     DB.departments.map(d=>'<span class="tag t-wait">'+esc(d)+' <button class="btn ghost sm" data-dd="'+esc(d)+'" style="padding:0 4px" title="Remove">×</button></span>').join('')+'</div><div class="row" style="gap:8px;margin-top:14px"><input id="dp-new" type="text" placeholder="Add a department" style="max-width:280px"><button class="btn sm" id="dp-add">Add</button></div></div>':'')+
   (ME.admin?'<div class="card pad" style="margin-top:16px"><h3>Requests stuck on an absent approver</h3><p class="hint" style="margin-top:5px">Only an admin can move a request off someone who is unavailable. The original assignment stays in the trail.</p>'+
     (stuck.length?'<div style="margin-top:12px">'+stuck.map(r=>'<div class="filerow"><div style="min-width:0;flex:1"><b>'+esc(docTitle(r))+'</b><div class="hint">'+esc(r.ref)+' · with '+esc(user(r.chain[r.current].userId).name)+' for '+daysBetween(r.chain[r.current].actedAt||r.createdAt,Date.now())+' days</div></div><button class="btn sm" data-re="'+r.id+'">Reassign</button></div>').join('')+'</div>':'<p class="hint" style="margin-top:10px">Nothing is currently in progress.</p>')+'</div>':'')+
   '<div class="grid g2" style="margin-top:16px;align-items:start"><div class="card pad"><h3>Station master</h3><p class="hint" style="margin-top:5px">'+STATIONS.length+' stations loaded.'+(ME.admin?' Upload a replacement to refresh the list — the columns must stay ERP Code, Station Name, State.':'')+'</p>'+(ME.admin?'<div id="p-mast" style="margin-top:12px"></div>':'')+'</div>'+
   '<div class="card pad"><h3>Typed, not in the master</h3>'+(unlisted.length?'<p class="hint" style="margin-top:5px">Typed by requesters and not found in the station master. Worth adding.</p><ul style="margin:10px 0 0;padding-left:18px">'+unlisted.map(n=>'<li>'+esc(n)+'</li>').join('')+'</ul>':'<p class="hint" style="margin-top:5px">Nothing so far — every site used has matched the master.</p>')+
     '<div class="sep"></div><h3>Project names</h3><p class="hint" style="margin-top:5px">'+DB.projects.map(esc).join(', ')+'</p></div></div>'+
   '<div class="card pad" style="margin-top:16px"><h3>The record is permanent</h3><p class="hint" style="margin-top:5px">Requests, approvals, conditions and the audit trail cannot be deleted or edited once recorded — the database has no way to do it. Corrections are added as new entries so the original stays visible.</p></div>';
}
function wirePeople(v){
  $('#p-me',v).onclick=profileDialog;
  $('#p-pw',v).onclick=()=>newPasswordDialog({title:'Change your password',cancellable:true});
  $$('[data-ed]',v).forEach(b=>b.onclick=()=>{const u=user(b.dataset.ed);
    modal({title:'Edit '+u.name,body:'<div class="grid" style="gap:13px"><div class="grid g2"><div><label for="e-role">Designation</label><input id="e-role" type="text" value="'+esc(u.role||'')+'" list="dl-role"></div><div><label for="e-dept">Department</label><select id="e-dept">'+deptOptions(u.dept)+'</select></div></div>'+
        '<div><label for="e-mgr">Reports to</label><select id="e-mgr">'+mgrOptions(u.managerId)+'</select></div><div class="sep" style="margin:2px 0"></div>'+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-man" style="width:auto" '+(u.manager?'checked':'')+'> <span><b>Manager</b><div class="hint">Can assign work to their team inside a request.</div></span></label>'+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-see" style="width:auto" '+(u.seeAll?'checked':'')+'> <span><b>Can see every request</b><div class="hint">For audit or finance oversight, without full admin rights.</div></span></label>'+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-adm" style="width:auto" '+(u.admin?'checked':'')+' '+(u.id===ME.id||u.owner?'disabled':'')+'> <span><b>Administrator</b><div class="hint">'+(u.owner?'The system owner is always an administrator. This cannot be changed by anyone.':'Sees everything, edits people and masters, reassigns stuck requests.')+'</div></span></label>'+
        '<label style="display:flex;align-items:center;gap:9px;margin:0"><input type="checkbox" id="e-act" style="width:auto" '+(u.active?'checked':'')+' '+(u.id===ME.id||u.owner?'disabled':'')+'> <span><b>Account active</b><div class="hint">'+(u.owner?'The system owner account cannot be switched off.':'Switched-off people cannot sign in or be added to chains.')+'</div></span></label></div>'+lists()+'<div id="e-err" style="color:var(--stop);font-size:13px;margin-top:10px"></div>',
      footer:'<button class="btn" data-x>Cancel</button><button class="btn primary" id="eg">Save</button>',
      onOpen:(mv,cl)=>{$('#eg',mv).onclick=async()=>{const d=$('#e-dept',mv).value; if(!d) return $('#e-err',mv).textContent='Choose a department.';
        try{ await rpc('admin_update_profile',{p_user:u.id,p_role:$('#e-role',mv).value.trim(),p_dept:d,p_manager:$('#e-mgr',mv).value||null,p_is_manager:$('#e-man',mv).checked,p_see_all:$('#e-see',mv).checked,p_is_admin:u.id===ME.id?true:$('#e-adm',mv).checked,p_active:u.id===ME.id?true:$('#e-act',mv).checked});
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
