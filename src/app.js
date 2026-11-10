/* Easy Compare — 前端交互层
   - Tauri WebView 内：全部文件操作经 IPC 交给 Rust 核心
   - 普通浏览器打开：自动进入「演示数据」模式，界面可独立验收
   安全约束：前端不接触任何绝对路径到磁盘的写入，只传会话标识与相对路径。 */
(function () {
  'use strict';

  // ---------- IPC 适配 ----------
  const TAURI = window.__TAURI__ || {};
  const INTERNALS = window.__TAURI_INTERNALS__ || {};
  const IS_TAURI = !!(INTERNALS.invoke || (TAURI.core && TAURI.core.invoke) || TAURI.invoke);

  function invoke(cmd, args) {
    if (INTERNALS.invoke) return INTERNALS.invoke(cmd, args || {});
    if (TAURI.core && TAURI.core.invoke) return TAURI.core.invoke(cmd, args || {});
    if (TAURI.invoke) return TAURI.invoke(cmd, args || {});
    return demo(cmd, args || {});
  }
  function listen(evt, handler) {
    if (TAURI.event && TAURI.event.listen) return TAURI.event.listen(evt, handler);
    return Promise.resolve(function () {});
  }

  // ---------- 演示数据（浏览器预览用） ----------
  const DEMO_TREE = [
    { id:'a', rel:'项目A', name:'项目A', kind:'dir', state:'diff', l:'', r:'', lb:0, rb:0, lt:'', rt:'', nw:'', err:'', hasL:true, hasR:true, children:[
      { id:'a1', rel:'项目A/需求说明_v1.docx', name:'需求说明_v1.docx', kind:'file', state:'ok', l:'82 KB', r:'82 KB', lb:83968, rb:83968, lt:'已同步', rt:'已同步', nw:'', err:'', hasL:true, hasR:true, children:[] },
      { id:'a2', rel:'项目A/架构设计.pptx', name:'架构设计.pptx', kind:'file', state:'diff', l:'4.2 MB', r:'3.8 MB', lb:4404019, rb:3984589, lt:'源较新', rt:'目标较旧', nw:'source', err:'', hasL:true, hasR:true, children:[] },
      { id:'a3', rel:'项目A/预算表.xlsx', name:'预算表.xlsx', kind:'file', state:'conflict', l:'1.1 MB', r:'1.0 MB', lb:1153434, rb:1048576, lt:'两侧均已改动', rt:'两侧均已改动', nw:'source', err:'', hasL:true, hasR:true, children:[] },
      { id:'a4', rel:'项目A/接口文档.md', name:'接口文档.md', kind:'file', state:'left', l:'24 KB', r:'', lb:24576, rb:0, lt:'待新增', rt:'缺失', nw:'', err:'', hasL:true, hasR:false, children:[] }
    ]},
    { id:'b', rel:'项目B', name:'项目B', kind:'dir', state:'left', l:'', r:'', lb:0, rb:0, lt:'', rt:'', nw:'', err:'', hasL:true, hasR:true, children:[
      { id:'b1', rel:'项目B/会议纪要_1108.md', name:'会议纪要_1108.md', kind:'file', state:'left', l:'16 KB', r:'', lb:16384, rb:0, lt:'待新增', rt:'缺失', nw:'', err:'', hasL:true, hasR:false, children:[] },
      { id:'b2', rel:'项目B/原型稿_v3.fig', name:'原型稿_v3.fig', kind:'file', state:'ok', l:'2.4 MB', r:'2.4 MB', lb:2516582, rb:2516582, lt:'已同步', rt:'已同步', nw:'', err:'', hasL:true, hasR:true, children:[] }
    ]},
    { id:'c', rel:'参考资料', name:'参考资料', kind:'dir', state:'ok', l:'', r:'', lb:0, rb:0, lt:'', rt:'', nw:'', err:'', hasL:true, hasR:true, children:[
      { id:'c1', rel:'参考资料/行业规范.pdf', name:'行业规范.pdf', kind:'file', state:'ok', l:'6.8 MB', r:'6.8 MB', lb:7130317, rb:7130317, lt:'已同步', rt:'已同步', nw:'', err:'', hasL:true, hasR:true, children:[] },
      { id:'c2', rel:'参考资料/术语表.xlsx', name:'术语表.xlsx', kind:'file', state:'ok', l:'48 KB', r:'48 KB', lb:49152, rb:49152, lt:'已同步', rt:'已同步', nw:'', err:'', hasL:true, hasR:true, children:[] }
    ]},
    { id:'d', rel:'旧归档_2024.zip', name:'旧归档_2024.zip', kind:'file', state:'right', l:'', r:'210 MB', lb:0, rb:220200960, lt:'源端已无', rt:'默认保留', nw:'', err:'', hasL:false, hasR:true, children:[] },
    { id:'e', rel:'README.md', name:'README.md', kind:'file', state:'ok', l:'4 KB', r:'4 KB', lb:4096, rb:4096, lt:'已同步', rt:'已同步', nw:'', err:'', hasL:true, hasR:true, children:[] }
  ];
  const DEMO_DRIVES = [
    { root:'C:\\', label:'系统盘', volumeId:'A1B2-C3D4', driveType:'本地磁盘', freeBytes: 92*1073741824, totalBytes: 512*1073741824 },
    { root:'E:\\', label:'MyPassport', volumeId:'5E7F-1A2B', driveType:'可移动磁盘', freeBytes: 710*1073741824, totalBytes: 1000*1073741824 }
  ];

  function demo(cmd, a) {
    const P = (v) => Promise.resolve(v);
    const tree = () => JSON.parse(JSON.stringify(DEMO_TREE));
    const counts = () => ({ ok:5, diff:1, left:2, right:1, conflict:1, unknown:0, total:10 });
    const cmp = () => ({
      sessionId:'demo', sourcePath: document.getElementById('srcPath').value || 'D:\\工作文档\\',
      targetPath: document.getElementById('tgtPath').value || 'E:\\Backup\\工作文档\\',
      tree: tree(), counts: counts(), comparedAt: Math.floor(Date.now()/1000), hasBaseline:false,
      volumeOk:true, volumeMessage:'卷标识与路径校验通过', compareRule:'quick',
      warnings:['演示数据，未连接本地文件系统'], scannedFiles:10, skippedLinks:0, aborted:false
    });
    switch (cmd) {
      case 'app_info': return P({ product:'Easy Compare', version:'0.0.1 (演示)', dataDir:'-', platform:'windows' });
      case 'list_drives': return P(DEMO_DRIVES);
      case 'browse_dirs': {
        const names = a.path && a.path.indexOf('E:') === 0
          ? ['Backup','照片','软件安装包'] : ['工作文档','下载','桌面','项目资料'];
        return P(names.map(n => ({ name:n, path:(a.path||'D:\\') + n + '\\', hasChildren:true })));
      }
      case 'list_sessions': return P([]);
      case 'active_session': return P(null);
      case 'delete_session': return P(null);
      case 'validate_and_bind': {
        const src = a.source || 'D:\\工作文档\\', tgt = a.target || 'E:\\Backup\\工作文档\\';
        return P({ ok:true, sourceExists:true, sourceReadable:true, targetExists:true, targetWritable:true,
          targetVolume:'5E7F-1A2B|MyPassport', targetFreeBytes:710*1073741824, message:'演示模式：未做真实校验',
          session:{ id:'demo', name:a.name||'笔记本 → 移动硬盘', sourcePath:src, targetPath:tgt,
            targetVolume:'5E7F-1A2B|MyPassport', compareRule:'quick', filters:{}, lastBackupAt:null,
            createdAt:Math.floor(Date.now()/1000), updatedAt:Math.floor(Date.now()/1000) } });
      }
      case 'rebind_target': return P({ ok:true, message:'演示模式：已模拟重绑', session:{ id:'demo', name:'演示会话', sourcePath:'D:\\工作文档\\', targetPath:a.newTarget, targetVolume:'5E7F-1A2B|MyPassport', compareRule:'quick', filters:{}, lastBackupAt:null, createdAt:0, updatedAt:0 }, targetVolume:'5E7F-1A2B|MyPassport' });
      case 'compare': return new Promise(r => setTimeout(() => r(cmp()), 420));
      case 'cancel_scan': return P(null);
      case 'verify_hashes': return new Promise(r => setTimeout(() => r(cmp()), 350));
      case 'create_plan': {
        // 与 Rust 侧一致：前端传相对路径，按小写归一化后匹配。
        const selSet = new Set((a.selected || []).map(s => String(s).toLowerCase()));
        const files = flatten(DEMO_TREE);
        const add = files.filter(n => n.state==='left' && selSet.has(String(n.rel).toLowerCase()));
        const over = files.filter(n => n.state==='diff' && selSet.has(String(n.rel).toLowerCase()));
        const conflicts = files.filter(n => n.state==='conflict' && !(a.resolutions||{})[n.id]);
        return P({ id:'demo-plan', sessionId:'demo', createdAt:Math.floor(Date.now()/1000),
          toAdd:add.map(n=>({rel:n.rel,size:n.lb,action:'add'})),
          toOverwrite:over.map(n=>({rel:n.rel,size:n.lb,action:'overwrite'})), toDelete:[],
          toSkip:[], conflicts:conflicts.map(n=>n.rel),
          totalBytes:[...add,...over].reduce((s,n)=>s+n.lb,0), targetFreeBytes:710*1073741824,
          spaceOk:true, keepOldVersions:a.keepOldVersions!==false, mirrorMode:!!a.mirrorMode,
          volumeOk:true, executable:add.length+over.length>0 && conflicts.length===0,
          message: conflicts.length ? '存在冲突尚未逐项处置，执行已阻断' : '预演通过，可以执行' });
      }
      case 'execute_backup': return new Promise(r => setTimeout(() => r({
        planId:a.planId, perItem:[], succeeded:(a.planId?3:0), failed:0, skipped:0,
        finishedAt:Math.floor(Date.now()/1000), baselineUpdated:true, abortedReason:'' }), 500));
      case 'refresh_after_backup': return P(cmp());
      case 'export_report': return P('演示模式：未生成文件');
      default: return P(null);
    }
  }

  // ---------- 状态 ----------
  const S = {
    ok:{label:'已同步',cls:'ok',sym:'=',mcls:'m-ok'},
    diff:{label:'需更新',cls:'diff',sym:'≠',mcls:'m-diff'},
    left:{label:'仅源有',cls:'left',sym:'→',mcls:'m-left'},
    right:{label:'仅目标有',cls:'right',sym:'←',mcls:'m-right'},
    conflict:{label:'冲突',cls:'conflict',sym:'!',mcls:'m-conflict'},
    unknown:{label:'未比对',cls:'unknown',sym:'·',mcls:'m-ok'}
  };
  let DATA = [], expanded = new Set(), selected = new Set(), resolutions = {};
  let onlyDiff = true, stateFilter = 'all', keyword = '';
  let mirror = false, keepOld = true, session = null, compareResult = null, currentPlan = null;
  // 排除规则：结构与会话内的 Filters 一致（camelCase）
  let filters = { excludeExt: [], excludePatterns: [], excludeDirs: [] };
  let busy = false;

  const $ = id => document.getElementById(id);
  const AMP = String.fromCharCode(38);
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':AMP+'amp;','<':AMP+'lt;','>':AMP+'gt;','"':AMP+'quot;'}[c])); }
  function fmt(b){ b=Number(b)||0; return b>=1073741824?(b/1073741824).toFixed(1)+' GB':b>=1048576?(b/1048576).toFixed(1)+' MB':b>=1024?(b/1024).toFixed(0)+' KB':b+' B'; }
  /** 去掉 Windows 扩展长度路径前缀（`\\?\`、`\\?\UNC\`、`\\.\`、`//?/`），仅用于展示。 */
  function prettyPath(p){
    const s=String(p==null?'':p);
    if(!s) return s;
    // 先统一分隔符再判断前缀；无前缀时仍返回原串，不动用户原有的写法。
    const v=s.replace(/\//g,'\\');
    if(v.indexOf('\\\\?\\UNC\\')===0) return '\\\\'+v.slice(8);
    if(v.indexOf('\\\\?\\')===0||v.indexOf('\\\\.\\')===0) return v.slice(4);
    return s;
  }
  function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),2200); }
  function flatten(list, out){ out=out||[]; (list||[]).forEach(n=>{ out.push(n); if(n.children&&n.children.length) flatten(n.children,out); }); return out; }
  function files(n){ return n.kind==='file'?[n]:flatten(n.children||[],[]).filter(x=>x.kind==='file'); }
  function selectable(n){ return n.kind==='file' && (n.state==='left'||n.state==='diff'); }
  function normFilters(f){
    f=f||{};
    const arr=v=>Array.isArray(v)?v.map(x=>String(x).trim()).filter(Boolean):[];
    return { excludeExt:arr(f.excludeExt), excludePatterns:arr(f.excludePatterns), excludeDirs:arr(f.excludeDirs) };
  }
  function filterCount(){ return filters.excludeExt.length+filters.excludePatterns.length+filters.excludeDirs.length; }
  function adoptSession(s){
    if(!s) return;
    // 旧会话或不同版本可能带 `\\?\` 前缀，展示前统一剥掉。
    s.sourcePath=prettyPath(s.sourcePath);
    s.targetPath=prettyPath(s.targetPath);
    session=s;
    filters=normFilters(s.filters);
    if(s.compareRule) $('ruleSel').value=s.compareRule;
  }
  function syncFilterChip(){
    const el=$('filterBtn'); if(!el) return;
    const n=filterCount();
    const badge=$('filterCount');
    if(badge) badge.textContent=n?String(n):'';
    el.classList.toggle('on',n>0);
    // 图标按钮没有文字，名称与数量放在 tooltip + aria-label 里
    el.title=n?`过滤规则（已启用 ${n} 条）`:'过滤规则（未启用）';
    el.setAttribute('aria-label', n?`过滤规则，已启用 ${n} 条`:'过滤规则');
  }

  // ---------- 目录展开 / 折叠（左右两栏共用同一个 expanded 集合，天然同步） ----------
  /** chip 是 span，没有原生 disabled；用 aria-disabled + class 表达并自行短路点击。 */
  function setChipDisabled(el, off){
    if(!el) return;
    if(off){ el.setAttribute('aria-disabled','true'); el.classList.add('disabled'); }
    else { el.removeAttribute('aria-disabled'); el.classList.remove('disabled'); }
  }
  function chipOff(el){ return !!el&&el.getAttribute('aria-disabled')==='true'; }

  function toggleDir(id){
    if(!id) return;
    expanded.has(id)?expanded.delete(id):expanded.add(id);
    render();
  }
  /** 按 id 找节点（深度遍历，只在点击时调用一次）。 */
  function findNode(id){
    for(const n of flatten(DATA)) if(n.id===id) return n;
    return null;
  }
  /**
   * 单行选中：单击一行（文件或折叠后的文件夹）就切换该行是否需要备份。
   * 目录行按子树整体勾选/取消，所以折叠状态下也能一行选中整棵子树。
   */
  function toggleRow(n){
    if(!n) return;
    const fs=files(n).filter(selectable);
    if(!fs.length){
      toast(n.kind==='file'
        ? (n.state==='ok'?'该文件已同步，无需备份':(n.state==='right'?'该文件只在目标端存在，默认保留':'该行不能单独备份'))
        : '该目录下没有需要写入的条目');
      return;
    }
    const allOn=fs.every(f=>selected.has(f.id));
    fs.forEach(f=>allOn?selected.delete(f.id):selected.add(f.id));
    render();
  }
  function toggleRowById(id){ toggleRow(findNode(id)); }

  /**
   * 「复制到目标」：把这一行（文件或整棵子树）改成当前选择并直接进入预演。
   * 不直接写入——写入必须经过预演 + 确认，这是 Q1/Q3 的硬约束。
   */
  function copyRowToTarget(id){
    const n=findNode(id);
    if(!n) return;
    const fs=files(n).filter(selectable);
    if(!fs.length){ toggleRow(n); return; }   // 复用无可用项时的提示
    selected=new Set(fs.map(f=>f.id));
    resolutions={};
    render();
    showDryRun();
  }
  /** 命中搜索词时强制展开，否则命中项藏在折叠目录里看不见。 */
  function searching(){ return !!keyword; }

  // ---------- 视图预计算 ----------
  /**
   * 一次后序遍历，为每个节点缓存子树统计：
   *   files / ok / diff / left / right / conflict / unknown  子树内文件数与各状态计数
   *   sel / selOn / bytes   可勾选文件数、已勾选数、已勾选字节数
   *   lft / rgt             子树内源端 / 目标端存在的文件数
   *   hit                   自身或后代命中搜索词
   * 旧实现每渲染一行都要重新遍历该行子树（O(n²)），1.6 万行时点击折叠几乎无响应；
   * 改为一次遍历后，行渲染与折叠都只依赖 Map 查询。
   */
  const AGGF={files:0,ok:0,diff:0,left:0,right:0,conflict:0,unknown:0,sel:0,selOn:0,bytes:0,lft:0,rgt:0};
  function analyze(){
    const map=new Map();
    const kw=keyword.toLowerCase();
    function go(nodes){
      const agg=Object.assign({},AGGF,{hit:false});
      for(const n of nodes){
        const a=Object.assign({},AGGF,{hit:!kw||String(n.name).toLowerCase().indexOf(kw)>=0});
        if(n.kind==='file'){
          a.files=1;
          if(a[n.state]!==undefined) a[n.state]=1;
          if(n.hasL) a.lft=1;
          if(n.hasR) a.rgt=1;
          if(n.state==='left'||n.state==='diff'){
            a.sel=1;
            if(selected.has(n.id)){ a.selOn=1; a.bytes=Number(n.lb)||0; }
          }
        }else{
          const kids=go(n.children||[]);
          for(const k in AGGF) a[k]+=kids[k];
          a.hit=a.hit||kids.hit;
        }
        map.set(n.id,a);
        for(const k in AGGF) agg[k]+=a[k];
        agg.hit=agg.hit||a.hit;
      }
      return agg;
    }
    return { map, total:go(DATA) };
  }

  function stateOf(a){
    if(a.conflict) return 'conflict';
    if(a.diff) return 'diff';
    if(a.left) return 'left';
    if(a.right) return 'right';
    if(a.unknown) return 'unknown';
    return 'ok';
  }

  /** 搜索 / 状态筛选 / 「只看差异」的统一可见性判定。 */
  function rowVisible(n,a){
    if(keyword&&!a.hit) return false;
    if(stateFilter!=='all'&&!(a[stateFilter]>0)) return false;
    if(onlyDiff){
      if(n.kind==='file'){ if(n.state==='ok') return false; }
      else if(a.files>0&&a.ok===a.files) return false;
    }
    return true;
  }

  function isOpen(n){ return expanded.has(n.id)||searching(); }

  /**
   * 单个节点的两栏行 HTML。
   * 折叠按钮在左右两栏都渲染、且缩进位置一致，因此：
   *   1) 任何一栏都能折叠，2) 两栏天然同步，3) 目视上形成一列按钮，容易发现。
   */
  function rowHtml(n,depth,a){
    const isDir=n.kind==='dir';
    const open=isDir&&isOpen(n);
    const cs=stateOf(a), st=S[cs]||S.unknown;
    const indent=`<span class="ind" style="width:${depth*16}px"></span>`;
    const fold=isDir
      ? `<button type="button" class="fold${open?' open':''}" data-exp="${esc(n.id)}" aria-expanded="${open}" title="${open?'收起':'展开'}「${esc(n.name)}」（左右两栏同步）"></button>`
      : '<span class="fold-sp"></span>';
    const chk=a.sel===0?'unchecked':(a.selOn===0?'unchecked':(a.selOn>=a.sel?'checked':'indet'));
    const cb=a.sel>0
      ? `<span class="cb ${chk==='checked'?'checked':chk==='indet'?'indet':''}" data-sel="${esc(n.id)}" role="checkbox" aria-checked="${chk==='indet'?'mixed':String(chk==='checked')}" tabindex="0"></span>`
      : '<span class="cb disabled"></span>';
    const diffN=a.diff+a.left+a.conflict;
    const base=diffN>0?`子树 ${diffN} 处差异`:'全部已同步';
    // 单侧存在的目录必须说清方向，否则「仅目标有」的目录会显示成「全部已同步」。
    const labelL=!n.hasL?'缺失':(!n.hasR?'待新增':(n.lt||base));
    const labelR=!n.hasR?'缺失':(!n.hasL?'全部保留':(n.rt||base));
    // 目录已选中的条目数：折叠后也能一眼看出「这一行带了多少文件」。
    const selBadge=isDir&&a.selOn>0?`<span class="seln" title="已选 ${a.selOn} / ${a.sel} 个可备份文件">已选 ${a.selOn}${a.selOn<a.sel?'/'+a.sel:''}</span>`:'';
    const nameText=esc(n.name)+(isDir?'/':'');
    const nameL=n.hasL?`<span class="nm ${isDir?'dir':''} mono" title="${esc(n.name)}">${nameText}</span>`:'<span class="nm ghost">—</span>';
    const nameR=n.hasR?`<span class="nm ${isDir?'dir':''} mono" title="${esc(n.name)}">${nameText}</span>`:'<span class="nm ghost">—</span>';
    const sizeL=n.hasL&&n.l?`<span class="sz mono">${esc(n.l)}</span>`:'';
    const sizeR=n.hasR&&n.r?`<span class="sz mono">${esc(n.r)}</span>`:'';
    const tagL=isDir
      ? `<span class="st s-${n.hasL?st.cls:'unknown'}">${esc(labelL)}</span>`
      : `<span class="st s-${st.cls}">${esc(n.lt||st.label)}</span>`;
    const tagR=isDir
      ? `<span class="st s-${n.hasR?st.cls:'unknown'}">${esc(labelR)}</span>`
      : `<span class="st s-${n.hasR?st.cls:'unknown'}">${esc(n.hasR?(n.rt||st.label):'缺失')}</span>`;
    const midTitle=isDir?'目录仅汇总子树状态，不参与写入':st.label;
    // 「复制到目标」按钮：这一行有可备份项才可点；数量为子树内可备份文件数。
    const canCopy=a.sel>0;
    const copyTip=canCopy
      ? `复制到目标：把「${esc(n.name)}」${isDir?`及其 ${a.sel} 个待写入文件`:''}复制过去（先预演，确认后才写入）`
      : (isDir?'该目录下没有需要写入的条目':(n.state==='ok'?'已同步，无需复制':(n.state==='right'?'只在目标端存在，默认保留':'无需复制')));
    const copyBtn=`<button type="button" class="rowcopy${canCopy?'':' off'}" data-copy="${esc(n.id)}"${canCopy?'':' disabled'} title="${copyTip}" aria-label="${canCopy?'复制到目标':copyTip}"><svg class="ic"><use href="#i-copyto"/></svg></button>`;
    // 文件行也给 data-file，使整行点击即可选中；目录行沿用 data-row。
    const hook=isDir?`data-row="${esc(n.id)}" aria-expanded="${open}"`:`data-file="${esc(n.id)}"`;
    const selCls=chk==='checked'?' selected':(chk==='indet'?' partial':'');
    return `<div class="row t-${cs}${selCls}" ${hook} tabindex="0" role="treeitem" aria-level="${depth+1}" aria-selected="${chk==='checked'}">
      <div class="cell"><i class="bar b-${n.hasL?st.cls:'unknown'}"></i>${indent}${fold}${cb}${nameL}${selBadge}${sizeL}${tagL}</div>
      <div class="cell mid ${isDir?'m-ok':st.mcls}" title="${esc(midTitle)}">${isDir?'·':st.sym}${!isDir&&cs==='diff'&&n.nw==='target'?'←':''}</div>
      <div class="cell act">${copyBtn}</div>
      <div class="cell"><i class="bar b-${n.hasR?st.cls:'unknown'}"></i>${indent}${fold}${nameR}${selBadge}${sizeR}${tagR}</div>
    </div>`;
  }

  // ---------- 渲染（虚拟滚动） ----------
  /**
   * 行高固定 34px，配合虚拟滚动：无论 1.7 万行还是 17 行，
   * DOM 里始终只有一屏多一点的行，折叠与筛选都是毫秒级。
   */
  const ROW_H=34;
  let VIEW=[];              // 当前可见的扁平行（不受滚动影响）
  let winStart=-1, winEnd=-1;

  function render(){
    const { map, total }=analyze();
    VIEW=[];
    (function walk(nodes,depth){
      for(const n of nodes){
        const a=map.get(n.id);
        if(!a||!rowVisible(n,a)) continue;
        VIEW.push({ n, depth, a });
        if(n.kind==='dir'&&isOpen(n)) walk(n.children||[],depth+1);
      }
    })(DATA,0);

    updateSummary(total);

    const focused=document.activeElement;
    const fid=focused&&focused.closest?focused.closest('#tree [data-row],#tree [data-file]'):null;
    const focusId=fid?(fid.dataset.row||fid.dataset.file):null;

    winStart=-1;
    paint();
    if(focusId) restoreFocus(focusId);
  }

  /** 只重建视口内的行；滚动时增量替换。 */
  function paint(){
    const box=$('tree');
    if(!box) return;
    const total=VIEW.length;
    if(total===0){
      winStart=-1; winEnd=-1;
      box.innerHTML='<div class="empty-tip">没有符合当前筛选条件的条目。<br>请调整搜索词、状态筛选或关闭「只看差异」；若为首次使用，请先绑定目录并执行比对。</div>';
      return;
    }
    const vh=box.clientHeight||600;
    const start=Math.max(0, Math.floor(box.scrollTop/ROW_H)-6);
    const end=Math.min(total, Math.ceil((box.scrollTop+vh)/ROW_H)+6);
    if(start===winStart&&end===winEnd) return;
    winStart=start; winEnd=end;
    const out=[];
    if(start>0) out.push(`<div style="height:${start*ROW_H}px"></div>`);
    for(let i=start;i<end;i++){ const r=VIEW[i]; out.push(rowHtml(r.n,r.depth,r.a)); }
    if(end<total) out.push(`<div style="height:${(total-end)*ROW_H}px"></div>`);
    box.innerHTML=out.join('');
  }

  function restoreFocus(id){
    const rows=document.querySelectorAll('#tree [data-row],#tree [data-file]');
    for(const el of rows){
      if((el.dataset.row||el.dataset.file)===id){ el.focus({ preventScroll:true }); return; }
    }
  }

  function updateSummary(total){
    $('statusbar').innerHTML=`
      <span class="c-ok"><b>已同步 ${total.ok}</b></span>
      <span class="c-diff"><b>需更新 ${total.diff}</b></span>
      <span class="c-left"><b>仅源有 ${total.left}</b></span>
      <span class="c-right"><b>仅目标有 ${total.right}</b></span>
      <span class="c-conflict"><b>冲突 ${total.conflict}</b></span>
      <span class="push">已选 <b>${total.selOn}</b> 项 · 预计写入 <b>${fmt(total.bytes)}</b> · <span id="freeHint">目标盘容量以预演为准</span></span>`;
    $('srcCount').textContent=total.lft+' 项';
    $('tgtCount').textContent=total.rgt+' 项';
    const blocked=total.conflict>0&&Object.keys(resolutions).length<total.conflict;
    $('backupBtn').disabled=busy||total.selOn===0;
    $('blockHint').textContent=blocked?`存在 ${total.conflict} 项冲突，需在预演清单中逐项处置`:'';
    $('srcBadge').textContent=session?session.sourcePath:'—';
    $('tgtBadge').textContent=session?session.targetPath:'—';
    $('srcBadge').title=session?session.sourcePath:'';
    $('tgtBadge').title=session?session.targetPath:'';
    // 目录折叠总按钮：无目录或已全展开 / 已全收起时置灰，避免无效点击。
    const dirs=flatten(DATA).filter(n=>n.kind==='dir');
    const opened=dirs.filter(n=>expanded.has(n.id)).length;
    setChipDisabled($('expandAll'), dirs.length===0||opened===dirs.length);
    setChipDisabled($('collapseAll'), opened===0);
    if(session&&session.lastBackupAt){
      const days=Math.floor((Date.now()/1000-session.lastBackupAt)/86400);
      $('lastBackupPill').style.display='';
      $('lastBackupPill').textContent=days<=0?'上次备份：今天':`距上次备份 ${days} 天`;
    } else { $('lastBackupPill').style.display='none'; }
    syncFilterChip();
  }

  function applyResult(res){
    compareResult=res;
    DATA=res.tree||[];
    // 默认只展开第一层目录：1.7 万行的树上全展开会让首屏与每次折叠都明显卡顿，
    // 而第一层已经足够看清「哪个目录有差异」。其余用折叠按钮或「全部展开」打开。
    expanded=new Set((res.tree||[]).filter(n=>n.kind==='dir').map(n=>n.id));
    selected.clear(); resolutions={};
    render();
    $('scanTime').textContent='上次比对 '+new Date((res.comparedAt||Date.now()/1000)*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
    const warns=[];
    // 「未加载基线 / 未做冲突检测」属于首次比对的正常状态，不占版面提示。
    const noisy=/未做冲突检测|未加载基线/;
    if(res.warnings) warns.push(...res.warnings.filter(w=>!noisy.test(String(w))));
    if(res.aborted) warns.push('本次比对不完整（扫描被取消或中断），不能执行备份，请重新比对');
    if(!res.volumeOk) warns.push(res.volumeMessage||'目标卷校验未通过，已禁止写入');
    if(warns.length){
      $('warnText').textContent=warns.join('；');
      $('warnbar').classList.add('show');
      $('rebindBtn').style.display=!res.volumeOk&&IS_TAURI?'':'none';
    } else { $('warnbar').classList.remove('show'); }
  }

  // ---------- 弹窗 ----------
  function openModal(title,body,foot){ $('modalTitle').textContent=title; $('modalBody').innerHTML=body; $('modalFoot').innerHTML=foot; $('overlay').classList.add('show'); }
  function closeModal(){ $('overlay').classList.remove('show'); }

  // ---------- 目录选择器 ----------
  let dpTarget='srcPath', dpPath='', dpResolve=null;
  function openDirPicker(target){
    dpTarget=target;
    dpPath=$(target).value||'';
    openModal('选择目录','<div id="dpBody"></div>',`<button class="btn" id="dpCancel">取消</button><button class="btn go" id="dpChoose">选择当前目录</button>`);
    $('dpCancel').onclick=closeModal;
    $('dpChoose').onclick=()=>{ if(dpPath){ $(dpTarget).value=dpPath; } closeModal(); };
    renderDirPicker();
    refreshDirList();
  }
  function renderDirPicker(){
    const roots=window.__EC_DRIVES__||[];
    $('dpBody').innerHTML=`
      <div class="dp-crumb"><span>当前：</span><span class="mono" id="dpCur">${esc(dpPath||'未选择')}</span>
        <span class="root" id="dpUp">↑ 上一级</span></div>
      <div class="dp-drives" id="dpDrives">${roots.map(d=>`<span class="root" data-drive="${esc(d.root)}">${esc(d.root)} ${esc(d.label||d.driveType||'')}</span>`).join('')}</div>
      <div class="dp-list" id="dpList"><div class="dp-empty">正在读取目录…</div></div>
      <div class="dp-foot"><span>路径</span><input class="mono" id="dpInput" value="${esc(dpPath)}" spellcheck="false"><button class="btn" id="dpGo">转到</button></div>`;
    $('dpUp').onclick=()=>{ dpPath=parentOf(dpPath); refreshDirList(); };
    $('dpGo').onclick=()=>{ dpPath=$('dpInput').value.trim(); refreshDirList(); };
    $('dpDrives').onclick=e=>{ const t=e.target.closest('[data-drive]'); if(t){ dpPath=t.dataset.drive; refreshDirList(); } };
    $('dpList').onclick=e=>{
      const t=e.target.closest('[data-dir]');
      if(t){ dpPath=prettyPath(t.dataset.dir); refreshDirList(); }
    };
  }
  function parentOf(p){
    if(!p) return '';
    const s=String(p).replace(/[\\/]+$/,'');
    const i=Math.max(s.lastIndexOf('\\'),s.lastIndexOf('/'));
    if(i<=0) return s.slice(0,3)||s;
    if(/^[A-Za-z]:$/.test(s.slice(0,i))) return s.slice(0,i+1);
    return s.slice(0,i+1);
  }
  async function refreshDirList(){
    const cur=$('dpCur'); if(cur) cur.textContent=dpPath||'未选择';
    const inp=$('dpInput'); if(inp) inp.value=dpPath;
    const list=$('dpList'); if(!list) return;
    if(!dpPath){ list.innerHTML='<div class="dp-empty">请先在上方选择一个盘符，或在下方直接粘贴路径</div>'; return; }
    try{
      const items=await invoke('browse_dirs',{path:dpPath});
      list.innerHTML=(items&&items.length)?items.map(d=>`<div class="dp-item" data-dir="${esc(d.path)}" tabindex="0"><span>📁</span><span class="mono">${esc(d.name)}</span><span class="ar">›</span></div>`).join(''):'<div class="dp-empty">该目录下没有子目录</div>';
    }catch(e){ list.innerHTML=`<div class="dp-empty">无法读取：${esc(String(e))}</div>`; }
  }

  // ---------- 过滤规则 ----------
  function showFilters(){
    const join=v=>(v||[]).join('，');
    openModal('过滤规则（不影响已有文件，只影响后续比对与备份）',
      `<p class="ftip">多个值用逗号或空格分隔，大小写不敏感。被排除的文件不会出现在比对结果中，也不会被复制。</p>
      <label class="frow"><span>排除扩展名（不含点，例如 tmp, log, bak）</span>
        <input id="fExt" class="mono" placeholder="tmp, log, bak" value="${esc(join(filters.excludeExt))}" spellcheck="false"></label>
      <label class="frow"><span>排除文件名通配符（支持 * 与 ?，例如 ~$*）</span>
        <input id="fPat" class="mono" placeholder="~$*, *.tmp" value="${esc(join(filters.excludePatterns))}" spellcheck="false"></label>
      <label class="frow"><span>排除目录名（整层跳过，例如 .git, node_modules）</span>
        <input id="fDir" class="mono" placeholder=".git, node_modules" value="${esc(join(filters.excludeDirs))}" spellcheck="false"></label>
      <p class="ftip">客户端内部数据目录 .easy-compare 始终被排除。</p>`,
      `<button class="btn" id="fReset">清空规则</button><button class="btn" id="fCancel">取消</button><button class="btn go" id="fOk">保存并重新比对</button>`);
    const parse=id=>String($(id).value||'').split(/[,，;；\s]+/).map(s=>s.trim()).filter(Boolean);
    const save=async reset=>{
      filters=reset
        ? { excludeExt:[], excludePatterns:[], excludeDirs:[] }
        : { excludeExt:parse('fExt'), excludePatterns:parse('fPat'), excludeDirs:parse('fDir') };
      closeModal();
      toast(reset?'已清空过滤规则，正在重新比对':`已应用 ${filterCount()} 条过滤规则，正在重新比对`);
      if(session) await doCompare(session.id); else render();
    };
    $('fCancel').onclick=closeModal;
    $('fReset').onclick=()=>save(true);
    $('fOk').onclick=()=>save(false);
  }

  // ---------- 业务动作 ----------
  function setBusy(v,text){
    busy=v; $('scanbar').classList.toggle('show',v);
    if(text) $('scanText').textContent=text;
    $('bindBtn').disabled=v;
    $('backupBtn').disabled=v||flatten(DATA).filter(n=>n.kind==='file'&&selected.has(n.id)).length===0;
  }

  async function bindAndCompare(){
    const src=$('srcPath').value.trim(), tgt=$('tgtPath').value.trim();
    if(!src||!tgt){ toast('请先填写或选择源目录与目标目录'); return; }
    setBusy(true,'正在校验路径与卷标识…');
    try{
      const r=await invoke('validate_and_bind',{source:src,target:tgt,name:session?session.name:'',sessionId:session?session.id:null});
      if(!r||!r.ok){ toast('绑定失败：'+((r&&r.message)||'未知原因')); setBusy(false); return; }
      adoptSession(r.session);
      $('srcPath').value=session.sourcePath; $('tgtPath').value=session.targetPath;
      $('modePill').textContent=IS_TAURI?'已连接目录':'演示数据';
      await doCompare(session.id);
    }catch(e){ toast('绑定失败：'+String(e)); setBusy(false); }
  }

  async function doCompare(sessionId){
    setBusy(true,'正在递归扫描并比对…');
    try{
      const res=await invoke('compare',{sessionId:sessionId||(session&&session.id),compareRule:$('ruleSel').value,filters:normFilters(filters)});
      applyResult(res);
      toast(res&&res.aborted?'比对已取消，结果不完整':'比对完成');
    }catch(e){ toast('比对失败：'+String(e)); }
    finally{ setBusy(false); }
  }

  function selectedRels(){ return flatten(DATA).filter(n=>n.kind==='file'&&selected.has(n.id)).map(n=>n.rel); }
  function conflictNodes(){ return flatten(DATA).filter(n=>n.kind==='file'&&n.state==='conflict'); }

  async function makePlan(){
    const sel=selectedRels();
    try{
      const p=await invoke('create_plan',{sessionId:session?session.id:'demo',selected:sel,mirrorMode:mirror,
        keepOldVersions:keepOld,resolutions:resolutions});
      currentPlan=p;
      return p;
    }catch(e){ toast('预演生成失败：'+String(e)); return null; }
  }

  function planBody(p,showOpts){
    const list=arr=>(arr&&arr.length)?arr.map(i=>`<div><i style="color:var(--primary)">${i.action==='add'?'新增':i.action==='delete'?'移除':'覆盖'}</i><span class="mono">${esc(i.rel)}</span><span style="margin-left:auto;color:var(--faint)">${fmt(i.size)}</span></div>`).join(''):'<div style="color:var(--faint)">无</div>';
    const conflicts=conflictNodes();
    const conflictBox=conflicts.length?`<div class="conflict-box"><h4>⚠ 冲突条目需逐项处置（未处置时执行按钮不可用）</h4>
      ${conflicts.map(n=>`<div class="crow"><span class="nm mono" title="${esc(n.rel)}">${esc(n.rel)}</span>
        <select data-res="${esc(n.id)}">
          <option value="">— 请选择处置方式 —</option>
          <option value="overwrite" ${resolutions[n.id]==='overwrite'?'selected':''}>用源覆盖目标</option>
          <option value="keep" ${resolutions[n.id]==='keep'?'selected':''}>保留目标（本次跳过）</option>
          <option value="skip" ${resolutions[n.id]==='skip'?'selected':''}>跳过，以后再决定</option>
        </select></div>`).join('')}</div>`:'';
    const all=[...(p.toAdd||[]),...(p.toOverwrite||[]),...(p.toDelete||[])];
    return `<div class="modal-src mono">源 ${esc(prettyPath(compareResult?compareResult.sourcePath:$('srcPath').value))}　→　目标 ${esc(prettyPath(compareResult?compareResult.targetPath:$('tgtPath').value))}</div>
      <div class="pline"><span>将新增到目标</span><b class="amber">${(p.toAdd||[]).length} 项 / ${fmt((p.toAdd||[]).reduce((s,i)=>s+i.size,0))}</b></div>
      <div class="pline"><span>将覆盖目标同名文件</span><b class="red">${(p.toOverwrite||[]).length} 项 / ${fmt((p.toOverwrite||[]).reduce((s,i)=>s+i.size,0))}</b></div>
      <div class="pline"><span>仅目标有（镜像开启时才移除）</span><b>${(p.toDelete||[]).length} 项</b></div>
      <div class="pline"><span>将跳过</span><b>${(p.toSkip||[]).length} 项</b></div>
      <div class="pline"><span>冲突，阻断自动执行</span><b class="purple">${(p.conflicts||[]).length} 项</b></div>
      <div class="pline"><span>目标盘可用 / 预计写入</span><b class="${p.spaceOk?'green':'red'}">${fmt(p.targetFreeBytes)} / ${fmt(p.totalBytes)}</b></div>
      <div class="pline"><span>卷标识校验</span><b class="${p.volumeOk?'green':'red'}">${p.volumeOk?'通过':'未通过'}</b></div>
      <div class="plist">${list(all)}</div>
      ${conflictBox}
      ${showOpts?`<div class="opts">
        <label class="opt"><input type="checkbox" id="keepOld" ${keepOld?'checked':''}><span><b>覆盖前保留目标旧版本</b><small>旧文件按相对路径移入目标盘 .easy-compare/versions/，可手工恢复。Q3 决策，默认开启。</small></span></label>
        <label class="opt warn"><input type="checkbox" id="mirror" ${mirror?'checked':''}><span><b>同时移除目标端多余项（镜像模式）</b><small>仅移入版本目录而非直接抹除；开启后需二次确认。Q1 决策，默认关闭。</small></span></label>
      </div>`:''}
      ${p.message?`<p style="font-size:11.5px;color:${p.executable?'var(--ok)':'var(--diff)'};margin:12px 0 0">${esc(p.message)}</p>`:''}`;
  }

  async function showDryRun(){
    const p=await makePlan(); if(!p) return;
    openModal('预演清单（不产生任何写入）',planBody(p,true),
      `<button class="btn" id="mCancel">关闭</button><button class="btn go" id="mGo">继续到确认</button>`);
    bindPlanOptions(p);
    $('mCancel').onclick=closeModal;
    $('mGo').onclick=async()=>{ const np=await makePlan(); if(np) showConfirm(np); };
  }

  function bindPlanOptions(p){
    document.querySelectorAll('[data-res]').forEach(el=>{
      el.onchange=async e=>{
        const id=e.target.dataset.res, v=e.target.value;
        if(v) resolutions[id]=v; else delete resolutions[id];
        const np=await makePlan();
        if(np){
          currentPlan=np;
          // 同样延后，避免在 change 回调内替换掉正在派发事件的节点。
          setTimeout(()=>{
            if(!$('overlay').classList.contains('show')) return;
            const body=$('modalBody');
            if(body){ body.innerHTML=planBody(np,true); bindPlanOptions(np); }
            // 冲突处置完必须同步解除「确认执行」的禁用，否则用户会卡在这一步。
            const exec=$('mExec'); if(exec) exec.disabled=!np.executable;
          },0);
        }
      };
    });
    const ko=$('keepOld'); if(ko) ko.onchange=e=>{ keepOld=e.target.checked; };
    const mi=$('mirror'); if(mi) mi.onchange=e=>{
      if(e.target.checked){
        const del=(p.toDelete||[]), cnt=del.length;
        const preview=del.length
          ? `<div class="plist" style="max-height:190px;overflow:auto;margin:10px 0 0">${del.slice(0,12).map(i=>`<div><i style="color:var(--diff)">移除</i><span class="mono">${esc(i.rel)}</span><span style="margin-left:auto;color:var(--faint)">${fmt(i.size)}</span></div>`).join('')}${cnt>12?`<div style="color:var(--faint);padding:4px 0">… 另有 ${cnt-12} 项，完整清单见预演列表</div>`:''}</div>`
          : '<p style="color:var(--muted);font-size:12px">本次没有需要移除的目标端多余项。</p>';
        // 延后到本次 change 事件结束后再换弹窗，避免在事件回调内销毁自身节点。
        setTimeout(()=>{
          openModal('二次确认：镜像模式',`<div style="padding:4px 0">
            <p style="color:var(--diff);font-weight:600">此操作会把目标端的 ${cnt} 项多余文件移出当前目录。</p>
            <p style="color:var(--diff);font-size:12px;line-height:1.8">注意：镜像范围与左侧勾选无关，会处理目标端<b>全部</b>孤立项。请逐条核对下方清单。</p>
            <p style="color:var(--muted);font-size:12px;line-height:1.8">客户端会把待移除项移入目标盘版本目录，而不是直接抹除，可手工恢复。</p>
            ${preview}</div>`,
            `<button class="btn" id="mNo">返回（保持镜像关闭）</button><button class="btn danger" id="mYes">我确认开启镜像</button>`);
          $('mNo').onclick=async()=>{ mirror=false; const np=await makePlan(); if(np) showConfirm(np); };
          $('mYes').onclick=async()=>{ mirror=true; const np=await makePlan(); if(np) showConfirm(np); };
        },0);
        return;
      }
      mirror=false;
    };
  }

  function showConfirm(p){
    openModal('确认备份',planBody(p,true),
      `<button class="btn" id="mCancel">取消</button><button class="btn go" id="mExec" ${p.executable?'':'disabled'}>确认执行</button>`);
    bindPlanOptions(p);
    $('mCancel').onclick=closeModal;
    $('mExec').onclick=async()=>{
      const fresh=await makePlan();
      if(!fresh||!fresh.executable){ toast('计划不可执行：'+((fresh&&fresh.message)||'请先处置冲突')); return; }
      execute(fresh);
    };
  }

  async function execute(p){
    const total=(p.toAdd||[]).length+(p.toOverwrite||[]).length+(p.toDelete||[]).length;
    openModal('正在备份',`<div class="prog-text"><span>正在写入目标目录…</span><span id="pTxt">0 / ${total}</span></div>
      <div class="progress"><i id="pBar"></i></div><div class="plist" id="pLog"></div>`,
      `<span class="hint">单项失败不中断整批；关闭窗口不会取消已开始的写入</span>`);
    let done=0;
    const push=(rel,tag)=>{
      const log=$('pLog'); if(!log) return;
      log.insertAdjacentHTML('afterbegin',`<div><i style="color:var(--ok)">${esc(tag)}</i><span class="mono">${esc(rel)}</span></div>`);
      done++; const bar=$('pBar'), txt=$('pTxt');
      if(bar) bar.style.width=(total?Math.min(100,done/total*100):100)+'%';
      if(txt) txt.textContent=done+' / '+total;
    };
    let unsub=function(){};
    try{ unsub=await listen('backup-progress',e=>{ const d=e.payload||{}; if(d.status==='done') push(d.rel||'','完成'); }); }catch(e){}
    try{
      const res=await invoke('execute_backup',{planId:p.id,confirmed:true});
      unsub();
      // 演示模式下没有事件，用结果补齐进度
      if(done<total) for(let i=done;i<total;i++) push('','完成');
      const failed=(res&&res.failed)||0, ok=(res&&res.succeeded)||0;
      let after=null;
      try{ after=await invoke('refresh_after_backup',{sessionId:session?session.id:'demo'}); }catch(e){}
      if(after) applyResult(after);
      if(session&&res&&res.succeeded>0) session.lastBackupAt=res.finishedAt;
      render();
      const abort=res&&res.abortedReason?`<p style="color:var(--diff);font-size:11.5px">${esc(res.abortedReason)}</p>`:'';
      const failedItems=(res&&res.perItem?res.perItem:[]).filter(i=>i.outcome==='failed');
      const failedBox=failedItems.length?`<div class="plist" style="max-height:150px;overflow:auto">${failedItems.slice(0,30).map(i=>`<div><i style="color:var(--diff)">失败</i><span class="mono">${esc(i.rel)}</span><span style="margin-left:auto;color:var(--faint);max-width:45%;overflow:hidden;text-overflow:ellipsis">${esc(i.error||'')}</span></div>`).join('')}${failedItems.length>30?`<div style="color:var(--faint)">… 另有 ${failedItems.length-30} 项</div>`:''}</div>`:'';
      openModal('备份完成',`<div class="result-ok"><div class="big">✓</div>
        <p>成功写入 ${ok} 项，跳过 ${(res&&res.skipped)||0} 项，失败 ${failed} 项。</p>
        <p style="font-size:11.5px;margin-top:10px">客户端已自动重新比对，并把成功项写入基线${res&&res.baselineUpdated?'（基线已更新）':''}。</p>${abort}${failedBox}</div>`,
        `${failedItems.length?'<button class="btn" id="mRetry">重试失败项</button>':''}<button class="btn" id="mReport">导出报告</button><button class="btn go" id="mDone">完成</button>`);
      $('mDone').onclick=closeModal;
      if($('mRetry')) $('mRetry').onclick=()=>{
        const ids=new Set(failedItems.map(i=>String(i.rel).toLowerCase()));
        const nodes=flatten(DATA).filter(n=>n.kind==='file'&&ids.has(n.id));
        if(!nodes.length){ toast('失败项已不在当前比对结果中，请重新比对后再试'); closeModal(); return; }
        selected=new Set(nodes.map(n=>n.id));
        resolutions={};
        closeModal(); render(); showDryRun();
      };
      $('mReport').onclick=async()=>{ try{ const path=await invoke('export_report',{}); toast('报告已保存：'+path); }catch(e){ toast('导出失败：'+String(e)); } };
      selected.clear(); mirror=false; resolutions={}; render();
    }catch(e){
      unsub();
      openModal('备份中断',`<p style="color:var(--diff);font-size:12.5px;line-height:1.8">${esc(String(e))}</p>
        <p style="color:var(--muted);font-size:11.5px">已完成的写入不会回滚；请检查目标盘连接状态，然后重新比对确认实际结果。</p>`,
        `<button class="btn go" id="mDone2">知道了</button>`);
      $('mDone2').onclick=closeModal;
    }
  }

  async function showSessions(){
    let list=[]; try{ list=await invoke('list_sessions',{})||[]; }catch(e){}
    const body=list.length?`<div class="plist" style="max-height:none">${list.map(s=>`<div style="justify-content:space-between;align-items:center">
      <span><b>${esc(s.name)}</b><br><span class="mono" style="color:var(--faint);font-size:10.5px">${esc(prettyPath(s.sourcePath))} → ${esc(prettyPath(s.targetPath))}</span></span>
      <span><button class="btn" data-load="${esc(s.id)}">载入</button> <button class="btn danger" data-del="${esc(s.id)}">删除</button></span></div>`).join('')}</div>`
      :'<div class="empty-tip" style="padding:24px">暂无已保存会话。绑定目录后会自动保存。</div>';
    openModal('会话管理',body,'<button class="btn go" id="mCloseS">关闭</button>');
    $('mCloseS').onclick=closeModal;
    $('modalBody').onclick=async e=>{
      const l=e.target.closest('[data-load]'), d=e.target.closest('[data-del]');
      if(l){ const s=list.find(x=>x.id===l.dataset.load); if(s){ adoptSession(s); $('srcPath').value=s.sourcePath; $('tgtPath').value=s.targetPath; closeModal(); toast('已载入会话，正在比对…'); await doCompare(s.id); } }
      if(d){ try{ await invoke('delete_session',{id:d.dataset.del}); toast('已删除会话'); closeModal(); showSessions(); }catch(err){ toast('删除失败：'+String(err)); } }
    };
  }

  // ---------- 事件绑定 ----------
  // 滚动时只重绘视口内的行（rAF 去抖），1.7 万行也能顺滑滚动。
  let scrollRaf=0;
  $('tree').addEventListener('scroll',()=>{
    if(scrollRaf) return;
    scrollRaf=requestAnimationFrame(()=>{ scrollRaf=0; paint(); });
  });
  // 行单击 / 双击：单击 = 选中该行，双击目录行 = 折叠展开（参考资源管理器习惯）。
  // 注意：选中后整棵树会重绘，DOM 节点被替换，原生 dblclick 事件可能落在已移除的元素上，
  // 因此这里自己按「同一行 350ms 内两次点击」判定双击，不依赖 dblclick 事件。
  let lastRowClick={ id:'', t:0 };
  function activateRow(id, isDir){
    const now=Date.now();
    if(isDir&&lastRowClick.id===id&&now-lastRowClick.t<350){
      lastRowClick={ id:'', t:0 };
      toggleRowById(id);   // 撤销第一次单击造成的选中变化
      toggleDir(id);
      return;
    }
    lastRowClick={ id, t:now };
    toggleRowById(id);
  }

  $('tree').addEventListener('click',e=>{
    // 操作按钮优先：复制到目标 / 折叠，都不应触发选中
    const cp=e.target.closest('[data-copy]');
    if(cp){ lastRowClick={ id:'', t:0 }; copyRowToTarget(cp.dataset.copy); return; }
    const exp=e.target.closest('[data-exp]');
    if(exp){ toggleDir(exp.dataset.exp); return; }
    const sel=e.target.closest('[data-sel]');
    // 复选框本身就是明确的选中操作，不参与双击折叠判定
    if(sel){ lastRowClick={ id:'', t:0 }; toggleRowById(sel.dataset.sel); return; }
    // 其余位置：整行单击 = 选中 / 取消选中该行（文件或子树）
    const row=e.target.closest('[data-row],[data-file]');
    if(row) activateRow(row.dataset.row||row.dataset.file, !!row.dataset.row);
  });
  $('tree').addEventListener('keydown',e=>{
    const row=e.target.closest('[data-row],[data-file]');
    if(!row) return;
    const id=row.dataset.row||row.dataset.file;
    // 空格：选中 / 取消选中（与复选框语义一致）
    if(e.key===' '){ e.preventDefault(); toggleRowById(id); return; }
    if(e.key==='Enter'){ e.preventDefault(); if(row.dataset.row) toggleDir(id); return; }
    // 左右方向键：展开 / 收起当前目录（键盘导航）
    if(row.dataset.row&&(e.key==='ArrowRight'||e.key==='ArrowLeft')){
      e.preventDefault();
      const isOpen=expanded.has(id);
      if(e.key==='ArrowRight'&&!isOpen) toggleDir(id);
      if(e.key==='ArrowLeft'&&isOpen) toggleDir(id);
    }
  });
  // 工具按钮：<button> 原生已处理 Enter/Space，再绑 keydown 会双触发，所以只给非按钮元素补键盘支持。
  function chip(id,fn){
    const el=$(id); if(!el) return;
    el.onclick=fn;
    if(el.tagName!=='BUTTON'){
      el.onkeydown=e=>{ if(e.key===' '||e.key==='Enter'){ e.preventDefault(); fn(e); } };
    }
  }
  chip('onlyDiff',()=>{ onlyDiff=!onlyDiff; $('onlyDiff').classList.toggle('on',onlyDiff); $('onlyDiff').setAttribute('aria-checked',String(onlyDiff)); render(); });
  chip('filterBtn',showFilters);
  // 两个总按钮：全部展开 / 收起全部（收起后只留顶层，便于逐层查看）
  chip('expandAll',()=>{
    if(chipOff($('expandAll'))) return;
    const dirs=flatten(DATA).filter(n=>n.kind==='dir');
    if(!dirs.length) return;
    expanded=new Set(dirs.map(n=>n.id));
    $('tree').scrollTop=0;
    render();
    toast(`已展开 ${dirs.length} 个文件夹`);
  });
  chip('collapseAll',()=>{
    if(chipOff($('collapseAll'))) return;
    expanded.clear();
    $('tree').scrollTop=0;
    render();
    toast('已收起全部文件夹，只保留顶层');
  });
  chip('selectDiff',()=>{ flatten(DATA).filter(selectable).forEach(n=>selected.add(n.id)); render(); toast('已勾选全部可备份差异项'); });
  chip('clearSel',()=>{ selected.clear(); resolutions={}; render(); });
  chip('hashSel',async()=>{
    if(!compareResult){ toast('请先执行比对'); return; }
    const sel=selectedRels(); if(!sel.length){ toast('请先勾选需要精确校验的条目'); return; }
    setBusy(true,'正在对选中项计算 SHA-256…');
    try{ const res=await invoke('verify_hashes',{selected:sel}); applyResult(res); toast('选中项精确校验完成'); }
    catch(e){ toast('校验失败：'+String(e)); } finally{ setBusy(false); }
  });
  $('stateFilter').onchange=e=>{ stateFilter=e.target.value; render(); };
  $('searchInput').oninput=e=>{ keyword=e.target.value.trim(); render(); };
  $('ruleSel').onchange=()=>{ if(session&&compareResult){ toast('比对依据已切换，点击「绑定并比对」重新扫描'); } };
  $('srcBrowse').onclick=()=>openDirPicker('srcPath');
  $('tgtBrowse').onclick=()=>openDirPicker('tgtPath');
  $('bindBtn').onclick=bindAndCompare;
  $('sessionBtn').onclick=showSessions;
  $('themeBtn').onclick=()=>{
    const dark=document.documentElement.getAttribute('data-theme')==='dark';
    document.documentElement.setAttribute('data-theme',dark?'light':'dark');
    $('themeBtn').title=dark?'切换深色 / 浅色（当前浅色）':'切换深色 / 浅色（当前深色）';
  };
  $('dryBtn').onclick=showDryRun;
  $('legendBtn').onclick=()=>{
    const on=$('legend').classList.toggle('open');
    $('legendBtn').setAttribute('aria-expanded',on?'true':'false');
  };
  $('backupBtn').onclick=async()=>{ const p=await makePlan(); if(p) showConfirm(p); };
  $('reportBtn').onclick=async()=>{ try{ const path=await invoke('export_report',{}); toast('报告已保存：'+path); }catch(e){ toast(String(e)); } };
  $('cancelScanBtn').onclick=async()=>{ try{ await invoke('cancel_scan',{}); toast('已请求取消扫描'); }catch(e){} };
  $('rebindBtn').onclick=async()=>{
    if(!session) return;
    const p=prompt('请输入目标目录的新路径（例如移动硬盘盘符变化后的路径）：',$('tgtPath').value);
    if(!p) return;
    try{
      const r=await invoke('rebind_target',{sessionId:session.id,newTarget:p,force:false});
      if(r&&r.ok){ adoptSession(r.session); $('tgtPath').value=session.targetPath; toast(r.message); await doCompare(session.id); }
      else if(r&&confirm((r.message||'卷标识不匹配')+'\n\n是否仍要强制重新绑定为新卷？这会重建基线，且不会自动继承旧的冲突判定。')){
        const r2=await invoke('rebind_target',{sessionId:session.id,newTarget:p,force:true});
        if(r2&&r2.ok){ adoptSession(r2.session); $('tgtPath').value=session.targetPath; toast(r2.message); await doCompare(session.id); }
      }
    }catch(e){ toast('重绑失败：'+String(e)); }
  };
  $('modalClose').onclick=closeModal;
  $('modalClose').onkeydown=e=>{ if(e.key==='Enter'||e.key===' ') closeModal(); };
  $('overlay').onclick=e=>{ if(e.target.id==='overlay') closeModal(); };
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&$('overlay').classList.contains('show')) closeModal(); });

  // ---------- 自定义窗口控制（系统窗口条已关闭） ----------
  function appWindow(){
    const t=window.__TAURI__||{};
    try{
      if(t.window&&t.window.getCurrentWindow) return t.window.getCurrentWindow();
      if(t.webviewWindow&&t.webviewWindow.getCurrentWebviewWindow) return t.webviewWindow.getCurrentWebviewWindow();
    }catch(e){}
    return null;
  }
  function bindWindowControls(){
    const wrap=$('winControls');
    const w=appWindow();
    if(!w||!w.minimize){ if(wrap) wrap.classList.add('hidden'); return; }
    const on=(id,fn)=>{ const b=$(id); if(b) b.onclick=()=>{ Promise.resolve().then(()=>fn(w)).catch(()=>{}); }; };
    on('winMin', x=>x.minimize());
    on('winMax', x=>x.toggleMaximize());
    on('winClose', x=>x.close());
    const syncMax=async()=>{
      try{
        const max=await w.isMaximized();
        const b=$('winMax'); if(!b) return;
        b.classList.toggle('is-max', !!max);
        b.title=max?'还原':'最大化';
        b.setAttribute('aria-label',max?'还原':'最大化');
      }catch(e){}
    };
    syncMax();
    try{ if(w.onResized) w.onResized(()=>syncMax()); }catch(e){}
  }

  // ---------- 启动 ----------
  async function init(){
    bindWindowControls();
    if(IS_TAURI){
      $('modePill').textContent='未绑定目录';
      // 先注册进度监听，否则首次扫描（会话自动恢复）的进度事件会丢失。
      try{
        await listen('scan-progress',e=>{
          const d=e.payload||{};
          if(d.phase==='scanning'||d.phase==='scanning-target')
            $('scanText').textContent='正在扫描… 已扫描 '+(d.scanned||0)+' 个文件';
          else if(d.phase==='comparing') $('scanText').textContent='正在比对六态差异…';
        });
      }catch(e){}
      try{
        const drives=await invoke('list_drives',{});
        window.__EC_DRIVES__=drives||[];
      }catch(e){ window.__EC_DRIVES__=[]; }
      try{
        // 优先恢复上次实际使用的会话（而不是按键值排序取最旧的）。
        let s=null;
        try{ s=await invoke('active_session',{}); }catch(e){}
        if(!s){ const list=await invoke('list_sessions',{})||[]; s=list[0]||null; }
        if(s){
          adoptSession(s);
          $('srcPath').value=s.sourcePath; $('tgtPath').value=s.targetPath;
          $('modePill').textContent='已恢复会话';
          await doCompare(s.id);
        }
      }catch(e){}
    } else {
      window.__EC_DRIVES__=DEMO_DRIVES;
      $('modePill').textContent='演示数据';
      $('srcPath').value='D:\\工作文档\\';
      $('tgtPath').value='E:\\Backup\\工作文档\\';
      const res=await demo('compare',{});
      applyResult(res);
    }
    render();
  }
  init();
})();
