/* pki.js - FIntraX PKI Manager (FR)
 * 100% backend-driven: real HSM, real certificates, real signing & verification.
 *
 * Loads/saves users to:
 *  - Primary API: APP_CONFIG.api.pki.users
 *  - Fallback read: /data/users.json (public/data/users.json)
 *  - Persist writes (if available): APP_CONFIG.api.data.users or /api/data/users (server should write public/data/users.json)
 *
 * Loads enterprises (financial institutions) from:
 *  - Primary API: /api/pki/users/institutions
 *  - Fallback read: /data/enterprises.json (public/data/enterprises.json)
 *  - Persist writes (optional): APP_CONFIG.api.data.enterprises or /api/data/enterprises
 */

(function () {
  'use strict';

  // ---------------------------------
  // Configuration & helpers
  // ---------------------------------
  var APP = window.APP_CONFIG || {};
  var API = APP.api || {};
  var PKI = API.pki || API.endpoints || {};
  var PKCS11 = API.pkcs11 || {};
  var DATA = API.data || {}; // << optional section for flat-file save endpoints
  var API_BASE = (API.base || '');
  var TIMEOUT = API.timeout || 30000;
  var RETRIES = API.retryAttempts != null ? API.retryAttempts : 2;

  var MSG = window.ERROR_MESSAGES || {
    NETWORK_ERROR: 'Erreur de connexion au serveur. Verifiez votre connexion internet.',
    SERVER_ERROR: 'Erreur serveur. Veuillez reessayer plus tard.',
    HSM_DISCONNECTED: 'HSM deconnecte. Verifiez la connexion materielle.',
    INVALID_CERTIFICATE: 'Certificat invalide ou corrompu.',
    FILE_TOO_LARGE: 'Fichier trop volumineux. Taille maximale : 10 Mo.',
    UNSUPPORTED_FILE_TYPE: 'Type de fichier non supporte.'
  };

  // JSON flat-file locations & save endpoints
  var JSON_DATA = {
    usersFile: withBase('/data/users.json'),                // GET fallback reader  public/data/users.json
    enterprisesFile: withBase('/data/enterprises.json'),    // GET fallback reader  public/data/enterprises.json
    usersSave: withBase(DATA.users || '/api/data/users'),   // PUT {users: [...] }  server writes public/data/users.json
    enterprisesSave: withBase(DATA.enterprises || '/api/data/enterprises') // PUT {enterprises: [...]}
  };

  function toast(msg, type) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg, type || 'info');
    } else {
      console[type === 'error' ? 'error' : 'log'](msg);
    }
  }

  function withBase(path) {
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    return API_BASE + path;
  }

  function http(url, options, cfg) {
    options = options || {};
    cfg = cfg || {};
    var retries = cfg.retries != null ? cfg.retries : RETRIES;
    var timeout = cfg.timeout != null ? cfg.timeout : TIMEOUT;

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeout);

    var headers = Object.assign({}, options.headers || {});
    var isFormData = (options.body && typeof FormData !== 'undefined' && options.body instanceof FormData);
    if (!isFormData && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

    // Force no-cache for GETs
    if (!headers['Cache-Control']) headers['Cache-Control'] = 'no-cache';
    if (!headers['Pragma']) headers['Pragma'] = 'no-cache';

    var final = {
      method: options.method || 'GET',
      headers: headers,
      body: options.body,
      signal: ctrl.signal,
      cache: options.cache || 'no-store',
      credentials: options.credentials || 'same-origin'
    };

    return fetch(url, final)
      .then(function (res) {
        clearTimeout(timer);
        var ct = res.headers.get('content-type') || '';
        var isJSON = ct.indexOf('application/json') !== -1;
        if (!isJSON) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.text();
        }
        return res.json().then(function (body) {
          if (!res.ok) {
            var err = new Error((body && (body.error || body.message)) || ('HTTP ' + res.status));
            err.status = res.status;
            err.body = body;
            throw err;
          }
          return body;
        });
      })
      .catch(function (err) {
        clearTimeout(timer);
        var retriable = err.name === 'AbortError' || /Failed to fetch|network.*request/i.test(err.message || '');
        if (retriable && retries > 0) {
          return new Promise(function (r) { setTimeout(r, 300); })
            .then(function () { return http(url, options, { retries: retries - 1, timeout: timeout }); });
        }
        throw err;
      });
  }

  function fmtDate(iso, style) {
    if (!iso) return '--';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '--';
    if (style === 'short') {
      return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
    }
    return d.toLocaleDateString('fr-FR', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  function joursAvant(iso) {
    if (!iso) return 0;
    var e = new Date(iso).getTime();
    var now = Date.now();
    var diff = Math.ceil((e - now) / 86400000);
    return diff > 0 ? diff : 0;
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function debounce(fn, wait) {
    var t;
    wait = wait || 300;
    return function () {
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(null, args); }, wait);
    };
  }

  // ---------------------------------
  // App state
  // ---------------------------------
  var state = {
    onglet: 'dashboard',
    hsm: { connecte: false, carte: false, dernier: null, brut: '' },
    certificats: [],
    signatures: [],
    users: [],
    institutions: []
  };
  window.appState = state;

  // ---------------------------------
  // Helpers for JSON store (flat files)
  // ---------------------------------
  function loadUsersFromJsonFile() {
    return http(JSON_DATA.usersFile, { method: 'GET' })
      .then(function (data) {
        return Array.isArray(data?.users) ? data.users
             : Array.isArray(data) ? data : [];
      });
  }

  function saveUsersToJsonFile(users) {
    // Server endpoint should write to public/data/users.json
    return http(JSON_DATA.usersSave, { method: 'PUT', body: JSON.stringify({ users: users || [] }) })
      .catch(function (e) {
        // Non-fatal if missing: keep UI functional, just notify once.
        console.warn('Could not save users.json:', e?.message || e);
        toast('Endpoint de sauvegarde des utilisateurs manquant (/' + JSON_DATA.usersSave.split('/').slice(-2).join('/') + '). Ajoutez /api/data/users côté serveur.', 'warning');
      });
  }

  function loadEnterprisesFromJsonFile() {
    return http(JSON_DATA.enterprisesFile, { method: 'GET' })
      .then(function (data) {
        return Array.isArray(data?.enterprises) ? data.enterprises
             : Array.isArray(data) ? data : [];
      });
  }

  function saveEnterprisesToJsonFile(enterprises) {
    return http(JSON_DATA.enterprisesSave, { method: 'PUT', body: JSON.stringify({ enterprises: enterprises || [] }) })
      .catch(function (e) {
        console.warn('Could not save enterprises.json:', e?.message || e);
        toast('Endpoint de sauvegarde des entreprises manquant. Ajoutez /api/data/enterprises côté serveur.', 'warning');
      });
  }

  // ---------------------------------
  // HSM (PKCS#11)
  // ---------------------------------
  function rafraichirStatutHSM() {
    var ind = {
      point: document.getElementById('hsmStatusIndicator'),
      titre: document.getElementById('hsmStatusText'),
      detail: document.getElementById('hsmStatusDetail'),
      bloc: document.getElementById('hsmStatus'),
      blocDetail: document.getElementById('hsmDetails')
    };

    if (ind.bloc) ind.bloc.textContent = 'Verification...';
    if (ind.blocDetail) ind.blocDetail.textContent = 'Interrogation du HSM...';

    var pkiEndpoint = PKI.hsmStatus ? withBase(PKI.hsmStatus) : null;
    var pkcs11Endpoint = withBase(PKCS11.status || '/api/pkcs11/sc-hsm-status');

    function applyFromPKI(data) {
      var status = (data && data.status) || '';
      var connected = !!(data.connected || data.isConnected || status === 'connected' || status === 'ok' || data.ok === true);
      var cardPresent = !!(data.cardPresent || data.isCardPresent || data.cardStatus === 'present' || data.tokenPresent);
      state.hsm.connecte = connected;
      state.hsm.carte = cardPresent;
      state.hsm.dernier = new Date().toISOString();
      appliquerHSMUI(ind, connected, cardPresent, false);
    }

    function parsePkcs11Detail(raw) {
      if (!raw) return '';
      var lines = String(raw).split(/\r?\n/);
      var nice = lines.find(function (l) { return /SC-?HSM.*(OK|status)/i.test(l); }) ||
                 lines.find(function (l) { return /token label\s*:/i.test(l); });
      if (nice) return nice.trim();
      var first = lines.find(function (l) { return l.trim().length > 0; });
      return first ? first.trim() : '';
    }

    function fetchPkcs11Detail() {
      return http(pkcs11Endpoint, { method: 'GET' })
        .then(function (data) {
          var txt = (data && data.stdout) ? data.stdout : (typeof data === 'string' ? data : '');
          state.hsm.brut = txt;
          state.hsm.dernier = new Date().toISOString();
          var detailLine = parsePkcs11Detail(txt);
          if (detailLine) {
            if (ind.detail) ind.detail.textContent = detailLine;
            if (ind.blocDetail) ind.blocDetail.textContent = detailLine;
          }
          return txt;
        })
        .catch(function () { /* silent */ });
    }

    function fallBackToPkcs11() {
      http(pkcs11Endpoint, { method: 'GET' })
        .then(function (data) {
          var txt = (data && data.stdout) ? data.stdout : (typeof data === 'string' ? data : '');
          state.hsm.brut = txt;
          state.hsm.dernier = new Date().toISOString();
          var connecte = /SC-?HSM|Token|Serial number:/i.test(txt) || data.ok === true;
          var carte = /token label|Card state|PIN tries remaining|DF01|present|slots:\s*\d+/i.test(txt) || connecte;
          appliquerHSMUI(ind, connecte, carte, false);
          var detailLine = parsePkcs11Detail(txt);
          if (detailLine) {
            if (ind.detail) ind.detail.textContent = detailLine;
            if (ind.blocDetail) ind.blocDetail.textContent = detailLine;
          }
        })
        .catch(function () {
          appliquerHSMUI(ind, false, false, true);
        });
    }

    if (pkiEndpoint) {
      http(pkiEndpoint, { method: 'GET' })
        .then(function (data) { applyFromPKI(data || {}); })
        .catch(function () { /* fall back still runs below */ })
        .finally(fetchPkcs11Detail);
    } else {
      fallBackToPkcs11();
    }
  }

  function appliquerHSMUI(ind, connecte, carte, echec) {
    function setPoint(cls) {
      if (ind.point) ind.point.className = 'w-3 h-3 rounded-full ' + cls;
    }
    if (echec) {
      setPoint('bg-red-500');
      if (ind.titre) ind.titre.textContent = 'Erreur';
      if (ind.detail) ind.detail.textContent = 'API indisponible';
      if (ind.bloc) ind.bloc.textContent = 'Erreur';
      if (ind.blocDetail) ind.blocDetail.textContent = 'Impossible de recuperer le statut';
      return;
    }
    if (connecte && carte) {
      setPoint('bg-green-500');
      if (ind.titre) ind.titre.textContent = 'Connecte';
      if (ind.detail && !ind.detail.textContent) ind.detail.textContent = 'Pret pour les operations';
      if (ind.bloc) ind.bloc.textContent = 'Actif';
      if (ind.blocDetail && !ind.blocDetail.textContent) ind.blocDetail.textContent = 'Carte detectee';
    } else if (connecte) {
      setPoint('bg-amber-500');
      if (ind.titre) ind.titre.textContent = 'En attente';
      if (ind.detail && !ind.detail.textContent) ind.detail.textContent = 'Inserez une carte';
      if (ind.bloc) ind.bloc.textContent = 'En attente';
      if (ind.blocDetail && !ind.blocDetail.textContent) ind.blocDetail.textContent = 'Carte requise';
    } else {
      setPoint('bg-red-500');
      if (ind.titre) ind.titre.textContent = 'Deconnecte';
      if (ind.detail && !ind.detail.textContent) ind.detail.textContent = 'Aucun lecteur detecte';
      if (ind.bloc) ind.bloc.textContent = 'Inactif';
      if (ind.blocDetail && !ind.blocDetail.textContent) ind.blocDetail.textContent = 'Verifiez la connexion';
    }
  }

  // ---------------------------------
  // Dashboard (unchanged)
  // ---------------------------------
  function rafraichirDashboard() {
    var el = {
      actifs: document.getElementById('activeCertsCount'),
      expTxt: document.getElementById('certExpiryStats'),
      sigCount: document.getElementById('signaturesCount'),
      sigTrend: document.getElementById('signaturesTrend'),
      tsCount: document.getElementById('timestampsCount'),
      tsTrend: document.getElementById('timestampsTrend'),
      activite: document.getElementById('recentActivity'),
      expBody: document.getElementById('expiringCertsBody')
    };

    if (el.expBody) {
      el.expBody.innerHTML =
        '<tr><td colspan="3" class="text-center py-6 text-slate-400">' +
        '<i class="fas fa-spinner spinner"></i> Chargement...' +
        '</td></tr>';
    }
    if (el.activite) {
      el.activite.innerHTML =
        '<div class="loading-state">' +
        '<i class="fas fa-spinner spinner"></i> Chargement des activites...' +
        '</div>';
    }

    var endpoint = withBase(PKI.dashboardStats || PKI.dashboard || '/api/pki/dashboard/stats');
    http(endpoint, { method: 'GET' })
      .then(function (stats) {
        var actifs = Number(stats.activeCertificates || 0);
        var expirant = Number(stats.expiringSoon || 0);
        var sigMois = Number(stats.signaturesThisMonth || 0);
        var sigJour = Number(stats.signaturesToday || 0);
        var ts = Number(stats.timestampsCount || 0);

        if (el.actifs) el.actifs.textContent = String(actifs);
        if (el.expTxt) el.expTxt.textContent = expirant + ' expirent bientot';
        if (el.sigCount) el.sigCount.textContent = String(sigMois);
        if (el.sigTrend) el.sigTrend.textContent = sigJour + ' aujourd\'hui';
        if (el.tsCount) el.tsCount.textContent = String(ts);
        if (el.tsTrend) el.tsTrend.textContent = Math.floor(ts / 30) + ' cette semaine';

        var expList = Array.isArray(stats.expiringCertificates) ? stats.expiringCertificates : null;

        function renderExp(list) {
          if (el.expBody) {
            if (!list || list.length === 0) {
              el.expBody.innerHTML =
                '<tr><td colspan="3" class="text-center py-6 text-slate-500">' +
                '<i class="fas fa-check-circle text-green-500 mr-2"></i> Aucun certificat n\'expire bientot' +
                '</td></tr>';
            } else {
              el.expBody.innerHTML = list.slice(0, 8).map(function (c) {
                var j = joursAvant(c.expires);
                var cls = j <= 7 ? 'text-red-600' : (j <= 30 ? 'text-amber-600' : 'text-green-600');
                return '' +
                  '<tr class="hover:bg-slate-50">' +
                  '<td class="p-3">' + esc(extraireCN(c.subject)) + '</td>' +
                  '<td class="p-3">' + fmtDate(c.expires, 'short') + '</td>' +
                  '<td class="p-3 text-right font-medium ' + cls + '">' + j + ' jours</td>' +
                  '</tr>';
              }).join('');
            }
          }
        }

        if (expList) {
          renderExp(expList);
        } else {
          var certUrl = withBase(PKI.certificates || '/api/pki/certificates');
          http(certUrl, { method: 'GET' })
            .then(function (data) {
              var all = Array.isArray(data.certificates) ? data.certificates : (Array.isArray(data) ? data : []);
              var soon = all
                .filter(function (c) {
                  var t = new Date(c.expires).getTime() - Date.now();
                  var d = Math.ceil(t / 86400000);
                  return d > 0 && d <= 30;
                })
                .sort(function (a, b) { return new Date(a.expires) - new Date(b.expires); });
              renderExp(soon);
            })
            .catch(function () { renderExp([]); });
        }

        if (el.activite) {
          http(withBase(PKI.audit || '/api/pki/audit'), { method: 'GET' })
            .then(function (audit) {
              var events = Array.isArray(audit.events) ? audit.events : [];
              if (!events.length) {
                el.activite.innerHTML = '<div class="text-slate-500 text-sm">Aucune activite recente</div>';
              } else {
                el.activite.innerHTML = events.slice(0, 20).map(function (a) {
                  var ts = a.timestamp || a.ts || a.date || new Date().toISOString();
                  var actor = a.actor || a.user || 'Systeme';
                  var action = a.action || a.type || '';
                  var subject = a.subject || a.file || a.serial || '';
                  var details = a.details ? (' - ' + esc(a.details)) : (subject ? (' - ' + esc(subject)) : '');
                  return '' +
                    '<div class="log-entry">' +
                    '<span class="log-time">[' + fmtDate(ts, 'short') + ']</span>' +
                    '<span class="log-info ml-1">' + esc(actor) + '</span>' +
                    '<span class="ml-1">-></span>' +
                    '<span class="ml-1">' + esc(action) + '</span>' +
                    '<span class="ml-1 text-slate-500">' + details + '</span>' +
                    '</div>';
                }).join('');
              }
            })
            .catch(function () {
              el.activite.innerHTML =
                '<div class="text-amber-600 text-sm">' +
                '<i class="fas fa-plug mr-1"></i> Journal indisponible.' +
                '</div>';
            });
        }
      })
      .catch(function (e) {
        if (e && e.status === 501) {
          if (el.actifs) el.actifs.textContent = '0';
          if (el.expTxt) el.expTxt.textContent = '0 expirent bientot';
          if (el.sigCount) el.sigCount.textContent = '0';
          if (el.sigTrend) el.sigTrend.textContent = '0 aujourd\'hui';
          if (el.tsCount) el.tsCount.textContent = '0';
          if (el.tsTrend) el.tsTrend.textContent = '0 cette semaine';
          if (el.activite) {
            el.activite.innerHTML =
              '<div class="text-amber-600 text-sm">' +
              '<i class="fas fa-plug mr-1"></i> Statistiques indisponibles (501). Connectez votre service PKI.' +
              '</div>';
          }
          if (el.expBody) {
            el.expBody.innerHTML =
              '<tr><td colspan="3" class="text-center py-6 text-amber-600">' +
              '<i class="fas fa-plug mr-1"></i> Liste des expirations indisponible (501).' +
              '</td></tr>';
          }
        } else {
          toast(MSG.SERVER_ERROR, 'error');
        }
      });
  }

  // ---------------------------------
  // Certificates (unchanged logic)
  // ---------------------------------
  function extraireCN(subject) {
    if (!subject || typeof subject !== 'string') return 'N/A';
    var m = subject.match(/CN=([^,]+)/i);
    return (m ? m[1] : subject.split(',')[0] || 'N/A').trim();
  }

  function badgeType(type) {
    var map = window.CERTIFICATE_TYPES || {};
    var cfg = map[type] || { label: type || '-', color: 'gray' };
    return '<span class="badge bg-' + cfg.color + '-100 text-' + cfg.color + '-800">' + esc(cfg.label) + '</span>';
  }

  function badgeStatut(st) {
    var map = window.CERTIFICATE_STATUS || {};
    var cfg = map[st] || { label: st || '-', color: 'gray', icon: 'fa-question' };
    return '<span class="badge bg-' + cfg.color + '-100 text-' + cfg.color + '-800"><i class="fas ' + cfg.icon + '"></i> ' + esc(cfg.label) + '</span>';
  }

  function majListesCert(liste) {
    var cibles = [
      document.getElementById('certToRevoke'),
      document.getElementById('signingCertSelect'),
      document.getElementById('tsaCert')
    ];
    cibles.forEach(function (sel) {
      if (!sel) return;
      var keep = sel.value;
      sel.innerHTML = '<option value="">-- Selectionner un certificat --</option>';
      (liste || []).forEach(function (c) {
        if ((c.status || '').toLowerCase() === 'valid') {
          var o = document.createElement('option');
          o.value = c.id;
          o.textContent = extraireCN(c.subject) + ' (' + (c.serial || 'N/A') + ')';
          sel.appendChild(o);
        }
      });
      var hasKeep = false;
      var opts = Array.prototype.slice.call(sel.options);
      for (var i = 0; i < opts.length; i++) {
        if (opts[i].value === keep) { hasKeep = true; break; }
      }
      if (keep && hasKeep) sel.value = keep;
    });
  }

  function GestionCertificats() {
    this.endpoints = {
      list: withBase(PKI.certificates || '/api/pki/certificates'),
      gen: withBase(PKI.generateCertificate || '/api/pki/certificates/generate'),
      revokeBase: withBase(PKI.revokeCertificate || '/api/pki/certificates')
    };
    this.tbody = document.getElementById('certificatesTableBody');
  }

  GestionCertificats.prototype.loadingUI = function () {
    if (!this.tbody) return;
    this.tbody.innerHTML =
      '<tr><td colspan="6" class="text-center p-6 text-slate-400">' +
      '<i class="fas fa-spinner spinner mr-2"></i> Chargement des certificats...' +
      '</td></tr>';
  };

  GestionCertificats.prototype.videUI = function (msg) {
    msg = msg || 'Aucun certificat trouve';
    if (!this.tbody) return;
    this.tbody.innerHTML =
      '<tr><td colspan="6" class="text-center p-8 text-slate-400">' +
      '<i class="fas fa-certificate text-4xl mb-3 opacity-50"></i>' +
      '<p class="font-medium">' + esc(msg) + '</p>' +
      '<p class="text-sm mt-1">Aucun certificat ne correspond aux filtres</p>' +
      '<button class="btn btn-primary mt-4" id="btnResetCertFilters">' +
      '<i class="fas fa-refresh mr-2"></i> Reinitialiser les filtres</button>' +
      '</td></tr>';
    var btn = document.getElementById('btnResetCertFilters');
    if (btn) {
      btn.addEventListener('click', function () {
        var s1 = document.getElementById('certFilterStatus');
        var s2 = document.getElementById('certFilterType');
        var s3 = document.getElementById('certSearch');
        if (s1) s1.value = 'all';
        if (s2) s2.value = 'all';
        if (s3) s3.value = '';
        window.certManager.recharger();
      });
    }
  };

  GestionCertificats.prototype.erreurUI = function (msg) {
    if (!this.tbody) return;
    this.tbody.innerHTML =
      '<tr><td colspan="6" class="text-center p-6 text-red-500">' +
      '<div class="flex flex-col items-center gap-2">' +
      '<i class="fas fa-exclamation-triangle text-2xl"></i>' +
      '<div class="font-semibold">' + esc(msg) + '</div>' +
      '<button class="btn btn-secondary mt-2" id="btnRetryLoadCerts">' +
      '<i class="fas fa-refresh mr-2"></i> Reessayer</button>' +
      '</div></td></tr>';
    var btn = document.getElementById('btnRetryLoadCerts');
    if (btn) btn.addEventListener('click', function () { window.certManager.recharger(); });
  };

  GestionCertificats.prototype.filtrerLocal = function (liste) {
    var statutEl = document.getElementById('certFilterStatus');
    var typeEl = document.getElementById('certFilterType');
    var searchEl = document.getElementById('certSearch');

    var statut = statutEl ? statutEl.value : 'all';
    var type = typeEl ? typeEl.value : 'all';
    var q = searchEl ? String(searchEl.value).toLowerCase() : '';

    return (liste || []).filter(function (c) {
      if (statut !== 'all' && c.status !== statut) return false;
      if (type !== 'all' && c.type !== type) return false;
      if (q) {
        var arr = [
          (c.subject || '').toLowerCase(),
          (c.issuer || '').toLowerCase(),
          (c.serial || c.serialNumber || '').toLowerCase(),
          (c.email || '').toLowerCase()
        ];
        var match = false;
        for (var i = 0; i < arr.length; i++) {
          if (arr[i].indexOf(q) !== -1) { match = true; break; }
        }
        if (!match) return false;
      }
      return true;
    });
  };

  GestionCertificats.prototype.rendre = function (liste) {
    if (!this.tbody) return;
    if (!liste || liste.length === 0) {
      this.videUI();
      return;
    }
    this.tbody.innerHTML = liste.map(function (c) {
      var cnSub = extraireCN(c.subject);
      var cnIss = extraireCN(c.issuer);
      var j = joursAvant(c.expires);
      return '' +
        '<tr class="hover-row cert-status-' + esc(c.status) + '">' +
        '<td class="p-4">' +
        '<div class="font-medium text-slate-800">' + esc(cnSub) + '</div>' +
        '<div class="text-sm text-slate-500">S/N : ' + esc(c.serial || c.serialNumber || '') + '</div>' +
        '</td>' +
        '<td class="p-4 text-slate-600">' + esc(cnIss) + '</td>' +
        '<td class="p-4">' +
        '<div class="text-slate-600">' + fmtDate(c.expires) + '</div>' +
        '<div class="text-xs text-slate-400">' + j + ' jours</div>' +
        '</td>' +
        '<td class="p-4">' + badgeType(c.type) + '</td>' +
        '<td class="p-4">' + badgeStatut(c.status) + '</td>' +
        '<td class="p-4 text-center">' +
        '<div class="flex justify-center gap-2">' +
        '<button class="btn-icon text-blue-600 view-cert" data-id="' + esc(c.id) + '" title="Voir les details">' +
        '<i class="fas fa-eye"></i></button>' +
        '<button class="btn-icon text-green-600 download-cert" data-id="' + esc(c.id) + '" title="Telecharger">' +
        '<i class="fas fa-download"></i></button>' +
        (String(c.status).toLowerCase() === 'valid'
          ? '<button class="btn-icon text-amber-600 revoke-cert" data-id="' + esc(c.id) + '" title="Revoquer">' +
            '<i class="fas fa-ban"></i></button>'
          : '') +
        '</div>' +
        '</td>' +
        '</tr>';
    }).join('');
  };

  GestionCertificats.prototype.recharger = function () {
    this.loadingUI();
    var self = this;

    var p = new URLSearchParams();
    var sEl = document.getElementById('certFilterStatus');
    var tEl = document.getElementById('certFilterType');
    var qEl = document.getElementById('certSearch');

    var s = sEl ? sEl.value : '';
    var t = tEl ? tEl.value : '';
    var q = qEl ? qEl.value : '';

    if (s && s !== 'all') p.set('status', s);
    if (t && t !== 'all') p.set('type', t);
    if (q) p.set('search', q);

    var url = this.endpoints.list + (p.toString() ? ('?' + p) : '');

    http(url, { method: 'GET' })
      .then(function (data) {
        var liste = Array.isArray(data.certificates) ? data.certificates : (Array.isArray(data) ? data : []);
        state.certificats = liste;
        self.rendre(self.filtrerLocal(liste));
        majListesCert(liste);
      })
      .catch(function (e) {
        if (e && e.status === 501) self.videUI('Service certificats indisponible (501).');
        else self.erreurUI((e && e.message) ? e.message : MSG.SERVER_ERROR);
      });
  };

  GestionCertificats.prototype.lierUI = function () {
    var self = this;
    var selStatus = document.getElementById('certFilterStatus');
    var selType = document.getElementById('certFilterType');
    var inputSearch = document.getElementById('certSearch');

    if (selStatus) selStatus.addEventListener('change', function () { self.recharger(); });
    if (selType) selType.addEventListener('change', function () { self.recharger(); });
    if (inputSearch) inputSearch.addEventListener('input', debounce(function () { self.recharger(); }, 250));

    document.addEventListener('click', function (e) {
      var targetView = e.target.closest ? e.target.closest('.view-cert') : null;
      var targetDl = e.target.closest ? e.target.closest('.download-cert') : null;
      var targetRv = e.target.closest ? e.target.closest('.revoke-cert') : null;

      if (targetView) { self.voir(targetView.getAttribute('data-id')); }
      if (targetDl) { self.telecharger(targetDl.getAttribute('data-id')); }
      if (targetRv) { self.revoquer(targetRv.getAttribute('data-id')); }
    });
  };

  GestionCertificats.prototype.voir = function (id) {
    var c = (state.certificats || []).find(function (x) { return String(x.id) === String(id); });
    if (!c) { toast('Certificat introuvable', 'error'); return; }

    var html = ''
      + '<div class="p-6">'
      +   '<h2 class="text-lg font-semibold mb-4">Détails du certificat</h2>'
      +   '<div class="space-y-2 text-sm">'
      +     '<div><strong>Sujet:</strong> ' + esc(c.subject || '-') + '</div>'
      +     '<div><strong>Émetteur:</strong> ' + esc(c.issuer || '-') + '</div>'
      +     '<div><strong>Série:</strong> ' + esc(c.serial || c.serialNumber || '-') + '</div>'
      +     '<div><strong>Type:</strong> ' + esc(c.type || '-') + '</div>'
      +     '<div><strong>Statut:</strong> ' + esc(c.status || '-') + '</div>'
      +     '<div><strong>Valide du:</strong> ' + fmtDate(c.notBefore || c.validFrom) + '</div>'
      +     '<div><strong>Expire le:</strong> ' + fmtDate(c.expires || c.notAfter) + '</div>'
      +   '</div>'
      +   '<div class="mt-4 flex justify-end gap-2">'
      +     '<button class="btn btn-secondary" id="btnCloseCertModal">Fermer</button>'
      +     '<button class="btn btn-primary" id="btnDlCertModal">Télécharger</button>'
      +   '</div>'
      + '</div>';

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50';
    overlay.innerHTML = '<div class="bg-white rounded-lg shadow-xl w-full max-w-lg">' + html + '</div>';
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        overlay.remove();
        document.body.style.overflow = '';
      }
    });
    overlay.querySelector('#btnCloseCertModal').addEventListener('click', function () {
      overlay.remove();
      document.body.style.overflow = '';
    });
    overlay.querySelector('#btnDlCertModal').addEventListener('click', function () {
      // FIX: align with backend route
      var url = API_BASE + '/downloads/certificates/' + encodeURIComponent(c.id);
      window.open(url, '_blank');
    });
  };

  GestionCertificats.prototype.telecharger = function (id) {
    // FIX: align with backend route
    var url = API_BASE + '/downloads/certificates/' + encodeURIComponent(id);
    fetch(url, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.blob();
      })
      .then(function (blob) {
        var a = document.createElement('a');
        var cert = (state.certificats || []).find(function (c) { return String(c.id) === String(id); });
        a.href = URL.createObjectURL(blob);
        a.download = cert ? ('certificate-' + (cert.serial || cert.id) + '.pem') : ('certificate-' + id + '.pem');
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 250);
        toast('Certificat telecharge avec succes', 'success');
      })
      .catch(function (e) {
        toast('Echec du telechargement : ' + e.message, 'error');
      });
  };

  GestionCertificats.prototype.revoquer = function (id) {
    var ok = window.confirm('Confirmer la revocation ? Cette action est irréversible.');
    if (!ok) return;

    var url = (PKI.revokeCertificate
      ? withBase(PKI.revokeCertificate.replace('{id}', encodeURIComponent(id)))
      : (this.endpoints.revokeBase + '/' + encodeURIComponent(id) + '/revoke'));

    http(url, { method: 'POST', body: JSON.stringify({ reason: (document.getElementById('revocationReason')?.value || 'unspecified') }) })
      .then(function () {
        toast('Certificat revoqué', 'success');
        window.certManager.recharger();
      })
      .catch(function (e) {
        if (e && e.status === 501) toast('Revocation indisponible (501).', 'error');
        else toast('Revocation echouée : ' + ((e && e.message) ? e.message : 'inconnue'), 'error');
      });
  };

  // ---------------------------------
  // Users (enhanced with JSON persistence)
  // ---------------------------------
  function UsersManager() {
    this.endpoints = {
      list: withBase(PKI.users || '/api/pki/users'),
      institutions: withBase('/api/pki/users/institutions'),
      updateUser: function (id) { return withBase((PKI.users || '/api/pki/users') + '/' + encodeURIComponent(id)); },
      create: withBase(PKI.users || '/api/pki/users'),
      genCert: withBase(PKI.generateCertificate || '/api/pki/certificates/generate')
    };
    this.tbody = document.getElementById('usersTableBody');
    this.filters = {
      institution: document.getElementById('usersFilterInstitution'),
      role: document.getElementById('usersFilterRole'),
      country: document.getElementById('usersFilterCountry'),
      search: document.getElementById('usersFilterSearch')
    };
    this.createForm = document.getElementById('formCreateUser');
    this.instSelectInModal = document.getElementById('userInstitutionSelect');
  }

  UsersManager.prototype.loadingUI = function () {
    if (!this.tbody) return;
    this.tbody.innerHTML =
      '<tr><td colspan="8" class="text-center py-6 text-slate-400">' +
      '<i class="fas fa-spinner spinner"></i> Chargement des utilisateurs...' +
      '</td></tr>';
  };

  UsersManager.prototype.emptyUI = function () {
    if (!this.tbody) return;
    this.tbody.innerHTML =
      '<tr><td colspan="8" class="text-center p-8 text-slate-500">' +
      '<i class="fas fa-users text-4xl mb-2 opacity-50"></i>' +
      '<div class="font-medium">Aucun utilisateur</div>' +
      '</td></tr>';
  };

  UsersManager.prototype.errorUI = function (msg) {
    if (!this.tbody) return;
    this.tbody.innerHTML =
      '<tr><td colspan="8" class="text-center p-8 text-red-600">' + esc(msg || 'Erreur inconnue') + '</td></tr>';
  };

  UsersManager.prototype.fetchInstitutions = function () {
    var self = this;

    // Try dedicated endpoint; if missing, fallback to JSON file
    return http(this.endpoints.institutions, { method: 'GET' })
      .then(function (data) {
        var list = Array.isArray(data?.institutions) ? data.institutions
                 : Array.isArray(data) ? data : [];
        state.institutions = list;
        self.renderInstitutionOptions();
      })
      .catch(function () {
        // fallback
        return loadEnterprisesFromJsonFile()
          .then(function (list) {
            state.institutions = list || [];
            self.renderInstitutionOptions();
          })
          .catch(function () {/* ignore */});
      });
  };

  UsersManager.prototype.renderInstitutionOptions = function () {
    var filterSel = this.filters.institution;
    var modalSel = this.instSelectInModal;
    var list = state.institutions || [];

    if (filterSel) {
      var keep = filterSel.value;
      filterSel.innerHTML = '<option value="all">Toutes</option>';
      list.forEach(function (inst) {
        var o = document.createElement('option');
        o.value = inst.id || inst.code || inst.name || inst;
        o.textContent = inst.name || inst.label || inst;
        filterSel.appendChild(o);
      });
      if (keep) filterSel.value = keep;
    }

    if (modalSel && modalSel.children.length <= 1) {
      list.forEach(function (inst) {
        var o = document.createElement('option');
        o.value = inst.id || inst.code || inst.name || inst;
        o.textContent = inst.name || inst.label || inst;
        modalSel.appendChild(o);
      });
    }
  };

  UsersManager.prototype.deduceInstitutionsFromUsers = function (users) {
    if (!Array.isArray(users)) return;
    if (state.institutions && state.institutions.length) return;
    var map = {};
    users.forEach(function (u) {
      var inst = u.institution || u.institutionName || u.bank || u.customer || u.company;
      var id = (u.institutionId || u.institutionCode || (inst && (inst.id || inst.code))) || (inst && inst);
      var name = (inst && (inst.name || inst.label)) || inst || u.institutionName;
      if (!id || !name) return;
      map[String(id)] = { id: id, name: name };
    });
    var arr = Object.keys(map).map(function (k) { return map[k]; });
    if (arr.length) {
      state.institutions = arr;
      this.renderInstitutionOptions();
      // Optional: persist inferred enterprises (comment out if you don't want this behavior)
      // saveEnterprisesToJsonFile(arr);
    }
  };

  UsersManager.prototype.filterLocal = function (list) {
    var f = this.filters;
    var inst = f.institution ? f.institution.value : 'all';
    var role = f.role ? f.role.value : 'all';
    var ctry = f.country ? f.country.value : 'all';
    var q = f.search ? String(f.search.value).toLowerCase() : '';

    return (list || []).filter(function (u) {
      if (inst !== 'all') {
        var uid = u.institutionId || u.institutionCode || (u.institution && (u.institution.id || u.institution.code)) || u.institution || '';
        if (String(uid) !== String(inst)) return false;
      }
      if (role !== 'all' && String(u.role || '').toLowerCase() !== String(role)) return false;
      if (ctry !== 'all' && String(u.country || '').toUpperCase() !== String(ctry)) return false;
      if (q) {
        var pool = [
          (u.firstName || '').toLowerCase(),
          (u.lastName || '').toLowerCase(),
          (u.email || '').toLowerCase(),
          (u.phone || '').toLowerCase(),
          ((u.device && u.device.mac) || u.deviceMac || '').toLowerCase()
        ].join(' ');
        if (pool.indexOf(q) === -1) return false;
      }
      return true;
    });
  };

  UsersManager.prototype.render = function (list) {
    if (!this.tbody) return;
    if (!list || !list.length) { this.emptyUI(); return; }

    this.tbody.innerHTML = list.map(function (u) {
      var full = [u.firstName, u.lastName].filter(Boolean).join(' ') || (u.name || '—');
      var instName = (u.institution && (u.institution.name || u.institution.label))
                  || u.institutionName || u.bank || u.customer || '—';
      var contact = [
        u.email ? '<div class="text-sm text-slate-600"><i class="fa-solid fa-envelope mr-1"></i>' + esc(u.email) + '</div>' : '',
        u.phone ? '<div class="text-sm text-slate-600"><i class="fa-solid fa-phone mr-1"></i>' + esc(u.phone) + '</div>' : ''
      ].join('');

      var devMac = (u.device && u.device.mac) || u.deviceMac || '—';
      var country = (u.country || '').toUpperCase() || '—';
      var role = (u.role || '—');
      var active = !!u.active;

      return '' +
        '<tr class="hover-row">' +
          '<td class="p-3">' +
            '<div class="font-medium text-slate-800">' + esc(full) + '</div>' +
            (u.address ? '<div class="text-sm text-slate-500">' + esc(u.address) + '</div>' : '') +
          '</td>' +
          '<td class="p-3">' + esc(instName) + '</td>' +
          '<td class="p-3">' + contact + '</td>' +
          '<td class="p-3">' + esc(devMac) + '</td>' +
          '<td class="p-3">' + esc(country) + '</td>' +
          '<td class="p-3 capitalize">' + esc(role) + '</td>' +
          '<td class="p-3">' +
            '<label class="relative inline-flex items-center cursor-pointer" title="' + (active ? 'Désactiver' : 'Activer') + '">' +
              '<input type="checkbox" class="sr-only peer user-toggle" data-id="' + esc(u.id) + '" ' + (active ? 'checked' : '') + '>' +
              '<div class="w-11 h-6 bg-slate-200 peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[\'\'] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>' +
            '</label>' +
          '</td>' +
          '<td class="p-3 text-center">' +
            '<div class="flex items-center justify-center gap-2">' +
              '<button class="btn btn-secondary btn-sm gen-cert-user" data-id="' + esc(u.id) + '" title="Créer/Regénérer le certificat d\'appareil">' +
                '<i class="fa-solid fa-id-badge"></i>' +
              '</button>' +
            '</div>' +
          '</td>' +
        '</tr>';
    }).join('');
  };

  UsersManager.prototype.load = function () {
    var self = this;
    this.loadingUI();
    // Try primary API, else fallback to flat file
    return http(this.endpoints.list, { method: 'GET' })
      .then(function (data) {
        var users = Array.isArray(data?.users) ? data.users
                 : Array.isArray(data?.items) ? data.items
                 : Array.isArray(data) ? data : [];
        state.users = users;
        self.deduceInstitutionsFromUsers(users);
        self.render(self.filterLocal(users));
      })
      .catch(function () {
        // Fallback to public/data/users.json
        return loadUsersFromJsonFile()
          .then(function (users) {
            state.users = users || [];
            self.deduceInstitutionsFromUsers(state.users);
            self.render(self.filterLocal(state.users));
          })
          .catch(function (e2) {
            self.errorUI(e2?.message || MSG.SERVER_ERROR);
          });
      });
  };

  UsersManager.prototype.bindFilters = function () {
    var self = this;
    if (this.filters.institution) this.filters.institution.addEventListener('change', function () { self.render(self.filterLocal(state.users)); });
    if (this.filters.role) this.filters.role.addEventListener('change', function () { self.render(self.filterLocal(state.users)); });
    if (this.filters.country) this.filters.country.addEventListener('change', function () { self.render(self.filterLocal(state.users)); });
    if (this.filters.search) this.filters.search.addEventListener('input', debounce(function () { self.render(self.filterLocal(state.users)); }, 200));

    // Row actions: toggle active + generate device cert
    document.addEventListener('change', function (e) {
      var t = e.target;
      if (!t) return;
      var toggle = t.closest ? t.closest('.user-toggle') : null;
      if (toggle) {
        var id = toggle.getAttribute('data-id');
        var active = !!toggle.checked;
        self.setActive(id, active, toggle);
      }
    });

    document.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.gen-cert-user') : null;
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      self.generateDeviceCertificateForUser(id, btn);
    });
  };

  UsersManager.prototype.setActive = function (id, active, checkboxEl) {
    var url = this.endpoints.updateUser(id);
    var body = { active: !!active };
    checkboxEl && (checkboxEl.disabled = true);

    http(url, { method: 'PATCH', body: JSON.stringify(body) })
      .then(function () {
        var u = (state.users || []).find(function (x) { return String(x.id) === String(id); });
        if (u) u.active = !!active;
        // Persist to flat file (best effort)
        saveUsersToJsonFile(state.users);
        toast('Utilisateur ' + (active ? 'activé' : 'désactivé'), 'success');
      })
      .catch(function (e) {
        // revert
        if (checkboxEl) checkboxEl.checked = !active;
        toast('Échec de la mise à jour: ' + (e?.message || 'inconnue'), 'error');
      })
      .finally(function () { checkboxEl && (checkboxEl.disabled = false); });
  };

  UsersManager.prototype.bindCreateForm = function () {
    var self = this;
    if (!this.createForm) return;

    this.createForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(self.createForm);

      var payload = {
        firstName: (fd.get('firstName') || '').trim(),
        lastName: (fd.get('lastName') || '').trim(),
        email: (fd.get('email') || '').trim(),
        phone: (fd.get('phone') || '').trim(),
        institutionId: (fd.get('institutionId') || '').trim(),
        role: (fd.get('role') || '').trim(),
        country: (fd.get('country') || '').trim().toUpperCase(),
        address: (fd.get('address') || '').trim(),
        active: !!fd.get('active'),
        device: {
          mac: (fd.get('deviceMac') || '').trim(),
          model: (fd.get('deviceModel') || '').trim(),
          serial: (fd.get('deviceSerial') || '').trim(),
          platform: (fd.get('devicePlatform') || '').trim()
        },
        _cert: {
          createNow: !!fd.get('createDeviceCert'),
          validityDays: Number(fd.get('certValidityDays') || 365)
        }
      };

      if (!payload.firstName || !payload.lastName) { toast('Prénom et nom requis.', 'error'); return; }
      if (!payload.email) { toast('E-mail requis.', 'error'); return; }
      if (!payload.phone) { toast('Téléphone requis.', 'error'); return; }
      if (!payload.institutionId) { toast('Institution requise.', 'error'); return; }
      if (!payload.device.mac) { toast('Adresse MAC requise.', 'error'); return; }

      var btn = document.getElementById('btnSubmitCreateUser');
      var html0 = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enregistrement...'; }

      // Step 1: create user via API; fallback to local append if API is missing
      http(self.endpoints.create, { method: 'POST', body: JSON.stringify(payload) })
        .then(function (created) {
          toast('Utilisateur créé avec succès', 'success');
          // After server create, refresh users from API (source of truth)
          return self.load().then(function () { return created; });
        })
        .catch(function () {
          // Fallback path: append to local state & persist to JSON file
          var fallbackUser = Object.assign({ id: Date.now().toString() }, payload);
          state.users = [fallbackUser].concat(state.users || []);
          saveUsersToJsonFile(state.users);
          self.render(self.filterLocal(state.users));
          toast('Utilisateur créé localement (fichier).', 'info');
          return fallbackUser;
        })
        .then(function (created) {
          // Step 2 (optional): create device certificate
          if (!payload._cert.createNow) return created;

          var userId = created && (created.id || created.userId);
          var fullName = [payload.firstName, payload.lastName].join(' ').trim();
          var mac = payload.device.mac.replace(/\s+/g, '').toUpperCase();

          var subject = {
            CN: fullName + ' — ' + mac,
            O: (function () {
              var inst = (state.institutions || []).find(function (i) { return String(i.id) === String(payload.institutionId); });
              return inst ? (inst.name || inst.label || 'FIntraX Client') : 'FIntraX Client';
            })(),
            OU: 'PKI Utilisateurs',
            C: payload.country || 'CD',
            L: payload.address || ''
          };

          var san = 'otherName:mac:' + mac + ',email:' + payload.email;

          var certReq = {
            subject: subject,
            type: 'user',
            validityDays: payload._cert.validityDays || 365,
            san: san,
            key: { algorithm: 'RSA', param: '2048' },
            isCA: false,
            meta: { userId: userId, deviceMac: mac, purpose: 'device' }
          };

          return http(self.endpoints.genCert, { method: 'POST', body: JSON.stringify(certReq) })
            .then(function () {
              toast('Certificat d’appareil généré', 'success');
              return created;
            })
            .catch(function (e) {
              toast('Utilisateur créé mais génération du certificat a échoué: ' + (e?.message || 'inconnue'), 'error');
              return created;
            });
        })
        .then(function () {
          // Close modal and reset form
          var modal = document.getElementById('modalCreateUser');
          modal && modal.classList.add('hidden');
          document.body.style.overflow = '';
          self.createForm.reset();
          // Ensure persisted copy is current
          saveUsersToJsonFile(state.users);
        })
        .finally(function () {
          if (btn) { btn.disabled = false; btn.innerHTML = html0; }
        });
    });
  };

  UsersManager.prototype.generateDeviceCertificateForUser = function (id, btn) {
    var user = (state.users || []).find(function (u) { return String(u.id) === String(id); });
    if (!user) { toast('Utilisateur introuvable', 'error'); return; }

    var mac = (user.device && user.device.mac) || user.deviceMac || '';
    if (!mac) { toast('Aucune adresse MAC enregistrée pour cet utilisateur.', 'error'); return; }

    var fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || (user.name || 'Utilisateur');
    var instName = (user.institution && (user.institution.name || user.institution.label)) ||
                   user.institutionName || 'FIntraX Client';

    var subject = {
      CN: (fullName + ' — ' + mac.toUpperCase()),
      O: instName,
      OU: 'PKI Utilisateurs',
      C: (user.country || 'CD'),
      L: (user.address || '')
    };
    var san = 'otherName:mac:' + mac.toUpperCase() + (user.email ? (',email:' + user.email) : '');

    var req = {
      subject: subject,
      type: 'user',
      validityDays: 365,
      san: san,
      key: { algorithm: 'RSA', param: '2048' },
      isCA: false,
      meta: { userId: user.id, deviceMac: mac.toUpperCase(), purpose: 'device' }
    };

    if (btn) {
      btn.disabled = true;
      var html0 = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      http(this.endpoints.genCert, { method: 'POST', body: JSON.stringify(req) })
        .then(function () { toast('Certificat d’appareil créé/regénéré', 'success'); })
        .catch(function (e) {
          if (e && e.status === 501) toast('Génération de certificat non implémentée (501).', 'error');
          else toast('Échec de la génération: ' + (e?.message || 'inconnue'), 'error');
        })
        .finally(function () { btn.disabled = false; btn.innerHTML = html0; });
    } else {
      http(this.endpoints.genCert, { method: 'POST', body: JSON.stringify(req) })
        .then(function () { toast('Certificat d’appareil créé/regénéré', 'success'); })
        .catch(function (e) { toast('Échec de la génération: ' + (e?.message || 'inconnue'), 'error'); });
    }
  };

  UsersManager.prototype.init = function () {
    this.fetchInstitutions(); // non-blocking
    this.bindFilters();
    this.bindCreateForm();
    this.load();
  };

  // ---------------------------------
  // Signing / Verification / History
  // ---------------------------------
  function initFilePicker() {
    var input = document.getElementById('documentInput');
    var zone = document.getElementById('documentDropZone');
    var browse = document.getElementById('browseLink');
    var chosen = document.getElementById('selectedDocument');
    var nameEl = document.getElementById('documentName');
    var sizeEl = document.getElementById('documentSize');
    var removeBtn = document.getElementById('removeDocument');
    var signBtn = document.getElementById('btnSignDocument');

    if (!input || !zone) return;

    zone.setAttribute('role', 'button');
    zone.setAttribute('tabindex', '0');

    function formatOctets(n) {
      if (!isFinite(n)) return '0 o';
      var u = ['o', 'Ko', 'Mo', 'Go'];
      var i = 0;
      while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
      var digits = (n < 10 && i > 0) ? 1 : 0;
      return n.toFixed(digits) + ' ' + u[i];
    }

    function autoriser(f) {
      var okExt = /\.(pdf|doc|docx|xml|txt|odt)$/i.test(f.name || '');
      var okType = /(pdf|msword|officedocument|xml|text)/i.test(f.type || '') || okExt;
      var max = (APP.ui && APP.ui.maxFileSize) || (10 * 1024 * 1024);
      if (!okType) { toast(MSG.UNSUPPORTED_FILE_TYPE, 'error'); return false; }
      if (f.size > max) { toast(MSG.FILE_TOO_LARGE, 'error'); return false; }
      return true;
    }

    function onSelected(fileList) {
      var f = fileList && fileList[0];
      if (!f) return;
      if (!autoriser(f)) { input.value = ''; return; }
      chosen?.classList.remove('hidden');
      if (nameEl) nameEl.textContent = f.name;
      if (sizeEl) sizeEl.textContent = formatOctets(f.size);
      if (signBtn) signBtn.disabled = false;
    }

    browse?.addEventListener('click', function (e) { e.preventDefault(); input.click(); });
    zone.addEventListener('click', function (e) {
      if (e && e.target && e.target.id === 'browseLink') return;
      input.click();
    });
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', function () { onSelected(input.files); });

    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); zone.classList.add('active'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); zone.classList.remove('active'); });
    });
    zone.addEventListener('drop', function (e) {
      var files = e.dataTransfer ? e.dataTransfer.files : null;
      if (!files || !files.length) return;
      try { var dt = new DataTransfer(); dt.items.add(files[0]); input.files = dt.files; } catch (err) {}
      onSelected(files);
    });

    removeBtn?.addEventListener('click', function () {
      input.value = '';
      chosen?.classList.add('hidden');
      if (signBtn) signBtn.disabled = true;
    });
  }

  function initBoutonSigner() {
    var signBtn = document.getElementById('btnSignDocument');
    var input = document.getElementById('documentInput');
    var certSel = document.getElementById('signingCertSelect');
    var pinEl = document.getElementById('signingPin');
    var tsCb = document.getElementById('includeTimestamp');
    var visCb = document.getElementById('visibleSignature');
    var padesCb = document.getElementById('padesSignature');
    var pinEye = document.getElementById('togglePinVisibility');

    pinEye && pinEl && pinEye.addEventListener('click', function () {
      pinEl.type = pinEl.type === 'password' ? 'text' : 'password';
    });

    function reeval() {
      var hasFile = !!(input && input.files && input.files.length);
      var hasCert = !!(certSel && certSel.value);
      var hasPin = !!(pinEl && pinEl.value);
      if (signBtn) signBtn.disabled = !(hasFile && hasCert && hasPin);
    }
    input?.addEventListener('change', reeval);
    certSel?.addEventListener('change', reeval);
    pinEl?.addEventListener('input', reeval);
    reeval();

    if (!signBtn) return;

    var SIGN_EP = withBase(PKI.signDocument || '/api/pki/documents/sign');

    signBtn.addEventListener('click', function () {
      try {
        var hasFile = !!(input && input.files && input.files.length);
        var certId = (certSel && certSel.value) ? certSel.value : '';
        var pin = (pinEl && pinEl.value) ? pinEl.value : '';

        if (!hasFile) { toast('Veuillez selectionner un document a signer.', 'error'); return; }
        if (!certId) { toast('Veuillez selectionner un certificat de signature.', 'error'); return; }
        if (!pin) { toast('Veuillez saisir votre PIN HSM.', 'error'); return; }

        var file = input.files[0];
        var form = new FormData();
        form.append('document', file, file.name); // keep exact field name & filename
        form.append('certificateId', certId);
        form.append('pin', pin);
        form.append('includeTimestamp', tsCb && tsCb.checked ? 'true' : 'false');
        form.append('visibleSignature', visCb && visCb.checked ? 'true' : 'false');
        form.append('padesSignature', padesCb && padesCb.checked ? 'true' : 'false');

        signBtn.disabled = true;
        var html0 = signBtn.innerHTML;
        signBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signature...';

        // Use longer timeout for uploads/signing
        http(SIGN_EP, { method: 'POST', body: form }, { timeout: 120000 })
          .then(function (dataOrText) {
            var data = (typeof dataOrText === 'string') ? {} : (dataOrText || {});
            if (data.ok === false) throw new Error(data.error || 'Signature echouee');

            var dl = data.signature?.downloadUrl || data.downloadUrl || data.outputUrl;
            if (dl) {
              var link = document.createElement('a');
              link.href = dl;
              link.download = data.signature?.outputName || '';
              document.body.appendChild(link);
              link.click();
              link.remove();
            }
            toast('Document signe avec succes', 'success');

            document.getElementById('selectedDocument')?.classList.add('hidden');
            input.value = '';
            certSel && (certSel.selectedIndex = 0);
            pinEl && (pinEl.value = '');
            reeval();

            rafraichirSignatures();
          })
          .catch(function (e) {
            if (e && e.status === 501) toast('Signature non implémentée côté serveur (501).', 'error');
            else toast('Echec de la signature : ' + (e?.message || 'inconnue'), 'error');
          })
          .finally(function () {
            signBtn.disabled = false;
            signBtn.innerHTML = html0;
          });
      } catch (e) {
        toast('Erreur de signature : ' + (e.message || 'inconnue'), 'error');
      }
    });
  }

  function initVerification() {
    var input = document.getElementById('verifyDocumentInput');
    var btn = document.getElementById('btnQuickVerify');
    var box = document.getElementById('verificationResult');
    var status = document.getElementById('verificationStatus');
    var openBtn = document.getElementById('btnVerifyDocument');
    var VERIFY_EP = withBase(PKI.verifyDocument || '/api/pki/documents/verify');

    if (!input || !btn) return;

    btn.disabled = true;
    input.addEventListener('change', function () {
      btn.disabled = !(input.files && input.files.length);
    });

    openBtn && openBtn.addEventListener('click', function (e) {
      e.preventDefault();
      input.click();
    });

    btn.addEventListener('click', function () {
      if (!input.files || !input.files.length) {
        toast('Choisissez un fichier a verifier.', 'error');
        return;
      }
      var f = input.files[0];
      var html0 = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

      var fd = new FormData();
      fd.append('document', f, f.name); // exact field
      fd.append('detailed', 'true');

      // Slightly longer timeout for verification too
      http(VERIFY_EP, { method: 'POST', body: fd }, { timeout: 60000 })
        .then(function (j) {
          // FIX: accept both shapes:
          // 1) { verification: { valid: true, signer:{...}, ... } }
          // 2) { ok:true, verified:true, signerInfo:"..." }
          var v = j && j.verification ? j.verification : {};
          var ok = (j && j.verified === true) || (v && v.valid === true);

          var signer = v.signer || j.signer || {};
          var timestamp = v.timestamp || j.timestamp || '—';
          var algorithm = v.algorithm || j.algorithm || '—';
          var signerInfoText = j.signerInfo || '';

          box && box.classList.remove('hidden');

          if (ok) {
            status.className = 'p-3 rounded-lg border border-green-300 bg-green-50';

            var details = '';
            if (signer && (signer.subject || signer.issuer || signer.serial)) {
              details +=
                '<div>Signataire: ' + esc(signer.subject || '-') + '</div>' +
                '<div>Emetteur: ' + esc(signer.issuer || '-') + '</div>' +
                '<div>Serie: ' + esc(signer.serial || '-') + '</div>';
            }
            if (timestamp !== '—' || algorithm !== '—') {
              details +=
                '<div>Horodatage: ' + esc(timestamp) + '</div>' +
                '<div>Algorithme: ' + esc(algorithm) + '</div>';
            }

            // Optional raw CMS dump
            if (signerInfoText) {
              details +=
                '<div class="mt-2"><details><summary class="cursor-pointer text-green-800">Détails CMS</summary>' +
                '<pre class="mt-2 whitespace-pre-wrap break-words text-xs text-slate-700">' + esc(signerInfoText) + '</pre></details></div>';
            }

            status.innerHTML =
              '<div class="text-green-700 font-medium"><i class="fas fa-check-circle"></i> Signature VALIDE</div>' +
              '<div class="text-sm text-green-800 mt-2">' + details + '</div>';

            toast('Signature valide', 'success');
          } else {
            status.className = 'p-3 rounded-lg border border-red-300 bg-red-50';
            var reason = (v && (v.reason || v.error)) || j.error || 'Signature invalide';
            status.innerHTML =
              '<div class="text-red-700 font-medium"><i class="fas fa-times-circle"></i> Signature INVALIDE</div>' +
              '<div class="text-sm text-red-800 mt-2">' + esc(reason) + '</div>';
            toast('Signature invalide', 'error');
          }
        })
        .catch(function (e) {
          box && box.classList.remove('hidden');
          status.className = 'p-3 rounded-lg border border-red-300 bg-red-50';
          if (e && e.status === 501) {
            status.innerHTML = '<div class="text-red-700 font-medium">Verification indisponible (501)</div>';
          } else {
            status.innerHTML = '<div class="text-red-700 font-medium">Echec verification: ' + esc(e?.message || 'inconnue') + '</div>';
          }
        })
        .finally(function () {
          btn.disabled = !(input.files && input.files.length);
          btn.innerHTML = html0;
        });
    });
  }

  function rafraichirSignatures() {
    var body = document.getElementById('signaturesTableBody');
    var ctxt = document.getElementById('signaturesCountText');
    var endpoint = withBase((window.APP_CONFIG?.api?.pki?.signatures) || '/api/pki/signatures');

    if (body) {
      body.innerHTML =
        '<tr><td colspan="4" class="text-center p-6 text-slate-400">' +
        '<i class="fas fa-spinner spinner mr-2"></i> Chargement de l\'historique...' +
        '</td></tr>';
    }

    http(endpoint, { method: 'GET', cache: 'no-store' })
      .then(function (data) {
        var arr = Array.isArray(data?.signatures) ? data.signatures
                : Array.isArray(data?.items)      ? data.items
                : Array.isArray(data)             ? data
                : [];
        state.signatures = arr;

        if (ctxt) ctxt.textContent = (arr.length || 0) + ' signatures trouvées';
        if (!body) return;

        if (!arr.length) {
          body.innerHTML =
            '<tr><td colspan="4" class="text-center p-6 text-slate-500">Aucune signature récente</td></tr>';
          return;
        }

        body.innerHTML = arr.slice(0, 20).map(function (s) {
          var doc = s.documentName || s.document || 'Document';
          var ts  = s.signedAt || s.timestamp || s.ts || new Date().toISOString();
          var ok  = (s.status === 'valid') || (s.ok === true) || (s.status === 'signed');
          var badge = ok
            ? '<span class="badge bg-green-100 text-green-800"><i class="fas fa-check-circle"></i> valide</span>'
            : '<span class="badge bg-red-100 text-red-800"><i class="fas fa-times-circle"></i> invalide</span>';

          var rawUrl = s.downloadUrl || s.url || s.outputUrl || '';
          var url = rawUrl && !/^https?:\/\//i.test(rawUrl) ? (API_BASE + rawUrl) : rawUrl;
          var btnDl = url
            ? '<button class="btn btn-secondary btn-sm download-signature" data-url="' + esc(url) + '" title="Télécharger"><i class="fas fa-download"></i></button>'
            : '<button class="btn btn-secondary btn-sm" disabled title="Indisponible"><i class="fas fa-download"></i></button>';

          return '' +
            '<tr class="hover-row">' +
            '<td class="p-3 text-ellipsis" title="'+esc(doc)+'">' + esc(doc) + '</td>' +
            '<td class="p-3 whitespace-nowrap">' + fmtDate(ts) + '</td>' +
            '<td class="p-3 text-center">' + badge + '</td>' +
            '<td class="p-3 text-center">' + btnDl + '</td>' +
            '</tr>';
        }).join('');
      })
      .catch(function (e) {
        if (body) {
          if (e && e.status === 501) {
            body.innerHTML =
              '<tr><td colspan="4" class="text-center p-6 text-amber-600">' +
              '<i class="fas fa-plug mr-1"></i> Historique indisponible (501).' +
              '</td></tr>';
          } else {
            body.innerHTML =
              '<tr><td colspan="4" class="text-center p-6 text-red-600">' +
              esc((e && e.message) ? e.message : 'Erreur inconnue') +
              '</td></tr>';
          }
        }
        if (ctxt) ctxt.textContent = '0 signatures trouvées';
      });
  }

  // ---------------------------------
  // Tabs & globals
  // ---------------------------------
  function activerOnglet(id) {
    var contents = document.querySelectorAll('.tab-content');
    for (var i = 0; i < contents.length; i++) contents[i].classList.remove('active');
    var tab = document.getElementById(id);
    if (tab) tab.classList.add('active');

    var navs = document.querySelectorAll('nav a');
    for (var j = 0; j < navs.length; j++) {
      var a = navs[j];
      a.classList.remove('active-link');
      if (a.dataset && a.dataset.tab === id) a.classList.add('active-link');
    }

    state.onglet = id;
    majTitrePage(id);
    chargerOnglet(id);
  }

  function majTitrePage(id) {
    var titres = {
      dashboard: 'Tableau de bord PKI',
      certificates: 'Gestion des certificats',
      signing: 'Signature et horodatage',
      users: 'Gestion des utilisateurs',
      tsa: 'Autorite d horodatage',
      crl: 'Listes de revocation',
      audit: 'Journal d audit',
      settings: 'Parametres PKI'
    };
    var el = document.getElementById('pageTitle');
    if (el) el.textContent = titres[id] || 'PKI Manager';
  }

  function chargerOnglet(id) {
    if (id === 'dashboard') rafraichirDashboard();
    else if (id === 'certificates') { if (window.certManager) window.certManager.recharger(); }
    else if (id === 'signing') rafraichirSignatures();
    else if (id === 'users') { if (window.usersManager) window.usersManager.load(); }
  }

  function lierGlobaux() {
    var mobileToggle = document.getElementById('mobileMenuToggle');
    var sidebarToggle = document.getElementById('sidebarToggle');
    var sidebar = document.getElementById('sidebar');

    if (mobileToggle && sidebar) mobileToggle.addEventListener('click', function () { sidebar.classList.add('open'); });
    if (sidebarToggle && sidebar) sidebarToggle.addEventListener('click', function () { sidebar.classList.remove('open'); });

    document.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('nav a') : null;
      if (!a) return;
      e.preventDefault();
      var id = a.dataset ? a.dataset.tab : null;
      if (id) activerOnglet(id);
    });

    document.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains('modal-overlay')) {
        t.classList.add('hidden');
        document.body.style.overflow = '';
      }
    });

    var batch = document.getElementById('btnBatchSign');
    if (batch) batch.addEventListener('click', function () { toast('Signature par lot : a venir.', 'info'); });

    var btnHsm = document.getElementById('refreshHSM');
    btnHsm && btnHsm.addEventListener('click', rafraichirStatutHSM);
    var btnDash = document.getElementById('refreshDashboard');
    btnDash && btnDash.addEventListener('click', rafraichirDashboard);
  }

  // ---------------------------------
  // Init
  // ---------------------------------
  function init() {
    window.certManager = new GestionCertificats();
    window.certManager.lierUI();

    // Users
    window.usersManager = new UsersManager();
    window.usersManager.init();

    lierGlobaux();
    initFilePicker();
    initBoutonSigner();
    initVerification();

    rafraichirStatutHSM();
    rafraichirDashboard();
    window.certManager.recharger();
    rafraichirSignatures();

    activerOnglet('dashboard');

    if (APP.ui && APP.ui.autoRefresh) {
      var interval = APP.ui.refreshInterval || 30000;
      setInterval(function () {
        rafraichirStatutHSM();
        if (state.onglet === 'dashboard') rafraichirDashboard();
        if (state.onglet === 'certificates') { if (window.certManager) window.certManager.recharger(); }
        if (state.onglet === 'signing') rafraichirSignatures();
        if (state.onglet === 'users') { if (window.usersManager) window.usersManager.load(); }
      }, interval);
    }

    toast('Application PKI initialisee', 'success');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
