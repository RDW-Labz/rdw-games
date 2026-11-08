// shelf bridge v3: own server /api -> Supabase (if configured) -> localStorage
(function(){
  const GAME = window.__gameId;
  const SUPA = window.__SUPA || (()=>{ try{ const v=localStorage.getItem('ib_supa'); return v?JSON.parse(v):null; }catch(e){ return null; } })();
  function saveSrv(data){
    fetch('/api/save?game='+GAME,{method:'POST',body:JSON.stringify(data),headers:{'Content-Type':'application/json'}})
      .then(r=>{ if(!r.ok) throw 0; })
      .catch(()=>{
        if(SUPA){ fetch(SUPA.url+'/rest/v1/ib_saves?game=eq.'+GAME,{method:'POST',headers:{'apikey':SUPA.key,'Content-Type':'application/json','Prefer':'resolution:merge'},body:JSON.stringify({game:GAME,data})}).catch(()=>{}); }
        try{ const s=JSON.parse(localStorage.getItem('ib_saves')||'{}'); s[GAME]=Object.assign(s[GAME]||{},data); localStorage.setItem('ib_saves',JSON.stringify(s)); }catch(e){}
      });
  }
  window.__save = saveSrv;
  function apply(ev){ ev.forEach(e=>{
    if(e.type==='key'){ const k=String(e.k).toLowerCase(); if(e.down) keys.add(k); else keys.delete(k); }
    else if(e.type==='look'){ padLook(e.dx||0,e.dy||0); }
    else if(e.type==='fire'){ padFire(e.down); }
    else if(e.type==='place'){ padPlace(e.down); }
    else if(e.type==='menu'){ padMenu(); }
  }); }
  window.__padInject = ev => apply([ev]);
  if(!/^https?:/.test(location.protocol)) return;
  let cursor = 0;
  function poll(){
    fetch('/api/input?sid=main&since='+cursor).then(r=>{ if(!r.ok) throw 0; return r.json(); }).then(d=>{
      cursor = d.n; apply(d.ev); setTimeout(poll,100);
    }).catch(()=>{
      if(SUPA){ fetch(SUPA.url+'/rest/v1/ib_input?order=seq.asc&seq=gt.'+cursor,{headers:{'apikey':SUPA.key}}).then(r=>r.json()).then(rows=>{
          rows.forEach(r=>{ apply([r.ev]); cursor=Math.max(cursor,r.seq); }); setTimeout(poll,250);
        }).catch(()=>setTimeout(poll,3000)); }
      else setTimeout(poll,5000);
    });
  }
  poll();
})();

