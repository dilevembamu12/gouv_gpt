// /assets/js/users-fallback.js
(function () {
  // Only activate if pki.js did NOT provide a usersManager with init()
  if (window.usersManager && typeof window.usersManager.init === 'function') return;

  function showToast(msg, type){
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
  }

  const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.api && window.APP_CONFIG.api.base) || '';
  const PKI = (window.APP_CONFIG && window.APP_CONFIG.api && window.APP_CONFIG.api.pki) || {};
  const USERS_API = PKI.users || '/api/pki/users';
  const ENTERPRISES_JSON = '/data/enterprises.json';
  const USERS_FALLBACK_JSON = '/data/users.json';

  const dom = {
    usersTableBody: document.getElementById('usersTableBody'),
    usersFilterInstitution: document.getElementById('usersFilterInstitution'),
    usersFilterRole: document.getElementById('usersFilterRole'),
    usersFilterCountry: document.getElementById('usersFilterCountry'),
    usersFilterSearch: document.getElementById('usersFilterSearch'),
    userInstitutionSelect: document.getElementById('userInstitutionSelect'),
    formCreateUser: document.getElementById('formCreateUser'),
    btnSubmitCreateUser: document.getElementById('btnSubmitCreateUser'),
  };

  const usersState = { enterprises: [], users: [] };

  async function fetchJSON(url){
    try{
      const r = await fetch(url, { cache:'no-store' });
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }catch(e){ return null; }
  }

  async function loadEnterprises(){
    const data = await fetchJSON(ENTERPRISES_JSON);
    const list = Array.isArray(data?.enterprises) ? data.enterprises : (Array.isArray(data)? data : []);
    usersState.enterprises = list;

    // Populate Filter
    if(dom.usersFilterInstitution){
      const keep=dom.usersFilterInstitution.value || 'all';
      dom.usersFilterInstitution.innerHTML = '<option value="all">Toutes</option>' +
        list.map(e=>`<option value="${String(e.id)}">${e.name}</option>`).join('');
      dom.usersFilterInstitution.value = keep;
    }
    // Populate Create Modal select
    if(dom.userInstitutionSelect){
      const keep=dom.userInstitutionSelect.value || '';
      dom.userInstitutionSelect.innerHTML = '<option value="">-- Sélectionner --</option>' +
        list.map(e=>`<option value="${String(e.id)}">${e.name}</option>`).join('');
      dom.userInstitutionSelect.value = keep;
    }
  }

  async function loadUsers(){
    // Try API first
    let data = await fetchJSON(`${API_BASE}${USERS_API}`);
    if(!data){
      // fallback to static
      data = await fetchJSON(USERS_FALLBACK_JSON);
    }
    const arr = Array.isArray(data?.users) ? data.users : (Array.isArray(data)? data : []);
    usersState.users = arr;
    renderUsers();
  }

  function resolveEnterpriseName(id){
    const e = usersState.enterprises.find(x=>String(x.id)===String(id));
    return e ? e.name : '—';
  }

  function filterUsers(u){
    const inst = dom.usersFilterInstitution?.value || 'all';
    const role = dom.usersFilterRole?.value || 'all';
    const ctry = dom.usersFilterCountry?.value || 'all';
    const q = (dom.usersFilterSearch?.value || '').toLowerCase();

    return u.filter(x=>{
      if(inst!=='all' && String(x.institutionId)!==String(inst)) return false;
      if(role!=='all' && String(x.role)!==String(role)) return false;
      if(ctry!=='all' && String(x.country)!==String(ctry)) return false;
      if(q){
        const hay = [
          x.firstName, x.lastName, x.email, x.phone,
          x.deviceMac, x.deviceModel, x.deviceSerial
        ].map(s=>(s||'').toString().toLowerCase());
        if(!hay.some(s=>s.includes(q))) return false;
      }
      return true;
    });
  }

  function renderUsers(){
    if(!dom.usersTableBody) return;
    const list = filterUsers(usersState.users);
    if(!list.length){
      dom.usersTableBody.innerHTML =
        '<tr><td colspan="8" class="text-center py-6 text-slate-500">Aucun utilisateur</td></tr>';
      return;
    }
    dom.usersTableBody.innerHTML = list.map(u=>{
      const full = `${u.firstName||''} ${u.lastName||''}`.trim();
      const inst = resolveEnterpriseName(u.institutionId);
      return `
        <tr class="hover-row">
          <td class="p-3">
            <div class="font-medium text-slate-800">${full||'—'}</div>
            <div class="text-sm text-slate-500">${u.email||'—'}</div>
          </td>
          <td class="p-3">${inst}</td>
          <td class="p-3">
            <div>${u.phone||'—'}</div>
            <div class="text-xs text-slate-500">${u.address||''}</div>
          </td>
          <td class="p-3">${u.deviceMac||'—'}</td>
          <td class="p-3">${u.country||'—'}</td>
          <td class="p-3 capitalize">${u.role||'—'}</td>
          <td class="p-3">
            <label class="switch" title="${u.active?'Désactiver':'Activer'}">
              <input type="checkbox" data-user-id="${u.id}" class="user-active-toggle" ${u.active?'checked':''}>
              <span class="slider"></span>
            </label>
          </td>
          <td class="p-3 text-center">
            <button class="btn-icon text-blue-600" title="Voir">
              <i class="fas fa-eye"></i>
            </button>
            <button class="btn-icon text-amber-600" title="Modifier">
              <i class="fas fa-edit"></i>
            </button>
            <button class="btn-icon text-red-600" title="Supprimer" data-action="delete-user" data-user-id="${u.id}">
              <i class="fas fa-trash"></i>
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  dom.usersFilterInstitution && dom.usersFilterInstitution.addEventListener('change', renderUsers);
  dom.usersFilterRole && dom.usersFilterRole.addEventListener('change', renderUsers);
  dom.usersFilterCountry && dom.usersFilterCountry.addEventListener('change', renderUsers);
  dom.usersFilterSearch && dom.usersFilterSearch.addEventListener('input', ()=>{ clearTimeout(window.__u_t); window.__u_t=setTimeout(renderUsers,200); });

  // Toggle active
  document.addEventListener('change', async (e)=>{
    const t = e.target;
    if(!t || !t.classList || !t.classList.contains('user-active-toggle')) return;
    const id = t.getAttribute('data-user-id');
    const active = !!t.checked;
    try{
      const r = await fetch(`${API_BASE}${USERS_API}/${encodeURIComponent(id)}`, {
        method:'PATCH',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ active })
      });
      if(!r.ok){
        let msg=`HTTP ${r.status}`;
        try{ const j=await r.json(); msg=j.error||j.message||msg; }catch(_){}
        throw new Error(msg);
      }
      showToast(`Utilisateur ${active?'activé':'désactivé'}`,'success');
      const u = usersState.users.find(x=>String(x.id)===String(id));
      if(u) u.active = active;
    }catch(err){
      showToast('Échec mise à jour : '+err.message,'error');
      // revert UI
      t.checked = !active;
    }
  });

  // Delete
  document.addEventListener('click', async (e)=>{
    const btn = e.target.closest && e.target.closest('[data-action="delete-user"]');
    if(!btn) return;
    const id = btn.getAttribute('data-user-id');
    if(!confirm('Supprimer cet utilisateur ?')) return;
    try{
      const r = await fetch(`${API_BASE}${USERS_API}/${encodeURIComponent(id)}`, { method:'DELETE' });
      if(!r.ok){
        let msg=`HTTP ${r.status}`;
        try{ const j=await r.json(); msg=j.error||j.message||msg; }catch(_){}
        throw new Error(msg);
      }
      usersState.users = usersState.users.filter(x=>String(x.id)!==String(id));
      renderUsers();
      showToast('Utilisateur supprimé','success');
    }catch(err){
      showToast('Échec suppression : '+err.message,'error');
    }
  });

  // Create user submit
  if(dom.formCreateUser){
    dom.formCreateUser.addEventListener('submit', async (e)=>{
      e.preventDefault();
      try{
        dom.btnSubmitCreateUser.disabled = true;
        dom.btnSubmitCreateUser.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enregistrement...';

        const fd = new FormData(dom.formCreateUser);
        const payload = {
          firstName: (fd.get('firstName')||'').trim(),
          lastName: (fd.get('lastName')||'').trim(),
          email: (fd.get('email')||'').trim(),
          phone: (fd.get('phone')||'').trim(),
          institutionId: fd.get('institutionId')||'',
          role: fd.get('role')||'officer',
          country: fd.get('country')||'CD',
          address: (fd.get('address')||'').trim(),
          deviceMac: (fd.get('deviceMac')||'').trim(),
          deviceModel: (fd.get('deviceModel')||'').trim(),
          deviceSerial: (fd.get('deviceSerial')||'').trim(),
          devicePlatform: (fd.get('devicePlatform')||'Windows'),
          active: !!fd.get('active'),
          createDeviceCert: !!fd.get('createDeviceCert'),
          certValidityDays: Number(fd.get('certValidityDays')||365)
        };

        if(!payload.institutionId){ showToast('Veuillez sélectionner une institution','error'); return; }

        const r = await fetch(`${API_BASE}${USERS_API}`, {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        });

        if(!r.ok){
          let msg=`HTTP ${r.status}`;
          try{ const j=await r.json(); msg=j.error||j.message||msg; }catch(_){}
          throw new Error(msg);
        }

        const j = await r.json().catch(()=> ({}));
        if(j && (j.id || (j.user && j.user.id))){
          usersState.users.unshift(j.user || j);
        }
        await loadUsers();
        // close modal if present
        const overlay = document.getElementById('modalCreateUser');
        if(overlay) overlay.classList.add('hidden');
        document.body.style.overflow = '';
        dom.formCreateUser.reset();
        showToast('Utilisateur enregistré','success');
      }catch(err){
        console.error(err);
        showToast('Échec enregistrement : '+err.message,'error');
      }finally{
        dom.btnSubmitCreateUser.disabled = false;
        dom.btnSubmitCreateUser.innerHTML = '<i class="fas fa-save"></i> Enregistrer';
      }
    });
  }

  // Initial load
  loadEnterprises().then(loadUsers);
})();
