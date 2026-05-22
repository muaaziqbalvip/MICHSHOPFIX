/* ══════════════════════════════════════════════════════════════
   MICH Digital Shop — app.js  (Realtime Database Edition)
   ── Firestore COMPLETELY removed ─────────────────────────────
   ── All data now in Firebase Realtime Database ───────────────
   ── Referral system fully fixed ──────────────────────────────
   ── Earnings auto-created as PENDING on every order ──────────
   ── Admin marks delivered → earnings become APPROVED ─────────
   ══════════════════════════════════════════════════════════════

   RTDB STRUCTURE:
   /users/{uid}/          — user profiles
   /catalogs/{id}/        — products
   /orders/{id}/          — all orders
   /earnings/{id}/        — reseller earnings (status: pending/approved)
   /withdrawals/{id}/     — withdrawal requests
   /shares/{id}/          — share tracking
   /clients/{resellerId}/{clientId}/  — clients per reseller
   ════════════════════════════════════════════════════════════ */

// ════════════════════════════════════════════════════════════════
// 1. FIREBASE INIT
// ════════════════════════════════════════════════════════════════

firebase.initializeApp({
  apiKey:            'AIzaSyBbnU8DkthpYQMHOLLyj6M0cc05qXfjMcw',
  authDomain:        'ramadan-2385b.firebaseapp.com',
  databaseURL:       'https://ramadan-2385b-default-rtdb.firebaseio.com',
  projectId:         'ramadan-2385b',
  storageBucket:     'ramadan-2385b.firebasestorage.app',
  messagingSenderId: '882828936310',
  appId:             '1:882828936310:web:7f97b921031fe130fe4b57',
});

const fauth = firebase.auth();
const rdb   = firebase.database();   // ← ONLY Realtime Database, no Firestore

// ════════════════════════════════════════════════════════════════
// 1b. RTDB HELPERS — push/set/get/update/remove wrappers
// ════════════════════════════════════════════════════════════════

// Generate push key
function rtdbPushKey(path) {
  return rdb.ref(path).push().key;
}

// Set (create/overwrite)
async function rtdbSet(path, data) {
  await rdb.ref(path).set(data);
}

// Update (merge)
async function rtdbUpdate(path, data) {
  await rdb.ref(path).update(data);
}

// Get once
async function rtdbGet(path) {
  const snap = await rdb.ref(path).once('value');
  return snap.exists() ? snap.val() : null;
}

// Remove
async function rtdbRemove(path) {
  await rdb.ref(path).remove();
}

// Listen realtime
function rtdbOn(path, cb) {
  const ref = rdb.ref(path);
  ref.on('value', snap => cb(snap.exists() ? snap.val() : null));
  return () => ref.off('value');
}

// Query by child value
async function rtdbQueryEqual(path, child, value) {
  const snap = await rdb.ref(path).orderByChild(child).equalTo(value).once('value');
  if (!snap.exists()) return [];
  const result = [];
  snap.forEach(c => result.push({ id: c.key, ...c.val() }));
  return result;
}

// Now timestamp
function nowTs() { return Date.now(); }

// ════════════════════════════════════════════════════════════════
// 1c. SECURITY HELPER — escapeHtml
// ════════════════════════════════════════════════════════════════

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

// ════════════════════════════════════════════════════════════════
// 1d. IMGBB IMAGE UPLOAD SYSTEM
// ════════════════════════════════════════════════════════════════

const IMGBB_API_KEY = '6bdb23b28e7581721b28e46ce313308b';
const APP_URL       = 'https://michshoping.vercel.app';

async function uploadToImgBB(file) {
  const fd = new FormData();
  fd.append('image', file);
  const res  = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, { method:'POST', body:fd });
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'ImgBB upload failed');
  return { url: data.data.url, thumb: data.data.thumb?.url || data.data.url };
}

function renderImgBBUploader(containerId, onUploaded, preloadedUrls=[], maxImages=5) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container._imgUrls = [...preloadedUrls];
  function rebuild() {
    const urls = container._imgUrls;
    container.innerHTML = `
      <div class="imgbb-uploader">
        <div class="imgbb-preview" id="${containerId}-preview">
          ${urls.map((u,i)=>`
            <div class="imgbb-thumb-wrap">
              <img src="${u}" class="imgbb-thumb" alt="img${i+1}" />
              <button class="imgbb-remove" onclick="__imgbbRemove('${containerId}',${i})" title="Remove">✕</button>
            </div>`).join('')}
          ${urls.length<maxImages?`
            <label class="imgbb-add ${container._uploading?'uploading':''}" for="${containerId}-file">
              ${container._uploading
                ?`<span class="imgbb-spinner"></span><span style="font-size:0.7rem;color:var(--text3)">Uploading...</span>`
                :`<span style="font-size:1.8rem">📷</span><span style="font-size:0.7rem;color:var(--text3)">Add Image</span>`}
            </label>
            <input type="file" id="${containerId}-file" accept="image/*" multiple style="display:none"
              onchange="__imgbbUpload('${containerId}',this.files,${maxImages})" />`:''}
        </div>
        <div style="font-size:0.72rem;color:var(--text4);margin-top:4px">${urls.length}/${maxImages} images</div>
      </div>`;
    onUploaded([...container._imgUrls]);
  }
  rebuild();
  container._rebuild = rebuild;
}
window.__imgbbRemove = function(cid, idx) {
  const c = document.getElementById(cid);
  if (!c) return;
  c._imgUrls.splice(idx,1);
  c._rebuild();
};
window.__imgbbUpload = async function(cid, files, maxImages) {
  const c = document.getElementById(cid);
  if (!c) return;
  const remaining = maxImages - c._imgUrls.length;
  const toUpload  = Array.from(files).slice(0, remaining);
  if (!toUpload.length) return;
  c._uploading = true; c._rebuild();
  let uploaded = 0;
  for (const file of toUpload) {
    try { const {url}=await uploadToImgBB(file); c._imgUrls.push(url); uploaded++; }
    catch(e){ showToast(`Upload failed: ${e.message}`,'error'); }
  }
  c._uploading = false; c._rebuild();
  if (uploaded) showToast(`${uploaded} image${uploaded>1?'s':''} uploaded! ✅`,'success');
};

function renderProfilePhotoUploader(containerId, currentPhotoUrl, onUploaded) {
  const container = document.getElementById(containerId);
  if (!container) return;
  function rebuild(uploading=false) {
    container.innerHTML=`
      <div class="profile-photo-uploader">
        <div class="profile-photo-wrap">
          ${currentPhotoUrl
            ?`<img src="${currentPhotoUrl}" class="profile-photo-preview" />`
            :`<div class="profile-photo-placeholder">${(userProfile?.name||'U').charAt(0)}</div>`}
          <label for="${containerId}-input" class="profile-photo-btn ${uploading?'uploading':''}">
            ${uploading?`<span class="imgbb-spinner"></span>`:`<span>📷</span>`}
          </label>
          <input type="file" id="${containerId}-input" accept="image/*" style="display:none"
            onchange="__profilePhotoUpload('${containerId}',this.files[0])" />
        </div>
        ${uploading?`<div style="font-size:0.72rem;color:var(--blue);margin-top:6px">Uploading...</div>`:''}
      </div>`;
  }
  container._onUploaded = onUploaded;
  container._currentUrl = currentPhotoUrl;
  rebuild();
  container._rebuild = rebuild;
}
window.__profilePhotoUpload = async function(cid, file) {
  if (!file) return;
  const c = document.getElementById(cid);
  if (!c) return;
  c._rebuild(true);
  try {
    const {url} = await uploadToImgBB(file);
    c._currentUrl = url;
    c._onUploaded(url);
    renderProfilePhotoUploader(cid, url, c._onUploaded);
    showToast('Profile photo updated! 🎉','success');
  } catch(e) { c._rebuild(false); showToast('Photo upload failed: '+e.message,'error'); }
};

// ════════════════════════════════════════════════════════════════
// 2. GLOBAL STATE
// ════════════════════════════════════════════════════════════════

let currentUser   = null;
let userProfile   = null;
let currentPage   = 'home';
let currentParams = {};
let allCatalogs   = [];
let searchTimeout = null;

// ── Referral system ──────────────────────────────────────────────
// On page load: save any ?ref= or #ref= to localStorage
(function() {
  const _qRef = new URLSearchParams(window.location.search).get('ref');
  const _hRef = (function(){
    try { return new URLSearchParams(window.location.hash.replace(/^#\/?/,'')).get('ref'); }
    catch(e){ return null; }
  })();
  const _anyRef = _qRef || _hRef;
  if (_anyRef) localStorage.setItem('mich_ref', _anyRef);
})();

// Always read ref fresh — supports hash routing + localStorage persistence
function getActiveRef() {
  try {
    const hashRef = new URLSearchParams(window.location.hash.replace(/^#\/?/,'')).get('ref');
    if (hashRef) return hashRef;
  } catch(e){}
  const qRef = new URLSearchParams(window.location.search).get('ref');
  if (qRef) return qRef;
  return localStorage.getItem('mich_ref') || null;
}

// ── Listener registry ────────────────────────────────────────────
const _rtdbListeners = {};
function registerListener(key, unsubFn) {
  if (_rtdbListeners[key]) { try { _rtdbListeners[key](); } catch(e){} }
  _rtdbListeners[key] = unsubFn;
}
function unsubscribeAll() {
  Object.keys(_rtdbListeners).forEach(k => {
    try { _rtdbListeners[k](); } catch(e){}
    delete _rtdbListeners[k];
  });
}

const CURRENCY_SYM = { PKR:'₨', USD:'$', SAR:'﷼', AED:'د.إ', INR:'₹', EUR:'€' };
const METHODS      = ['JazzCash','Easypaisa','Bank Transfer','Binance USDT','PayPal'];

// ════════════════════════════════════════════════════════════════
// 3. RTDB DATA HELPERS — Users / Catalogs / Orders / Earnings
// ════════════════════════════════════════════════════════════════

// ── Users ────────────────────────────────────────────────────────
async function createUserDoc(uid, data) {
  const existing = await rtdbGet(`users/${uid}`);
  if (!existing) {
    await rtdbSet(`users/${uid}`, {
      ...data,
      role:               data.role || 'customer',
      earnings:           0,
      pendingEarnings:    0,
      withdrawableBalance:0,
      totalOrders:        0,
      referralCode:       uid.slice(0,8).toUpperCase(),
      createdAt:          nowTs(),
    });
  }
}

async function getUserDoc(uid) {
  const val = await rtdbGet(`users/${uid}`);
  return val ? { id: uid, ...val } : null;
}

async function updateUserDoc(uid, data) {
  await rtdbUpdate(`users/${uid}`, { ...data, updatedAt: nowTs() });
}

async function getAllUsers() {
  const val = await rtdbGet('users');
  if (!val) return [];
  return Object.entries(val).map(([id, v]) => ({ id, ...v }))
    .sort((a,b) => (b.createdAt||0)-(a.createdAt||0));
}

// ── Referral resolution ──────────────────────────────────────────
// Accepts UID or referralCode → returns reseller UID or null
async function resolveResellerId(refString) {
  if (!refString) return null;
  const trimmed = refString.trim().toUpperCase();

  // 1. Try as direct UID
  const directUser = await rtdbGet(`users/${refString.trim()}`);
  if (directUser) return refString.trim();

  // 2. Try as referralCode — scan all users
  // (RTDB doesn't support compound queries, but we query by referralCode index)
  const snap = await rdb.ref('users').orderByChild('referralCode').equalTo(trimmed).once('value');
  if (snap.exists()) {
    let foundUid = null;
    snap.forEach(child => { foundUid = child.key; });
    return foundUid;
  }

  return null;
}

// ── Catalogs ─────────────────────────────────────────────────────
async function getCatalogs(limitN=40) {
  const val = await rtdbGet('catalogs');
  if (!val) return [];
  return Object.entries(val)
    .map(([id,v]) => ({ id, ...v }))
    .filter(c => c.active !== false)
    .sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))
    .slice(0, limitN);
}

async function getCatalogById(id) {
  try {
    const timeoutPromise = new Promise((_,reject)=>
      setTimeout(()=>reject(new Error('Request timed out. Check connection.')),15000));
    const fetchPromise = rtdbGet(`catalogs/${id}`);
    const val = await Promise.race([fetchPromise, timeoutPromise]);
    return val ? { id, ...val } : null;
  } catch(e) {
    const appEl = document.getElementById('app-content');
    if (appEl) appEl.innerHTML=`
      <div class="page"><div class="empty">
        <div class="empty-icon">😕</div>
        <div class="empty-title">Failed to load product</div>
        <div class="empty-text">${escapeHtml(e.message)}</div>
        <button class="btn-outline sm" onclick="navigate('catalogs')">← Go Back</button>
      </div></div>`;
    return null;
  }
}

async function createCatalog(data) {
  const id = rtdbPushKey('catalogs');
  await rtdbSet(`catalogs/${id}`, {
    ...data, views:0, shares:0, orders:0, active:true,
    createdAt: nowTs(), updatedAt: nowTs()
  });
  return id;
}

async function updateCatalog(id, data) {
  await rtdbUpdate(`catalogs/${id}`, { ...data, updatedAt: nowTs() });
}

async function deleteCatalog(id) {
  await rtdbUpdate(`catalogs/${id}`, { active: false });
}

async function incrementViews(id) {
  const views = (await rtdbGet(`catalogs/${id}/views`)) || 0;
  await rtdbUpdate(`catalogs/${id}`, { views: views + 1 });
}

// ── Orders ───────────────────────────────────────────────────────
async function createOrder(data) {
  const id = rtdbPushKey('orders');
  await rtdbSet(`orders/${id}`, {
    ...data, status: 'pending',
    createdAt: nowTs(), updatedAt: nowTs()
  });
  return id;
}

async function getMyOrders(uid) {
  const val = await rtdbGet('orders');
  if (!val) return [];
  return Object.entries(val)
    .map(([id,v])=>({ id, ...v }))
    .filter(o => o.resellerId===uid || o.buyerId===uid)
    .sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
}

async function getAllOrders() {
  const val = await rtdbGet('orders');
  if (!val) return [];
  return Object.entries(val)
    .map(([id,v])=>({ id, ...v }))
    .sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
}

async function updateOrderStatus(id, status) {
  await rtdbUpdate(`orders/${id}`, { status, updatedAt: nowTs() });
}

// ── Earnings ─────────────────────────────────────────────────────
async function createEarning(data) {
  const id = rtdbPushKey('earnings');
  await rtdbSet(`earnings/${id}`, {
    ...data, status: 'pending', createdAt: nowTs()
  });
  return id;
}

async function getMyEarnings(uid) {
  const val = await rtdbGet('earnings');
  if (!val) return [];
  return Object.entries(val)
    .map(([id,v])=>({ id, ...v }))
    .filter(e => e.userId === uid)
    .sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
}

async function getEarningsByOrder(orderId) {
  const val = await rtdbGet('earnings');
  if (!val) return [];
  return Object.entries(val)
    .map(([id,v])=>({ id, ...v }))
    .filter(e => e.orderId === orderId && e.status === 'pending');
}

// ── Withdrawals ───────────────────────────────────────────────────
async function createWithdrawal(data) {
  const id = rtdbPushKey('withdrawals');
  await rtdbSet(`withdrawals/${id}`, {
    ...data, status: 'pending', createdAt: nowTs()
  });
  return id;
}

async function getMyWithdrawals(uid) {
  const val = await rtdbGet('withdrawals');
  if (!val) return [];
  return Object.entries(val)
    .map(([id,v])=>({ id, ...v }))
    .filter(w => w.userId === uid)
    .sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
}

async function getAllWithdrawals() {
  const val = await rtdbGet('withdrawals');
  if (!val) return [];
  return Object.entries(val)
    .map(([id,v])=>({ id, ...v }))
    .sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
}

async function updateWithdrawal(id, data) {
  await rtdbUpdate(`withdrawals/${id}`, { ...data, updatedAt: nowTs() });
}

// ── Shares / Clients ─────────────────────────────────────────────
async function recordShare(catalogId, userId, platform) {
  const id = rtdbPushKey('shares');
  await rtdbSet(`shares/${id}`, { catalogId, userId, platform, createdAt: nowTs() });
  const shares = (await rtdbGet(`catalogs/${catalogId}/shares`)) || 0;
  await rtdbUpdate(`catalogs/${catalogId}`, { shares: shares + 1 });
}

async function getClients(resellerId) {
  const val = await rtdbGet(`clients/${resellerId}`);
  if (!val) return [];
  return Object.entries(val).map(([id,v])=>({ id, ...v }));
}

// ════════════════════════════════════════════════════════════════
// 4. AUTH FUNCTIONS
// ════════════════════════════════════════════════════════════════

async function loginWithGoogle() {
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    const result   = await fauth.signInWithPopup(provider);
    const u = result.user;
    await createUserDoc(u.uid, { name:u.displayName||'', email:u.email||'', photo:u.photoURL||'' });
    showToast('Welcome back! 🎉','success');
    return { success:true };
  } catch(e) { showToast(e.message,'error'); return { success:false }; }
}

async function loginWithEmail(email, password) {
  try {
    await fauth.signInWithEmailAndPassword(email, password);
    showToast('Welcome back! 🎉','success');
    return { success:true };
  } catch(e) { showToast(e.message,'error'); return { success:false }; }
}

async function signUpWithEmail(name, email, password, role) {
  try {
    const result = await fauth.createUserWithEmailAndPassword(email, password);
    await result.user.updateProfile({ displayName: name });
    await createUserDoc(result.user.uid, { name, email, role, photo:'' });
    showToast('Account created! Welcome 🚀','success');
    return { success:true };
  } catch(e) { showToast(e.message,'error'); return { success:false }; }
}

async function logoutUser() {
  await fauth.signOut();
  showToast('Logged out','info');
  navigate('home');
}

async function resetPassword(email) {
  try {
    await fauth.sendPasswordResetEmail(email);
    showToast('Reset email sent!','success');
  } catch(e) { showToast(e.message,'error'); }
}

// ════════════════════════════════════════════════════════════════
// 5. UI HELPERS
// ════════════════════════════════════════════════════════════════

function showToast(msg, type='info', duration=3500) {
  const icons = { success:'✅', error:'❌', info:'ℹ️', warn:'⚠️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]||'💬'}</span><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(()=>{ el.classList.add('hide'); setTimeout(()=>el.remove(),350); }, duration);
}

function openModal(html) {
  document.getElementById('modal-box').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
}
function closeModal(e) {
  if (!e || e.target===document.getElementById('modal-overlay'))
    document.getElementById('modal-overlay').classList.add('hidden');
}
function closeModalForce() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

function setContent(html) {
  document.getElementById('app-content').innerHTML = html;
  window.scrollTo(0,0);
}

function fmt(n) { return (n||0).toLocaleString(); }

function timeSince(ts) {
  if (!ts) return 'Just now';
  const d = typeof ts === 'number' ? new Date(ts) : (ts.toDate ? ts.toDate() : new Date(ts));
  return d.toLocaleDateString('en-PK',{ day:'numeric', month:'short', year:'numeric' });
}

function generateShareUrl(id) {
  const ref = userProfile?.referralCode || currentUser?.uid?.slice(0,8) || '';
  return `${APP_URL}/?share=${id}&ref=${ref}`;
}

function shareOnWhatsApp(catalog) {
  const url  = generateShareUrl(catalog.id);
  const sym  = CURRENCY_SYM[catalog.currency]||'₨';
  const text = `🛍️ *${catalog.title}*\n💰 Price: ${sym}${fmt(catalog.resellerPrice||catalog.price)}\n✅ Order here: ${url}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  if (currentUser) recordShare(catalog.id, currentUser.uid, 'whatsapp');
}
function shareOnFacebook(catalog) {
  window.open(`https://facebook.com/sharer/sharer.php?u=${encodeURIComponent(generateShareUrl(catalog.id))}`, '_blank');
  if (currentUser) recordShare(catalog.id, currentUser.uid, 'facebook');
}
function shareOnTelegram(catalog) {
  const url = generateShareUrl(catalog.id);
  window.open(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(catalog.title)}`, '_blank');
  if (currentUser) recordShare(catalog.id, currentUser.uid, 'telegram');
}
function copyLink(id) {
  navigator.clipboard.writeText(generateShareUrl(id)).then(()=>showToast('Link copied! 📋','success'));
}
function skeletonCards(n=6) {
  return Array.from({length:n},()=>`<div class="product-card skeleton" style="min-height:280px"><div style="width:100%;height:160px;background:var(--bg3);border-radius:12px;margin-bottom:12px"></div><div style="height:16px;background:var(--bg3);border-radius:4px;margin-bottom:8px"></div><div style="height:12px;background:var(--bg3);border-radius:4px;width:60%"></div></div>`).join('');
}
function updateNavUI() {
  const navbar  = document.getElementById('navbar');
  const botNav  = document.getElementById('bottom-nav');
  const adminLnk= document.getElementById('admin-link');
  const adminMob= document.getElementById('admin-mobile-link');
  const logoutM = document.getElementById('mobile-logout');
  const userArea= document.getElementById('nav-user-area');
  if (!navbar) return;
  navbar.classList.remove('hidden');
  if (currentUser && userProfile) {
    botNav?.classList.remove('hidden');
    const isAdmin = userProfile.role === 'admin';
    if (adminLnk) adminLnk.classList.toggle('hidden',!isAdmin);
    if (adminMob) adminMob.classList.toggle('hidden',!isAdmin);
    if (logoutM)  logoutM.style.display='block';
    const initials=(userProfile.name||currentUser.email||'U').charAt(0).toUpperCase();
    userArea.innerHTML = userProfile.photo
      ?`<img src="${userProfile.photo}" class="nav-avatar" onclick="navigate('profile')" />
        <button class="btn-outline sm" onclick="logoutUser()">Logout</button>`
      :`<div class="nav-avatar-placeholder" onclick="navigate('profile')">${initials}</div>
        <button class="btn-outline sm" onclick="logoutUser()">Logout</button>`;
  } else {
    botNav?.classList.add('hidden');
    if (adminLnk) adminLnk.classList.add('hidden');
    if (adminMob) adminMob.classList.add('hidden');
    if (logoutM)  logoutM.style.display='none';
    userArea.innerHTML=`<button class="btn-neon sm" onclick="navigate('auth')">Login</button>`;
  }
  updateActiveNav();
}
function updateActiveNav() {
  document.querySelectorAll('.nav-link,.bnav-item').forEach(el=>{
    el.classList.toggle('active', el.dataset.page===currentPage);
  });
}
function closeMobileMenu() {
  document.getElementById('mobile-menu')?.classList.add('hidden');
}
function toggleMobileMenu() {
  document.getElementById('mobile-menu')?.classList.toggle('hidden');
}

// ════════════════════════════════════════════════════════════════
// 6. PAGES — Home, Catalogs, Product Detail, Order, Earnings etc.
// ════════════════════════════════════════════════════════════════

// ── HOME ─────────────────────────────────────────────────────────
async function renderHomeV3() {
  currentPage = 'home';
  setContent(`
    <div style="padding-bottom:100px">
      <!-- Eid Banner -->
      ${renderEidHeroCard()}

      <!-- Hero -->
      <div class="section" style="padding:32px 20px 24px;text-align:center">
        <h1 style="font-size:2rem;font-weight:900;line-height:1.2;margin-bottom:12px">
          🛍️ <span class="gradient-text">MICH Digital</span> Shop
        </h1>
        <p style="color:var(--text3);font-size:0.95rem;margin-bottom:20px">Pakistan's #1 Reseller Marketplace</p>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
          <button class="btn-neon lg" onclick="navigate('catalogs')">Browse Products →</button>
          ${!currentUser?`<button class="btn-outline lg" onclick="navigate('auth')">⭐ Create Account</button>`:''}
        </div>
        <div style="font-size:0.8rem;color:var(--text4);margin-top:12px" id="products-count">Loading products...</div>
      </div>

      <!-- Trending -->
      <div class="section" style="padding:0 16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h2 class="section-title" style="font-size:1.1rem">🔥 <span class="gradient-text">Trending</span></h2>
          <button class="btn-outline sm" onclick="navigate('catalogs')">View All</button>
        </div>
        <div class="products-grid" id="trending-grid">${skeletonCards(6)}</div>
      </div>

      <!-- All Products -->
      <div class="section" style="padding:0 16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h2 class="section-title" style="font-size:1.1rem">📦 All <span class="gradient-text">Products</span></h2>
        </div>
        <div class="products-grid" id="home-products-grid">${skeletonCards(6)}</div>
      </div>

      ${currentUser?'':` 
      <div class="section" style="padding:24px 16px;text-align:center">
        <div class="card" style="padding:32px 20px">
          <div style="font-size:3rem;margin-bottom:16px">💰</div>
          <h2 style="font-size:1.3rem;font-weight:800;margin-bottom:8px">Earn Money Reselling!</h2>
          <p style="color:var(--text3);font-size:0.9rem;margin-bottom:20px">Share products & earn commission on every order</p>
          <button class="btn-neon lg" onclick="navigate('auth')">⭐ Create Free Account</button>
        </div>
      </div>`}
    </div>
  `);

  // Real-time catalog listener
  const unsubCatalogs = rtdbOn('catalogs', (val) => {
    let cats = [];
    if (val) {
      cats = Object.entries(val)
        .map(([id,v])=>({ id, ...v }))
        .filter(c=>c.active!==false)
        .sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    }
    allCatalogs = cats;
    const el1 = document.getElementById('trending-grid');
    const el2 = document.getElementById('home-products-grid');
    const cnt  = document.getElementById('products-count');
    if (el1) el1.innerHTML = renderProductCards(cats.slice(0,6));
    if (el2) el2.innerHTML = renderProductCards(cats);
    if (cnt) cnt.textContent = `${cats.length} products available`;
  });
  registerListener('homeCatalogs', unsubCatalogs);
}

// ── CATALOGS PAGE ────────────────────────────────────────────────
async function renderCatalogs(params={}) {
  const initCategory = params.category||'all';
  setContent(`
    <div class="page">
      <div style="margin-bottom:20px">
        <h1 class="section-title" style="font-size:1.4rem">Product <span class="gradient-text">Catalog</span></h1>
        <p style="color:var(--text3);font-size:0.85rem;margin-top:4px" id="cat-count">Loading...</p>
      </div>
      <div class="search-bar">
        <span class="search-icon">🔍</span>
        <input class="input" id="catalog-search" placeholder="Search products, tags..." oninput="filterCatalogs()" />
        <span class="search-clear" onclick="clearCatalogSearch()">✕</span>
      </div>
      <div class="filter-bar" style="margin-bottom:8px">
        <div class="filter-chips">
          ${['All','Physical','Digital'].map(t=>
            `<span class="filter-chip ${t==='All'?'active':''}" data-type="${t.toLowerCase()}" onclick="setTypeFilter(this,'${t}')">${t==='Physical'?'📦 ':t==='Digital'?'⚡ ':''}${t}</span>`
          ).join('')}
        </div>
      </div>
      <div class="cat-scroll" style="margin-bottom:16px">
        ${['all','mobiles','electronics','fashion','education','entertainment','software','music','giftcards','beauty'].map(c=>
          `<span class="filter-chip ${c===initCategory?'active':''}" data-cat="${c}" onclick="setCatFilter(this,'${c}')">${c.charAt(0).toUpperCase()+c.slice(1)}</span>`
        ).join('')}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div class="filter-chips" style="flex:none;gap:6px">
          ${['newest','popular','price_asc','price_desc'].map((s,i)=>{
            const labels=['Newest','Popular','Price ↑','Price ↓'];
            return `<span class="filter-chip ${s==='newest'?'active':''}" data-sort="${s}" onclick="setSortFilter(this,'${s}')">${labels[i]}</span>`;
          }).join('')}
        </div>
      </div>
      <div class="products-grid" id="catalogs-grid">${skeletonCards(12)}</div>
    </div>
  `);
  if (!allCatalogs.length) allCatalogs = await getCatalogs(100);
  window._catFilterState = { category:initCategory, type:'all', sort:'newest', search:'' };
  renderFilteredCatalogs();
  const cnt = document.getElementById('cat-count');
  if (cnt) cnt.textContent = `${allCatalogs.length} products found`;
}

function filterCatalogs() {
  const q = document.getElementById('catalog-search')?.value||'';
  if (!window._catFilterState) window._catFilterState={category:'all',type:'all',sort:'newest',search:''};
  window._catFilterState.search=q;
  renderFilteredCatalogs();
}
function clearCatalogSearch() {
  const el=document.getElementById('catalog-search');
  if(el) el.value='';
  filterCatalogs();
}
function setCatFilter(el,cat) {
  document.querySelectorAll('[data-cat]').forEach(e=>e.classList.remove('active'));
  el.classList.add('active');
  if(!window._catFilterState) window._catFilterState={category:'all',type:'all',sort:'newest',search:''};
  window._catFilterState.category=cat;
  renderFilteredCatalogs();
}
function setTypeFilter(el,type) {
  document.querySelectorAll('[data-type]').forEach(e=>e.classList.remove('active'));
  el.classList.add('active');
  if(!window._catFilterState) window._catFilterState={category:'all',type:'all',sort:'newest',search:''};
  window._catFilterState.type=type.toLowerCase();
  renderFilteredCatalogs();
}
function setSortFilter(el,sort) {
  document.querySelectorAll('[data-sort]').forEach(e=>e.classList.remove('active'));
  el.classList.add('active');
  if(!window._catFilterState) window._catFilterState={category:'all',type:'all',sort:'newest',search:''};
  window._catFilterState.sort=sort;
  renderFilteredCatalogs();
}
function renderFilteredCatalogs() {
  const {category,type,sort,search}=window._catFilterState||{};
  let list=[...allCatalogs];
  if(search) list=list.filter(c=>
    c.title?.toLowerCase().includes(search.toLowerCase())||
    c.description?.toLowerCase().includes(search.toLowerCase())||
    c.tags?.some(t=>t.toLowerCase().includes(search.toLowerCase()))
  );
  if(category&&category!=='all') list=list.filter(c=>c.category?.toLowerCase()===category);
  if(type&&type!=='all') list=list.filter(c=>c.type?.toLowerCase()===type);
  if(sort==='popular')   list.sort((a,b)=>(b.views||0)-(a.views||0));
  if(sort==='price_asc') list.sort((a,b)=>(a.resellerPrice||a.price||0)-(b.resellerPrice||b.price||0));
  if(sort==='price_desc')list.sort((a,b)=>(b.resellerPrice||b.price||0)-(a.resellerPrice||a.price||0));
  const grid=document.getElementById('catalogs-grid');
  const cnt=document.getElementById('cat-count');
  if(grid) grid.innerHTML=list.length?renderProductCards(list):`<div class="empty" style="grid-column:1/-1"><div class="empty-icon">🔍</div><div class="empty-title">No products found</div><button class="btn-outline sm" onclick="clearCatalogSearch()">Clear</button></div>`;
  if(cnt) cnt.textContent=`${list.length} products found`;
}

// ── PRODUCT CARDS RENDERER ────────────────────────────────────────
function renderProductCards(catalogs) {
  if(!catalogs.length) return `<div class="empty" style="grid-column:1/-1"><div class="empty-icon">📦</div><div class="empty-title">No products yet</div></div>`;
  return catalogs.map(c=>{
    const sym   = CURRENCY_SYM[c.currency]||'₨';
    const price = c.resellerPrice||c.price||0;
    const profit= c.resellerPrice>c.price? c.resellerPrice-c.price:0;
    const imgHtml=c.images?.[0]
      ?`<img src="${c.images[0]}" alt="${escapeHtml(c.title)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=product-img-placeholder>📦</div>'" />`
      :`<div class="product-img-placeholder">📦</div>`;
    return `
      <div class="product-card" onclick="navigate('catalog',{id:'${c.id}'})">
        <div class="product-img">
          ${imgHtml}
          <div class="product-badges">
            <span class="product-badge badge-${c.type||'physical'}">${c.type==='digital'?'⚡ Digital':'📦 Physical'}</span>
            ${c.stock<=10&&c.stock>0?`<span class="product-badge" style="background:rgba(249,115,22,0.8);color:#fff">Only ${c.stock} left</span>`:''}
            ${c.stock===0?`<span class="product-badge" style="background:rgba(239,68,68,0.8);color:#fff">Sold Out</span>`:''}
          </div>
          <div class="product-actions">
            <button class="product-action-btn" onclick="event.stopPropagation();shareCatalogById('${c.id}')">📲</button>
            <button class="product-action-btn" onclick="event.stopPropagation();copyLink('${c.id}')">🔗</button>
          </div>
        </div>
        <div class="product-body">
          ${c.category?`<div class="product-cat">📁 ${escapeHtml(c.category)}</div>`:''}
          <div class="product-title">${escapeHtml(c.title)}</div>
          <div class="product-pricing">
            <div>
              ${c.resellerPrice&&c.resellerPrice>c.price?`<div class="product-old-price">${sym}${fmt(c.price)}</div>`:''}
              <div class="product-price">${sym}${fmt(price)}</div>
            </div>
            ${profit>0?`<div class="product-profit">+${sym}${fmt(profit)} profit</div>`:''}
          </div>
          <button class="product-order-btn" onclick="event.stopPropagation();navigate('catalog',{id:'${c.id}',order:true})">🛒 Order Now</button>
        </div>
      </div>`;
  }).join('');
}

function shareCatalogById(id) {
  const catalog = allCatalogs.find(x=>x.id===id);
  if (!catalog) return;
  shareOnWhatsApp(catalog);
}

// ── PRODUCT DETAIL PAGE ───────────────────────────────────────────
async function renderCatalogDetailV3(params={}) {
  const {id, order}=params;
  setContent(`<div class="page"><div style="text-align:center;padding:60px"><div style="font-size:3rem">⏳</div><p style="color:var(--text3)">Loading...</p></div></div>`);
  const c = await getCatalogById(id);
  if (!c) return;
  incrementViews(id);
  const sym   = CURRENCY_SYM[c.currency]||'₨';
  const price = c.resellerPrice||c.price||0;
  const profit= (c.resellerPrice||0)-(c.price||0);
  const images= c.images||[];
  setContent(`
    <div class="page">
      <button onclick="navigate('catalogs')" style="display:flex;align-items:center;gap:4px;color:var(--text3);font-size:0.875rem;margin-bottom:16px">← Back</button>
      <div class="detail-grid">
        <div class="img-gallery">
          <div class="img-main">
            ${images[0]
              ?`<img id="main-img" src="${images[0]}" alt="${escapeHtml(c.title)}" style="width:100%;height:100%;object-fit:cover" onclick="openLightbox(${JSON.stringify(images)},0)" />`
              :`<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:5rem">📦</div>`}
          </div>
          ${images.length>1?`
            <div class="img-thumbs">
              ${images.map((img,i)=>`
                <div class="img-thumb ${i===0?'active':''}" onclick="switchImg('${img}',this)">
                  <img src="${img}" alt="" onclick="openLightbox(${JSON.stringify(images)},${i})" />
                </div>`).join('')}
            </div>`:''}
        </div>
        <div>
          ${c.category?`<div style="font-size:0.75rem;color:var(--blue);margin-bottom:8px">📁 ${c.category}</div>`:''}
          <h1 style="font-size:1.5rem;font-weight:900;line-height:1.3;margin-bottom:16px">${escapeHtml(c.title)}</h1>
          <div class="card" style="margin-bottom:16px">
            <div style="display:flex;align-items:flex-end;gap:12px">
              <div>
                ${c.resellerPrice&&c.resellerPrice>c.price?`<div style="font-size:0.85rem;color:var(--text4);text-decoration:line-through">${sym}${fmt(c.price)}</div>`:''}
                <div style="font-size:2rem;font-weight:900;color:var(--blue)">${sym}${fmt(price)}</div>
              </div>
              ${profit>0?`<div style="margin-left:auto;text-align:right">
                <div style="font-size:0.72rem;color:var(--text3)">Your Profit</div>
                <div style="font-size:1.2rem;font-weight:800;color:var(--green)">+${sym}${fmt(profit)}</div>
              </div>`:''}
            </div>
            <div style="font-size:0.75rem;color:var(--text3);margin-top:8px;display:flex;gap:12px">
              <span>👁 ${c.views||0} views</span>
              ${c.stock>0?`<span style="color:var(--green)">✓ In Stock (${c.stock})</span>`:`<span style="color:var(--red)">Out of Stock</span>`}
              <span class="badge badge-${c.type||'physical'}">${c.type==='digital'?'⚡ Digital':'📦 Physical'}</span>
            </div>
          </div>
          ${c.description?`<div class="card" style="margin-bottom:16px"><div style="font-size:0.8rem;color:var(--text3);font-weight:600;margin-bottom:8px">Description</div><p style="font-size:0.9rem;color:var(--text2);line-height:1.6">${escapeHtml(c.description)}</p></div>`:''}
          ${c.tags?.length?`<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px">${c.tags.map(t=>`<span class="badge" style="background:var(--glass);color:var(--text3)">#${escapeHtml(t)}</span>`).join('')}</div>`:''}
          <div style="display:flex;gap:10px;margin-bottom:12px">
            <button class="btn-neon" style="flex:1;justify-content:center" onclick="showOrderModal('${id}')">🛒 Order Now</button>
            <button class="btn-wa" onclick="shareOnWhatsApp(${JSON.stringify(c).replace(/"/g,'&quot;')})">📲</button>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn-outline" style="flex:1;justify-content:center;font-size:0.8rem" onclick="shareOnWhatsApp(${JSON.stringify(c).replace(/"/g,'&quot;')})">WhatsApp</button>
            <button class="btn-outline" style="flex:1;justify-content:center;font-size:0.8rem" onclick="shareOnFacebook(${JSON.stringify(c).replace(/"/g,'&quot;')})">Facebook</button>
            <button class="btn-outline" style="flex:1;justify-content:center;font-size:0.8rem" onclick="copyLink('${id}')">Copy Link</button>
          </div>
        </div>
      </div>
    </div>
  `);
  if (order) setTimeout(()=>showOrderModal(id, c), 300);
}

function switchImg(src, el) {
  const main=document.getElementById('main-img');
  if (main) main.src=src;
  document.querySelectorAll('.img-thumb').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
}

// ── ORDER MODAL ───────────────────────────────────────────────────
async function showOrderModal(catalogId, catalog) {
  if (!catalog) catalog = await getCatalogById(catalogId);
  if (!catalog) return;
  const sym      = CURRENCY_SYM[catalog.currency]||'₨';
  const price    = catalog.resellerPrice||catalog.price||0;
  const isDigital= catalog.type==='digital';
  openModal(`
    <div class="modal-header">
      <h3>🛒 Place Order</h3>
      <button class="modal-close" onclick="closeModalForce()">✕</button>
    </div>
    <div class="modal-body">
      <div class="card-dark" style="display:flex;align-items:center;gap:12px;padding:12px;margin-bottom:16px">
        ${catalog.images?.[0]?`<img src="${catalog.images[0]}" style="width:48px;height:48px;border-radius:10px;object-fit:cover" />`:'<div style="width:48px;height:48px;border-radius:10px;background:var(--bg3);display:flex;align-items:center;justify-content:center">📦</div>'}
        <div style="flex:1">
          <div style="font-weight:600;font-size:0.9rem">${escapeHtml(catalog.title)}</div>
          <div style="color:var(--blue);font-weight:800;font-size:1.05rem">${sym}${fmt(price)}</div>
        </div>
      </div>
      <div id="order-form">
        ${isDigital?`
          <div class="form-group"><label class="form-label">WhatsApp Number *</label><input class="input" id="o-phone" placeholder="+92 300 1234567" /></div>
          <div class="form-group"><label class="form-label">Email (optional)</label><input class="input" id="o-email" type="email" placeholder="email@example.com" /></div>
          <div class="form-group"><label class="form-label">Username / Game ID (if needed)</label><input class="input" id="o-gameid" placeholder="Your ID" /></div>
          <div class="form-group"><label class="form-label">Notes</label><textarea class="input" id="o-notes" placeholder="Any special instructions..."></textarea></div>
        `:`
          <div class="form-group"><label class="form-label">Full Name *</label><input class="input" id="o-name" placeholder="Muhammad Ahmad" /></div>
          <div class="form-group"><label class="form-label">Phone Number *</label><input class="input" id="o-phone" placeholder="+92 300 1234567" /></div>
          <div class="form-group"><label class="form-label">WhatsApp</label><input class="input" id="o-wa" placeholder="+92 300 1234567" /></div>
          <div class="form-group"><label class="form-label">Full Address *</label><input class="input" id="o-addr" placeholder="House/Street/Area" /></div>
          <div class="form-group"><label class="form-label">City *</label><input class="input" id="o-city" placeholder="Karachi" /></div>
          <div class="form-group"><label class="form-label">Notes</label><textarea class="input" id="o-notes" placeholder="Any special instructions..."></textarea></div>
        `}
        <button class="btn-neon btn-block" style="margin-top:8px" id="place-order-btn"
          onclick="submitOrder('${catalogId}','${escapeHtml(catalog.title)}',${price},'${catalog.currency||'PKR'}',${(catalog.resellerPrice||0)-(catalog.price||0)},'${catalog.type||'physical'}')">
          Confirm Order — ${sym}${fmt(price)}
        </button>
      </div>
    </div>
  `);
}

// ── SUBMIT ORDER — Core logic, referral + earnings all here ───────
async function submitOrder(catalogId, title, price, currency, profit, type) {
  const btn = document.getElementById('place-order-btn');
  if (btn) { btn.disabled=true; btn.textContent='Placing Order...'; }

  // Get referral ref (hash → query → localStorage)
  const rawRef = getActiveRef();

  // Collect form fields
  const buyerPhone    = document.getElementById('o-phone')?.value?.trim()||'';
  const buyerName     = document.getElementById('o-name')?.value?.trim()||'';
  const buyerWhatsapp = document.getElementById('o-wa')?.value?.trim()||buyerPhone;
  const address       = document.getElementById('o-addr')?.value?.trim()||'';
  const city          = document.getElementById('o-city')?.value?.trim()||'';
  const email         = document.getElementById('o-email')?.value?.trim()||'';
  const gameId        = document.getElementById('o-gameid')?.value?.trim()||'';
  const notes         = document.getElementById('o-notes')?.value?.trim()||'';

  // Validation
  if (!buyerPhone) {
    showToast('Please enter phone number','error');
    if (btn){ btn.disabled=false; btn.textContent='Confirm Order'; } return;
  }
  if (type==='physical' && !buyerName) {
    showToast('Please enter your name','error');
    if (btn){ btn.disabled=false; btn.textContent='Confirm Order'; } return;
  }

  try {
    // ── REFERRAL RESOLUTION ───────────────────────────────────────
    let resellerId = null;
    if (rawRef) {
      resellerId = await resolveResellerId(rawRef);
      if (!resellerId) {
        // Code stored in localStorage might be stale — clear it
        localStorage.removeItem('mich_ref');
        console.warn('Referral code not found:', rawRef);
      }
    }

    // ── ORDER DATA ────────────────────────────────────────────────
    const profitAmt = profit > 0 ? profit : 0;
    const orderData = {
      catalogId,
      catalogTitle: title,
      price,
      currency,
      profit:         profitAmt,
      resellerId:     resellerId || null,
      referralCode:   rawRef     || null,
      type,
      buyerPhone,
      buyerName,
      buyerWhatsapp,
      address,
      city,
      email,
      gameId,
      notes,
      buyerId:        currentUser?.uid || null,
    };

    // ── CREATE ORDER ──────────────────────────────────────────────
    const orderId = await createOrder(orderData);

    // ── CREATE EARNING (PENDING) ──────────────────────────────────
    // Earning is created immediately as "pending" when order is placed
    // Admin will mark it "approved" when order is delivered
    if (profitAmt > 0 && resellerId) {
      await createEarning({
        userId:       resellerId,
        orderId,
        catalogTitle: title,
        amount:       profitAmt,
        referralCode: rawRef || null,
        // status is always 'pending' here — set in createEarning()
      });
    }

    closeModalForce();

    // ── SUCCESS MODAL ─────────────────────────────────────────────
    const sym = CURRENCY_SYM[currency]||'₨';
    openModal(`
      <div class="modal-body" style="text-align:center;padding:40px 24px">
        <div style="font-size:4rem;margin-bottom:16px">🎉</div>
        <h3 style="font-size:1.3rem;font-weight:900;margin-bottom:8px">Order Placed!</h3>
        <p style="color:var(--text3);font-size:0.9rem;margin-bottom:8px">
          <strong>${escapeHtml(title)}</strong> — ${sym}${fmt(price)}
        </p>
        <p style="color:var(--text3);font-size:0.85rem;margin-bottom:4px">
          We'll contact you on <strong>${escapeHtml(buyerPhone)}</strong> shortly.
        </p>
        ${profitAmt>0&&resellerId?`
          <div style="background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);border-radius:10px;padding:10px;margin:12px 0">
            <div style="font-size:0.8rem;color:var(--text3)">Commission Earned (Pending)</div>
            <div style="font-size:1.2rem;font-weight:800;color:var(--green)">+₨${fmt(profitAmt)}</div>
          </div>`:''}
        <p style="color:var(--text4);font-size:0.75rem;margin-bottom:24px">
          Order ID: <code>${escapeHtml(orderId)}</code>
        </p>
        <div style="display:flex;gap:10px">
          <button class="btn-outline btn-block" onclick="closeModalForce()">Close</button>
          ${currentUser
            ?`<button class="btn-neon btn-block" onclick="closeModalForce();navigate('orders')">View Orders</button>`
            :`<button class="btn-neon btn-block" onclick="closeModalForce();navigate('auth')">Track Order</button>`}
        </div>
      </div>
    `);
    showToast('Order placed successfully 🎉','success');

  } catch(e) {
    console.error('ORDER ERROR:', e);
    showToast(e?.message||'Failed to place order. Please try again.','error');
  } finally {
    if (btn){ btn.disabled=false; btn.textContent='Confirm Order'; }
  }
}

// ── EARNINGS PAGE ─────────────────────────────────────────────────
async function renderEarnings() {
  if (!currentUser) { navigate('auth'); return; }
  setContent(`<div class="page"><div style="text-align:center;padding:60px"><div style="font-size:2rem">⏳</div><p style="color:var(--text3)">Loading earnings...</p></div></div>`);

  const [earnings, withdrawals, uDoc] = await Promise.all([
    getMyEarnings(currentUser.uid),
    getMyWithdrawals(currentUser.uid),
    getUserDoc(currentUser.uid),
  ]);
  _renderEarningsContent(earnings, withdrawals, uDoc);

  // Real-time listener on earnings
  const unsubEarnings = rtdbOn('earnings', async (val) => {
    const all = val ? Object.entries(val).map(([id,v])=>({ id, ...v })) : [];
    const mine = all.filter(e => e.userId === currentUser?.uid)
                    .sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    const [wds, user] = await Promise.all([
      getMyWithdrawals(currentUser.uid),
      getUserDoc(currentUser.uid),
    ]);
    _renderEarningsContent(mine, wds, user);
  });
  registerListener('earnings', unsubEarnings);
}

function _renderEarningsContent(earnings, withdrawals, uDoc) {
  const total       = earnings.reduce((s,e)=>s+(e.amount||0),0);
  const approved    = earnings.filter(e=>e.status==='approved').reduce((s,e)=>s+(e.amount||0),0);
  const pending     = earnings.filter(e=>e.status==='pending').reduce((s,e)=>s+(e.amount||0),0);
  const withdrawable= uDoc?.withdrawableBalance||0;

  // Chart data — last 7 days
  const days=Array.from({length:7},(_,i)=>{ const d=new Date(); d.setDate(d.getDate()-6+i); return d; });
  const chartLabels=days.map(d=>d.toLocaleDateString('en',{weekday:'short'}));
  const chartData=days.map(d=>earnings.filter(e=>{
    if (!e.createdAt) return false;
    return new Date(e.createdAt).toDateString()===d.toDateString();
  }).reduce((s,e)=>s+(e.amount||0),0));

  if (!document.getElementById('app-content')) return;
  setContent(`
    <div class="page">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
        <div>
          <h1 class="section-title" style="font-size:1.4rem">My <span class="gradient-text">Earnings</span></h1>
          <p style="color:var(--text3);font-size:0.85rem;margin-top:4px">Track income &amp; withdrawals</p>
        </div>
        ${withdrawable>=500?`<button class="btn-neon sm" onclick="showWithdrawModal(${withdrawable})">↑ Withdraw</button>`:''}
      </div>

      <div class="balance-card">
        <div class="balance-label">Withdrawable Balance</div>
        <div class="balance-amount">₨${fmt(withdrawable)}</div>
        <div class="balance-sub">
          <div class="balance-sub-item"><div class="balance-sub-val" style="color:var(--green)">₨${fmt(approved)}</div><div class="balance-sub-label">Approved</div></div>
          <div class="balance-sub-item"><div class="balance-sub-val" style="color:var(--yellow)">₨${fmt(pending)}</div><div class="balance-sub-label">Pending</div></div>
          <div class="balance-sub-item"><div class="balance-sub-val" style="color:var(--blue)">₨${fmt(total)}</div><div class="balance-sub-label">Total Earned</div></div>
        </div>
        ${withdrawable<500?`<p style="font-size:0.75rem;color:var(--text4);margin-top:12px">Minimum withdrawal: ₨500</p>`:''}
      </div>

      <div class="stats-grid" style="margin-bottom:24px">
        ${[
          {icon:'💰',label:'Total Earned',val:`₨${fmt(total)}`,color:'var(--blue)'},
          {icon:'✅',label:'Approved',val:`₨${fmt(approved)}`,color:'var(--green)'},
          {icon:'⏳',label:'Pending',val:`₨${fmt(pending)}`,color:'var(--yellow)'},
          {icon:'📊',label:'Withdrawals',val:withdrawals.length,color:'var(--purple)'},
        ].map(s=>`
          <div class="card stat-card">
            <div class="stat-icon">${s.icon}</div>
            <div class="stat-value" style="color:${s.color}">${s.val}</div>
            <div class="stat-label">${s.label}</div>
          </div>`).join('')}
      </div>

      <div class="card" style="margin-bottom:24px;padding:20px">
        <div style="font-weight:600;color:var(--text3);margin-bottom:16px;font-size:0.9rem">📈 Earnings — Last 7 Days</div>
        <canvas id="earnings-chart" height="160"></canvas>
      </div>

      ${withdrawals.length?`
      <div class="card" style="margin-bottom:24px">
        <div style="font-weight:700;margin-bottom:14px">💸 Withdrawal History</div>
        ${withdrawals.map(w=>`
          <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border2)">
            <div>
              <div style="font-weight:600;font-size:0.9rem">₨${fmt(w.amount)} via ${escapeHtml(w.method)}</div>
              <div style="font-size:0.75rem;color:var(--text3)">${escapeHtml(w.accountNumber||'')} · ${timeSince(w.createdAt)}</div>
            </div>
            <span class="badge badge-${w.status||'pending'}">${w.status||'pending'}</span>
          </div>`).join('')}
      </div>`:''}

      <div class="card">
        <div style="font-weight:700;margin-bottom:14px">📋 Earnings History</div>
        ${earnings.length===0
          ?`<div class="empty"><div class="empty-icon">💸</div><div class="empty-title">No earnings yet</div><div class="empty-text">Start sharing products to earn!</div><button class="btn-neon sm" onclick="navigate('catalogs')">Browse Products</button></div>`
          :earnings.map(e=>`
            <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border2)">
              <div>
                <div style="font-weight:600;font-size:0.9rem">${escapeHtml(e.catalogTitle||'Product')}</div>
                <div style="font-size:0.75rem;color:var(--text3)">${timeSince(e.createdAt)}</div>
              </div>
              <div style="text-align:right">
                <div style="font-weight:800;color:var(--green)">+₨${fmt(e.amount)}</div>
                <span class="badge badge-${e.status||'pending'}">${e.status||'pending'}</span>
              </div>
            </div>`).join('')}
      </div>
    </div>
  `);

  // Draw chart
  const ctx = document.getElementById('earnings-chart');
  if (ctx && window.Chart) {
    new Chart(ctx, {
      type:'line',
      data:{ labels:chartLabels, datasets:[{ data:chartData, borderColor:'#00d4ff', backgroundColor:'rgba(0,212,255,0.1)', borderWidth:2, tension:0.4, fill:true, pointBackgroundColor:'#00d4ff', pointRadius:4 }] },
      options:{ plugins:{legend:{display:false}}, scales:{ x:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'rgba(255,255,255,0.4)',font:{size:11}}}, y:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'rgba(255,255,255,0.4)',font:{size:11}}} }, responsive:true, maintainAspectRatio:false }
    });
  }
}

function showWithdrawModal(balance) {
  openModal(`
    <div class="modal-header"><h3>↑ Withdraw Funds</h3><button class="modal-close" onclick="closeModalForce()">✕</button></div>
    <div class="modal-body">
      <div class="card-dark" style="display:flex;justify-content:space-between;align-items:center;padding:12px;margin-bottom:16px">
        <span style="color:var(--text3);font-size:0.875rem">Available Balance</span>
        <span style="font-weight:800;color:var(--green)">₨${fmt(balance)}</span>
      </div>
      <div class="form-group"><label class="form-label">Amount (min ₨500)</label><input class="input" id="wd-amount" type="number" placeholder="Enter amount" min="500" max="${balance}" /></div>
      <div class="form-group"><label class="form-label">Payment Method</label>
        <select class="input" id="wd-method">${METHODS.map(m=>`<option value="${m}">${m}</option>`).join('')}</select>
      </div>
      <div class="form-group"><label class="form-label">Account / Wallet Number</label><input class="input" id="wd-account" placeholder="03001234567" /></div>
      <div class="form-group"><label class="form-label">Account Holder Name</label><input class="input" id="wd-name" placeholder="Muhammad Ahmad" /></div>
      <button class="btn-neon btn-block" id="wd-submit-btn" onclick="submitWithdraw(${balance})">Submit Withdrawal</button>
    </div>
  `);
}

async function submitWithdraw(balance) {
  const amount  = parseFloat(document.getElementById('wd-amount')?.value);
  const method  = document.getElementById('wd-method')?.value;
  const account = document.getElementById('wd-account')?.value;
  const name    = document.getElementById('wd-name')?.value;
  if (!amount||amount<500){ showToast('Minimum ₨500','error'); return; }
  if (amount>balance)     { showToast('Insufficient balance','error'); return; }
  if (!account)           { showToast('Enter account number','error'); return; }
  const btn=document.getElementById('wd-submit-btn');
  if (btn){ btn.disabled=true; btn.textContent='Submitting...'; }
  try {
    await createWithdrawal({ userId:currentUser.uid, userName:userProfile?.name, amount, method, accountNumber:account, accountName:name });
    closeModalForce();
    showToast('Withdrawal request submitted! ✅','success');
    renderEarnings();
  } catch { showToast('Failed. Try again.','error'); if(btn){btn.disabled=false;btn.textContent='Submit';} }
}

// ── ORDERS PAGE ───────────────────────────────────────────────────
async function renderOrders() {
  if (!currentUser){ navigate('auth'); return; }
  setContent(`<div class="page"><div style="text-align:center;padding:60px"><div style="font-size:2rem">⏳</div></div></div>`);
  const orders = await getMyOrders(currentUser.uid);

  const renderList=(status)=>{
    const list=status==='all'?orders:orders.filter(o=>o.status===status);
    if(!list.length) return `<div class="empty"><div class="empty-icon">🛒</div><div class="empty-title">No ${status!=='all'?status+' ':''}orders</div></div>`;
    return list.map(o=>`
      <div class="order-card" onclick="showOrderDetail(${JSON.stringify(o).replace(/"/g,'&quot;')})">
        <div class="order-top">
          <div class="order-title">${escapeHtml(o.catalogTitle||'Product')}</div>
          <span class="badge badge-${o.status||'pending'}">${o.status||'pending'}</span>
        </div>
        <div class="order-bottom">
          <span class="order-meta">👤 ${escapeHtml(o.buyerName||o.buyerPhone||'N/A')}</span>
          ${o.city?`<span class="order-meta">📍 ${escapeHtml(o.city)}</span>`:''}
          <span class="order-meta">🕐 ${timeSince(o.createdAt)}</span>
          <span class="order-price">₨${fmt(o.price)}</span>
        </div>
        ${o.profit>0?`<div class="order-profit">+₨${fmt(o.profit)} your profit</div>`:''}
      </div>`).join('');
  };

  setContent(`
    <div class="page">
      <div style="margin-bottom:20px">
        <h1 class="section-title" style="font-size:1.4rem">My <span class="gradient-text">Orders</span></h1>
        <p style="color:var(--text3);font-size:0.85rem;margin-top:4px">${orders.length} total orders</p>
      </div>
      <div class="filter-chips" style="margin-bottom:16px">
        ${['all','pending','approved','processing','shipped','delivered','cancelled'].map(s=>
          `<span class="filter-chip ${s==='all'?'active':''}" onclick="filterOrders(this,'${s}')">${s==='all'?'All':s.charAt(0).toUpperCase()+s.slice(1)}</span>`
        ).join('')}
      </div>
      <div class="card" id="orders-list" style="padding:0;overflow:hidden">
        ${renderList('all')}
      </div>
    </div>
  `);
  window._ordersData=orders;
}

function filterOrders(el,status) {
  document.querySelectorAll('.filter-chips .filter-chip').forEach(e=>e.classList.remove('active'));
  el.classList.add('active');
  const list=document.getElementById('orders-list');
  const orders=window._ordersData||[];
  const filtered=status==='all'?orders:orders.filter(o=>o.status===status);
  if (!list) return;
  if (!filtered.length){ list.innerHTML=`<div class="empty"><div class="empty-icon">🛒</div><div class="empty-title">No ${status} orders</div></div>`; return; }
  list.innerHTML=filtered.map(o=>`
    <div class="order-card" onclick="showOrderDetail(${JSON.stringify(o).replace(/"/g,'&quot;')})">
      <div class="order-top"><div class="order-title">${escapeHtml(o.catalogTitle||'Product')}</div><span class="badge badge-${o.status||'pending'}">${o.status||'pending'}</span></div>
      <div class="order-bottom"><span class="order-meta">👤 ${escapeHtml(o.buyerName||o.buyerPhone||'N/A')}</span><span class="order-price">₨${fmt(o.price)}</span></div>
      ${o.profit>0?`<div class="order-profit">+₨${fmt(o.profit)} profit</div>`:''}
    </div>`).join('');
}

function showOrderDetail(o) {
  openModal(`
    <div class="modal-header"><h3>Order Details</h3><button class="modal-close" onclick="closeModalForce()">✕</button></div>
    <div class="modal-body">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div style="font-weight:700;font-size:1.05rem">${escapeHtml(o.catalogTitle||'Product')}</div>
        <span class="badge badge-${o.status||'pending'}">${o.status||'pending'}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:0.875rem">
        <div class="card-dark"><div style="color:var(--text3);font-size:0.72rem;margin-bottom:4px">Price</div><div style="font-weight:700;color:var(--blue)">₨${fmt(o.price)}</div></div>
        ${o.profit>0?`<div class="card-dark"><div style="color:var(--text3);font-size:0.72rem;margin-bottom:4px">Your Profit</div><div style="font-weight:700;color:var(--green)">+₨${fmt(o.profit)}</div></div>`:'<div></div>'}
        ${o.buyerName?`<div class="card-dark"><div style="color:var(--text3);font-size:0.72rem;margin-bottom:4px">Customer</div><div style="font-weight:600">${escapeHtml(o.buyerName)}</div></div>`:''}
        ${o.buyerPhone?`<div class="card-dark"><div style="color:var(--text3);font-size:0.72rem;margin-bottom:4px">Phone</div><div style="font-weight:600">${escapeHtml(o.buyerPhone)}</div></div>`:''}
        ${o.address?`<div class="card-dark" style="grid-column:1/-1"><div style="color:var(--text3);font-size:0.72rem;margin-bottom:4px">Address</div><div style="font-weight:600">${escapeHtml(o.address)}${o.city?', '+escapeHtml(o.city):''}</div></div>`:''}
        ${o.notes?`<div class="card-dark" style="grid-column:1/-1"><div style="color:var(--text3);font-size:0.72rem;margin-bottom:4px">Notes</div><div>${escapeHtml(o.notes)}</div></div>`:''}
      </div>
      <div style="margin-top:16px;font-size:0.75rem;color:var(--text4)">Placed: ${timeSince(o.createdAt)}</div>
      ${o.buyerPhone?`<div style="display:flex;gap:8px;margin-top:16px"><a href="https://wa.me/${encodeURIComponent(o.buyerPhone.replace(/\D/g,''))}" target="_blank" class="btn-wa btn-block">📲 WhatsApp</a></div>`:''}
    </div>
  `);
}

// ── CLIENTS PAGE ──────────────────────────────────────────────────
async function renderClients() {
  if (!currentUser){ navigate('auth'); return; }
  setContent(`<div class="page"><div style="text-align:center;padding:60px"><div style="font-size:2rem">⏳</div></div></div>`);
  const clients = await getClients(currentUser.uid);
  setContent(`
    <div class="page">
      <div style="margin-bottom:20px">
        <h1 class="section-title" style="font-size:1.4rem">My <span class="gradient-text">Clients</span></h1>
        <p style="color:var(--text3);font-size:0.85rem;margin-top:4px">${clients.length} clients</p>
      </div>
      ${clients.length===0
        ?`<div class="empty"><div class="empty-icon">👥</div><div class="empty-title">No clients yet</div><div class="empty-text">Clients appear here when orders come through your links</div></div>`
        :`<div class="card" style="padding:0;overflow:hidden">
            ${clients.map(c=>`
              <div class="list-item">
                <div class="list-avatar">${escapeHtml((c.name||'C').charAt(0))}</div>
                <div class="list-info">
                  <div class="list-name">${escapeHtml(c.name||'Client')}</div>
                  <div class="list-sub">${escapeHtml(c.phone||c.email||'—')} · ${c.orders||0} orders</div>
                </div>
                <div class="list-right">
                  <div style="font-weight:700;color:var(--blue)">₨${fmt(c.totalSpent)}</div>
                  <div style="font-size:0.72rem;color:var(--text3)">total</div>
                </div>
              </div>`).join('')}
          </div>`}
    </div>
  `);
}

// ── PROFILE PAGE ──────────────────────────────────────────────────
async function renderProfile() {
  if (!currentUser){ navigate('auth'); return; }
  const p = userProfile||{};
  const referralLink = `${APP_URL}/?ref=${p.referralCode||''}`;
  setContent(`
    <div class="page">
      <div class="card profile-header" style="margin-bottom:20px">
        <div id="profile-photo-uploader-container" style="display:flex;justify-content:center;margin-bottom:12px"></div>
        <div class="profile-name">${escapeHtml(p.name||'User')}</div>
        <span class="profile-role role-${p.role||'customer'}">${p.role||'customer'}</span>
        <div style="font-size:0.85rem;color:var(--text3);margin-top:8px">${escapeHtml(p.email||currentUser.email||'')}</div>
      </div>
      <div class="stats-grid" style="margin-bottom:20px">
        <div class="card stat-card"><div class="stat-icon">💰</div><div class="stat-value" style="color:var(--blue)">₨${fmt(p.earnings)}</div><div class="stat-label">Total Earned</div></div>
        <div class="card stat-card"><div class="stat-icon">✅</div><div class="stat-value" style="color:var(--green)">₨${fmt(p.withdrawableBalance)}</div><div class="stat-label">Withdrawable</div></div>
        <div class="card stat-card"><div class="stat-icon">🛒</div><div class="stat-value" style="color:var(--purple)">${p.totalOrders||0}</div><div class="stat-label">Total Orders</div></div>
        <div class="card stat-card"><div class="stat-icon">🔗</div><div class="stat-value" style="color:var(--orange)">${p.referralCode||'—'}</div><div class="stat-label">Ref Code</div></div>
      </div>
      <div class="referral-box" style="margin-bottom:20px">
        <div style="font-weight:700;margin-bottom:4px">🎁 Your Referral Link</div>
        <div style="font-size:0.8rem;color:var(--text3);margin-bottom:12px">Share and earn on every order</div>
        <div class="referral-code">${p.referralCode||'—'}</div>
        <div style="display:flex;gap:8px">
          <button class="btn-outline sm referral-btn" onclick="navigator.clipboard.writeText('${referralLink}');showToast('Copied!','success')">Copy Link</button>
          <button class="btn-wa referral-btn" onclick="window.open('https://wa.me/?text=${encodeURIComponent(`🤑 Join MICH Digital Shop! Use my link: ${referralLink}`)}','_blank')">Share on WhatsApp</button>
        </div>
      </div>
      <div class="card" style="margin-bottom:20px">
        <div style="font-weight:700;margin-bottom:16px">✏️ Edit Profile</div>
        <div class="form-group"><label class="form-label">Full Name</label><input class="input" id="prof-name" value="${escapeHtml(p.name||'')}" /></div>
        <div class="form-group"><label class="form-label">Phone Number</label><input class="input" id="prof-phone" value="${escapeHtml(p.phone||'')}" /></div>
        <div class="form-group"><label class="form-label">WhatsApp</label><input class="input" id="prof-wa" value="${escapeHtml(p.whatsapp||'')}" /></div>
        <div class="form-group"><label class="form-label">Address</label><textarea class="input" id="prof-addr">${escapeHtml(p.address||'')}</textarea></div>
        <button class="btn-neon btn-block" onclick="saveProfile()" id="save-prof-btn">Save Changes</button>
      </div>
      <div class="card" style="border-color:rgba(239,68,68,0.2)">
        <div style="font-weight:700;margin-bottom:12px;color:var(--red)">⚠️ Account</div>
        <button class="btn-red btn-block" onclick="logoutUser()">🚪 Logout</button>
      </div>
    </div>
  `);
  renderProfilePhotoUploader('profile-photo-uploader-container', p.photo||'', async (newUrl)=>{
    await updateUserDoc(currentUser.uid, { photo: newUrl });
    userProfile = await getUserDoc(currentUser.uid);
    updateNavUI();
  });
}

async function saveProfile() {
  const btn = document.getElementById('save-prof-btn');
  if (btn){ btn.disabled=true; btn.textContent='Saving...'; }
  try {
    await updateUserDoc(currentUser.uid, {
      name:     document.getElementById('prof-name')?.value||'',
      phone:    document.getElementById('prof-phone')?.value||'',
      whatsapp: document.getElementById('prof-wa')?.value||'',
      address:  document.getElementById('prof-addr')?.value||'',
    });
    userProfile = await getUserDoc(currentUser.uid);
    showToast('Profile saved! ✅','success');
    updateNavUI();
  } catch { showToast('Failed to save','error'); }
  if (btn){ btn.disabled=false; btn.textContent='Save Changes'; }
}

// ── AUTH PAGE ─────────────────────────────────────────────────────
function renderAuth() {
  setContent(`
    <div class="auth-page">
      <div class="auth-card">
        <div class="auth-logo">
          <img src="https://i.ibb.co/twVpRFKh/file-0000000018807208a673a881d0f0e953.png" alt="MICH" />
          <h1 class="gradient-text">MICH Digital Shop</h1>
          <p>Pakistan's #1 Reseller Platform</p>
        </div>
        <div class="card">
          <div class="tabs" id="auth-tabs">
            <button class="tab-btn active" id="tab-login" onclick="switchAuthTab('login')">Sign In</button>
            <button class="tab-btn"        id="tab-signup" onclick="switchAuthTab('signup')">Create Account</button>
          </div>
          <button class="google-btn" onclick="handleGoogleLogin()">
            <svg class="google-icon" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            Continue with Google
          </button>
          <div class="divider"><div class="divider-line"></div><span class="divider-text">or</span><div class="divider-line"></div></div>
          <div id="login-form">
            <div class="form-group"><label class="form-label">Email</label><input class="input" id="login-email" type="email" placeholder="you@email.com" /></div>
            <div class="form-group"><label class="form-label">Password</label><input class="input" id="login-pass" type="password" placeholder="Password" /></div>
            <button class="btn-neon btn-block" id="login-btn-main" onclick="handleEmailLogin()">Sign In →</button>
            <button style="width:100%;text-align:center;color:var(--text3);font-size:0.8rem;margin-top:12px" onclick="handleForgotPassword()">Forgot Password?</button>
          </div>
          <div id="signup-form" class="hidden">
            <div class="form-group"><label class="form-label">Full Name</label><input class="input" id="signup-name" placeholder="Muhammad Ahmad" /></div>
            <div class="form-group"><label class="form-label">Email</label><input class="input" id="signup-email" type="email" placeholder="you@email.com" /></div>
            <div class="form-group"><label class="form-label">Password (min 6 chars)</label><input class="input" id="signup-pass" type="password" placeholder="Create password" minlength="6" /></div>
            <div class="form-group">
              <label class="form-label">Join as</label>
              <div class="role-cards">
                ${[{v:'reseller',icon:'🏪',label:'Reseller'},{v:'marketer',icon:'📢',label:'Marketer'},{v:'customer',icon:'🛍️',label:'Customer'}].map(r=>`
                  <div class="role-card ${r.v==='customer'?'active':''}" id="role-${r.v}" onclick="selectRole('${r.v}')">
                    <div class="role-card-icon">${r.icon}</div>
                    <div class="role-card-label">${r.label}</div>
                  </div>`).join('')}
              </div>
            </div>
            <button class="btn-neon btn-block" id="signup-btn-main" onclick="handleEmailSignup()">Create Account 🚀</button>
          </div>
        </div>
        <p style="text-align:center;color:var(--text4);font-size:0.75rem;margin-top:16px">By continuing you agree to our Terms &amp; Privacy Policy</p>
      </div>
    </div>
  `);
}

function switchAuthTab(t) {
  document.getElementById('tab-login').classList.toggle('active',t==='login');
  document.getElementById('tab-signup').classList.toggle('active',t==='signup');
  document.getElementById('login-form').classList.toggle('hidden',t!=='login');
  document.getElementById('signup-form').classList.toggle('hidden',t!=='signup');
}
function selectRole(role) {
  document.querySelectorAll('.role-card').forEach(el=>el.classList.remove('active'));
  document.getElementById('role-'+role)?.classList.add('active');
  window._selectedRole=role;
}
async function handleGoogleLogin() {
  const res=await loginWithGoogle();
  if (res.success) navigate('home');
}
async function handleEmailLogin() {
  const email=document.getElementById('login-email')?.value;
  const pass=document.getElementById('login-pass')?.value;
  if (!email||!pass){ showToast('Enter email and password','error'); return; }
  const btn=document.getElementById('login-btn-main');
  if (btn){ btn.disabled=true; btn.textContent='Signing in...'; }
  const res=await loginWithEmail(email,pass);
  if (res.success) navigate('home');
  else if (btn){ btn.disabled=false; btn.textContent='Sign In →'; }
}
async function handleEmailSignup() {
  const name =document.getElementById('signup-name')?.value;
  const email=document.getElementById('signup-email')?.value;
  const pass =document.getElementById('signup-pass')?.value;
  const role =window._selectedRole||'customer';
  if (!name||!email||!pass){ showToast('Fill all fields','error'); return; }
  if (pass.length<6){ showToast('Password too short','error'); return; }
  const btn=document.getElementById('signup-btn-main');
  if (btn){ btn.disabled=true; btn.textContent='Creating...'; }
  const res=await signUpWithEmail(name,email,pass,role);
  if (res.success) navigate('home');
  else if (btn){ btn.disabled=false; btn.textContent='Create Account 🚀'; }
}
function handleForgotPassword() {
  const email=document.getElementById('login-email')?.value;
  if (!email){ showToast('Enter your email first','error'); return; }
  resetPassword(email);
}

// ════════════════════════════════════════════════════════════════
// ADMIN PANEL
// ════════════════════════════════════════════════════════════════

async function renderAdmin() {
  if (!currentUser||userProfile?.role!=='admin') {
    setContent(`<div class="page"><div class="empty"><div class="empty-icon">🔒</div><div class="empty-title">Admin Only</div></div></div>`);
    return;
  }
  setContent(`<div class="page"><div style="text-align:center;padding:60px"><div style="font-size:2rem">⏳</div><p style="color:var(--text3)">Loading admin...</p></div></div>`);

  const [orders, users, withdrawals] = await Promise.all([getAllOrders(), getAllUsers(), getAllWithdrawals()]);
  const catalogs = await getCatalogs(100);
  const pendingOrders = orders.filter(o=>o.status==='pending').length;
  const pendingWDs    = withdrawals.filter(w=>w.status==='pending').length;

  window._adminOrders = orders;
  window._adminUsers  = users;
  window._adminWDs    = withdrawals;
  window._adminCats   = catalogs;

  setContent(`
    <div class="page">
      <div style="margin-bottom:24px">
        <h1 class="section-title" style="font-size:1.4rem">⚙ <span class="gradient-text">Admin Panel</span></h1>
        <p style="color:var(--text3);font-size:0.85rem;margin-top:4px">Manage your entire platform</p>
      </div>

      <!-- Stats -->
      <div class="admin-grid" style="margin-bottom:24px">
        ${[
          {icon:'👥',label:'Total Users',val:users.length,color:'var(--blue)'},
          {icon:'🛒',label:'Total Orders',val:orders.length,color:'var(--purple)'},
          {icon:'⏳',label:'Pending Orders',val:pendingOrders,color:'var(--yellow)'},
          {icon:'💸',label:'Pending WDs',val:pendingWDs,color:'var(--orange)'},
        ].map(s=>`
          <div class="card" style="text-align:center;padding:16px">
            <div style="font-size:1.5rem">${s.icon}</div>
            <div style="font-size:1.4rem;font-weight:900;color:${s.color}">${s.val}</div>
            <div style="font-size:0.75rem;color:var(--text3)">${s.label}</div>
          </div>`).join('')}
      </div>

      <!-- Tabs -->
      <div class="tabs" style="margin-bottom:16px" id="admin-tabs">
        <button class="tab-btn active" onclick="switchAdminTab('orders',this)">📋 Orders</button>
        <button class="tab-btn"        onclick="switchAdminTab('products',this)">📦 Products</button>
        <button class="tab-btn"        onclick="switchAdminTab('users',this)">👥 Users</button>
        <button class="tab-btn"        onclick="switchAdminTab('withdrawals',this)">💸 Withdrawals</button>
      </div>
      <div id="admin-content">
        ${renderAdminOrders(orders)}
      </div>
    </div>
  `);
}

function switchAdminTab(tab, el) {
  document.querySelectorAll('#admin-tabs .tab-btn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  const content = document.getElementById('admin-content');
  if (!content) return;
  if (tab==='orders')      content.innerHTML=renderAdminOrders(window._adminOrders||[]);
  if (tab==='products')    content.innerHTML=renderAdminProductsV3(window._adminCats||[]);
  if (tab==='users')       content.innerHTML=renderAdminUsers(window._adminUsers||[]);
  if (tab==='withdrawals') content.innerHTML=renderAdminWithdrawals(window._adminWDs||[]);
}

function renderAdminOrders(orders) {
  if (!orders.length) return `<div class="empty"><div class="empty-icon">🛒</div><div class="empty-title">No orders</div></div>`;
  return `
    <div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap">
      ${['all','pending','approved','processing','shipped','delivered','cancelled'].map(s=>
        `<span class="filter-chip ${s==='all'?'active':''}" onclick="filterAdminOrders(this,'${s}')">${s==='all'?'All':s.charAt(0).toUpperCase()+s.slice(1)}</span>`
      ).join('')}
    </div>
    <div id="admin-orders-list">
      ${_renderAdminOrdersList(orders,'all')}
    </div>`;
}

window._adminOrdersAll = [];
function filterAdminOrders(el,status) {
  document.querySelectorAll('#admin-content .filter-chip').forEach(e=>e.classList.remove('active'));
  el.classList.add('active');
  const list = document.getElementById('admin-orders-list');
  if (list) list.innerHTML=_renderAdminOrdersList(window._adminOrders||[],status);
}

function _renderAdminOrdersList(orders,status) {
  const filtered=status==='all'?orders:orders.filter(o=>o.status===status);
  if (!filtered.length) return `<div class="empty"><div class="empty-icon">🛒</div><div class="empty-title">No ${status} orders</div></div>`;
  return filtered.map(o=>`
    <div class="order-card" style="cursor:default">
      <div class="order-top">
        <div class="order-title">${escapeHtml(o.catalogTitle||'Product')}</div>
        <span class="badge badge-${o.status||'pending'}">${o.status||'pending'}</span>
      </div>
      <div class="order-bottom">
        <span class="order-meta">👤 ${escapeHtml(o.buyerName||o.buyerPhone||'N/A')}</span>
        ${o.city?`<span class="order-meta">📍 ${escapeHtml(o.city)}</span>`:''}
        ${o.resellerId?`<span class="order-meta">🔗 Has Referral</span>`:''}
        <span class="order-meta">🕐 ${timeSince(o.createdAt)}</span>
        <span class="order-price">₨${fmt(o.price)}</span>
      </div>
      ${o.profit>0?`<div class="order-profit">+₨${fmt(o.profit)} commission</div>`:''}
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn-outline sm" onclick="showAdminOrderDetail('${o.id}')">View Details</button>
        <button class="btn-neon sm" onclick="showSetStatusModal('${o.id}','${o.status||'pending'}')">Change Status</button>
        ${o.buyerPhone?`<a href="https://wa.me/${encodeURIComponent(o.buyerPhone.replace(/\D/g,''))}" target="_blank" class="btn-wa sm">📲 WA</a>`:''}
      </div>
    </div>`).join('');
}

async function showAdminOrderDetail(orderId) {
  const orders = window._adminOrders||[];
  const o = orders.find(x=>x.id===orderId);
  if (!o) return;
  openModal(`
    <div class="modal-header"><h3>Order: ${escapeHtml(o.catalogTitle||'Product')}</h3><button class="modal-close" onclick="closeModalForce()">✕</button></div>
    <div class="modal-body">
      <div style="display:grid;gap:8px;font-size:0.875rem">
        <div class="card-dark"><b>Status:</b> <span class="badge badge-${o.status||'pending'}">${o.status||'pending'}</span></div>
        <div class="card-dark"><b>Price:</b> ₨${fmt(o.price)}</div>
        ${o.profit>0?`<div class="card-dark"><b>Commission:</b> <span style="color:var(--green)">+₨${fmt(o.profit)}</span></div>`:''}
        ${o.buyerName?`<div class="card-dark"><b>Customer:</b> ${escapeHtml(o.buyerName)}</div>`:''}
        ${o.buyerPhone?`<div class="card-dark"><b>Phone:</b> ${escapeHtml(o.buyerPhone)}</div>`:''}
        ${o.address?`<div class="card-dark"><b>Address:</b> ${escapeHtml(o.address)}${o.city?', '+escapeHtml(o.city):''}</div>`:''}
        ${o.notes?`<div class="card-dark"><b>Notes:</b> ${escapeHtml(o.notes)}</div>`:''}
        ${o.resellerId?`<div class="card-dark"><b>Reseller UID:</b> <code style="font-size:0.7rem">${escapeHtml(o.resellerId)}</code></div>`:''}
        <div class="card-dark"><b>Order ID:</b> <code style="font-size:0.7rem">${escapeHtml(o.id)}</code></div>
        <div class="card-dark"><b>Placed:</b> ${timeSince(o.createdAt)}</div>
      </div>
      <div style="margin-top:16px">
        <button class="btn-neon btn-block" onclick="showSetStatusModal('${o.id}','${o.status||'pending'}')">Change Status</button>
      </div>
    </div>
  `);
}

function showSetStatusModal(id, currentStatus) {
  const statuses=['pending','approved','processing','shipped','delivered','cancelled'];
  openModal(`
    <div class="modal-header"><h3>Update Order Status</h3><button class="modal-close" onclick="closeModalForce()">✕</button></div>
    <div class="modal-body">
      <p style="color:var(--text3);font-size:0.85rem;margin-bottom:16px">
        Current: <span class="badge badge-${currentStatus}">${currentStatus}</span>
        <br><span style="font-size:0.75rem;color:var(--text4)">⭐ Setting to "delivered" will approve reseller earnings</span>
      </p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${statuses.map(s=>`
          <button class="btn-outline ${s===currentStatus?'active':''}" style="justify-content:center;padding:12px"
            onclick="setOrderStatus('${id}','${s}')">
            <span class="badge badge-${s}">${s}</span>
          </button>`).join('')}
      </div>
    </div>
  `);
}

// ── SET ORDER STATUS + APPROVE EARNINGS ───────────────────────────
async function setOrderStatus(id, status) {
  try {
    // Update order status
    await rtdbUpdate(`orders/${id}`, { status, updatedAt: nowTs() });

    // If delivered → approve all pending earnings for this order + credit reseller balance
    if (status==='delivered') {
      const allEarnings = await rtdbGet('earnings');
      if (allEarnings) {
        const updates = {};
        for (const [eid, earning] of Object.entries(allEarnings)) {
          if (earning.orderId===id && earning.status==='pending') {
            // Mark earning approved
            updates[`earnings/${eid}/status`]    = 'approved';
            updates[`earnings/${eid}/updatedAt`] = nowTs();
            // Credit reseller balance atomically via RTDB multi-path update
            if (earning.userId) {
              const user = await rtdbGet(`users/${earning.userId}`);
              if (user) {
                updates[`users/${earning.userId}/withdrawableBalance`] =
                  (user.withdrawableBalance||0) + (earning.amount||0);
                updates[`users/${earning.userId}/earnings`] =
                  (user.earnings||0) + (earning.amount||0);
                updates[`users/${earning.userId}/updatedAt`] = nowTs();
              }
            }
          }
        }
        if (Object.keys(updates).length) {
          await rdb.ref('/').update(updates);
        }
      }
    }

    showToast(`Order marked as ${status}! ✅`,'success');
    closeModalForce();

    // Refresh admin orders list
    const orders = await getAllOrders();
    window._adminOrders = orders;
    const el = document.getElementById('admin-orders-list');
    if (el) el.innerHTML = _renderAdminOrdersList(orders, 'all');

  } catch(e) {
    console.error('setOrderStatus error:', e);
    showToast('Failed to update: '+e.message,'error');
  }
}

function renderAdminProductsV3(cats) {
  return `
    <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
      <button class="btn-neon sm" onclick="showAddProductModal()">➕ Add Product</button>
    </div>
    ${!cats.length?`<div class="empty"><div class="empty-icon">📦</div><div class="empty-title">No products</div></div>`
    :cats.map(c=>`
      <div class="order-card" style="cursor:default">
        <div class="order-top">
          <div class="order-title">${escapeHtml(c.title)}</div>
          <span class="badge badge-${c.type||'physical'}">${c.type==='digital'?'⚡ Digital':'📦 Physical'}</span>
        </div>
        <div class="order-bottom">
          <span class="order-meta">₨${fmt(c.price)}</span>
          ${c.resellerPrice>c.price?`<span class="order-meta" style="color:var(--green)">+₨${fmt(c.resellerPrice-c.price)} profit</span>`:''}
          <span class="order-meta">👁 ${c.views||0}</span>
          <span class="order-meta">📦 ${c.stock||0} stock</span>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn-outline sm" onclick="showEditProductModal('${c.id}')">✏️ Edit</button>
          <button class="btn-red sm" onclick="confirmDeleteProduct('${c.id}')">🗑 Delete</button>
        </div>
      </div>`).join('')}`;
}

function renderAdminUsers(users) {
  if (!users.length) return `<div class="empty"><div class="empty-icon">👥</div><div class="empty-title">No users</div></div>`;
  return users.map(u=>`
    <div class="list-item" style="border-bottom:1px solid var(--border2)">
      <div class="list-avatar">${(u.name||u.email||'U').charAt(0).toUpperCase()}</div>
      <div class="list-info">
        <div class="list-name">${escapeHtml(u.name||'User')}</div>
        <div class="list-sub">${escapeHtml(u.email||'')} · <span class="badge badge-${u.role||'customer'}">${u.role||'customer'}</span></div>
      </div>
      <button class="btn-outline sm" onclick="showUserActions('${u.id}','${escapeHtml(u.name||'')}','${u.role||'customer'}')">Manage</button>
    </div>`).join('');
}

function renderAdminWithdrawals(wds) {
  const pending=wds.filter(w=>w.status==='pending');
  const all=wds;
  if (!all.length) return `<div class="empty"><div class="empty-icon">💸</div><div class="empty-title">No withdrawal requests</div></div>`;
  return all.map(w=>`
    <div class="order-card" style="cursor:default">
      <div class="order-top">
        <div class="order-title">₨${fmt(w.amount)} — ${escapeHtml(w.method||'')}</div>
        <span class="badge badge-${w.status||'pending'}">${w.status||'pending'}</span>
      </div>
      <div class="order-bottom">
        <span class="order-meta">👤 ${escapeHtml(w.userName||'')}</span>
        <span class="order-meta">📱 ${escapeHtml(w.accountNumber||'')}</span>
        <span class="order-meta">🕐 ${timeSince(w.createdAt)}</span>
      </div>
      ${w.status==='pending'?`
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn-neon sm" onclick="approveWithdrawal('${w.id}')">✅ Approve</button>
          <button class="btn-red sm" onclick="rejectWithdrawal('${w.id}')">❌ Reject</button>
        </div>`:''}
    </div>`).join('');
}

async function approveWithdrawal(id) {
  await updateWithdrawal(id,{status:'approved'});
  showToast('Withdrawal approved!','success');
  const wds=await getAllWithdrawals();
  window._adminWDs=wds;
  const el=document.getElementById('admin-content');
  if(el) el.innerHTML=renderAdminWithdrawals(wds);
}
async function rejectWithdrawal(id) {
  await updateWithdrawal(id,{status:'rejected'});
  showToast('Withdrawal rejected','info');
  const wds=await getAllWithdrawals();
  window._adminWDs=wds;
  const el=document.getElementById('admin-content');
  if(el) el.innerHTML=renderAdminWithdrawals(wds);
}

async function showUserActions(uid, name, role) {
  openModal(`
    <div class="modal-header"><h3>Manage: ${escapeHtml(name||'User')}</h3><button class="modal-close" onclick="closeModalForce()">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label class="form-label">Change Role</label>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">
          ${['customer','reseller','marketer','admin'].map(r=>`
            <button class="btn-outline ${r===role?'active':''}" style="justify-content:center;padding:10px"
              onclick="changeUserRole('${uid}','${r}')">
              <span class="profile-role role-${r}">${r}</span>
            </button>`).join('')}
        </div>
      </div>
    </div>
  `);
}

async function changeUserRole(uid, role) {
  await updateUserDoc(uid,{role});
  showToast(`Role changed to ${role}!`,'success');
  closeModalForce();
  const users=await getAllUsers();
  window._adminUsers=users;
  const el=document.getElementById('admin-content');
  if(el) el.innerHTML=renderAdminUsers(users);
}

// ── ADD PRODUCT MODAL ─────────────────────────────────────────────
function showAddProductModal() {
  openModal(`
    <div class="modal-header"><h3>➕ Add Product</h3><button class="modal-close" onclick="closeModalForce()">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label class="form-label">Title *</label><input class="input" id="np-title" placeholder="Product name" /></div>
      <div class="form-group"><label class="form-label">Description</label><textarea class="input" id="np-desc" placeholder="Product description"></textarea></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="form-group"><label class="form-label">Original Price *</label><input class="input" id="np-price" type="number" placeholder="1000" /></div>
        <div class="form-group"><label class="form-label">Reseller Price</label><input class="input" id="np-rprice" type="number" placeholder="1200" /></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="form-group"><label class="form-label">Currency</label>
          <select class="input" id="np-currency"><option>PKR</option><option>USD</option><option>SAR</option><option>AED</option><option>INR</option></select>
        </div>
        <div class="form-group"><label class="form-label">Stock</label><input class="input" id="np-stock" type="number" placeholder="100" /></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="form-group"><label class="form-label">Type</label>
          <select class="input" id="np-type"><option value="physical">📦 Physical</option><option value="digital">⚡ Digital</option></select>
        </div>
        <div class="form-group"><label class="form-label">Category</label>
          <select class="input" id="np-cat"><option value="">-- Select --</option><option>mobiles</option><option>electronics</option><option>fashion</option><option>education</option><option>entertainment</option><option>software</option><option>music</option><option>giftcards</option><option>beauty</option></select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Images (max 5)</label><div id="np-imgbb-container"></div></div>
      <div class="form-group"><label class="form-label">Tags (comma separated)</label><input class="input" id="np-tags" placeholder="sale, trending, new" /></div>
      <button class="btn-neon btn-block" id="add-prod-btn" onclick="submitAddProduct()">Add Product</button>
    </div>
  `);
  window._npImages=[];
  renderImgBBUploader('np-imgbb-container',(urls)=>{ window._npImages=urls; },[],5);
}

async function submitAddProduct() {
  const title=document.getElementById('np-title')?.value?.trim();
  const price=parseFloat(document.getElementById('np-price')?.value);
  if (!title||!price){ showToast('Title and price required','error'); return; }
  const btn=document.getElementById('add-prod-btn');
  if (btn){ btn.disabled=true; btn.textContent='Adding...'; }
  const images=window._npImages||[];
  const tags=(document.getElementById('np-tags')?.value||'').split(',').map(s=>s.trim()).filter(Boolean);
  try {
    await createCatalog({
      title,
      description: document.getElementById('np-desc')?.value||'',
      price,
      resellerPrice: parseFloat(document.getElementById('np-rprice')?.value)||price,
      currency: document.getElementById('np-currency')?.value||'PKR',
      stock: parseInt(document.getElementById('np-stock')?.value)||99,
      type: document.getElementById('np-type')?.value||'physical',
      category: document.getElementById('np-cat')?.value||'',
      images, tags, createdBy: currentUser.uid,
    });
    closeModalForce();
    showToast('Product added! 🎉','success');
    allCatalogs = await getCatalogs(100);
    window._adminCats = allCatalogs;
    const el = document.getElementById('admin-content');
    if (el) el.innerHTML = renderAdminProductsV3(allCatalogs);
  } catch(e){ showToast('Failed to add product','error'); console.error(e); }
  if (btn){ btn.disabled=false; btn.textContent='Add Product'; }
}

async function showEditProductModal(id) {
  const c = allCatalogs.find(x=>x.id===id)||await getCatalogById(id);
  if (!c){ showToast('Product not found','error'); return; }
  openModal(`
    <div class="modal-header"><h3>✏️ Edit Product</h3><button class="modal-close" onclick="closeModalForce()">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label class="form-label">Title *</label><input class="input" id="ep-title" value="${escapeHtml(c.title||'')}" /></div>
      <div class="form-group"><label class="form-label">Description</label><textarea class="input" id="ep-desc">${escapeHtml(c.description||'')}</textarea></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="form-group"><label class="form-label">Original Price *</label><input class="input" id="ep-price" type="number" value="${c.price||''}" /></div>
        <div class="form-group"><label class="form-label">Reseller Price</label><input class="input" id="ep-rprice" type="number" value="${c.resellerPrice||''}" /></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="form-group"><label class="form-label">Currency</label>
          <select class="input" id="ep-currency">
            ${['PKR','USD','SAR','AED','INR','EUR'].map(cur=>`<option ${c.currency===cur?'selected':''}>${cur}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label class="form-label">Stock</label><input class="input" id="ep-stock" type="number" value="${c.stock||''}" /></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="form-group"><label class="form-label">Type</label>
          <select class="input" id="ep-type">
            <option value="physical" ${c.type==='physical'?'selected':''}>📦 Physical</option>
            <option value="digital"  ${c.type==='digital'?'selected':''}>⚡ Digital</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Category</label>
          <select class="input" id="ep-cat">
            ${['','mobiles','electronics','fashion','education','entertainment','software','music','giftcards','beauty'].map(cat=>`<option value="${cat}" ${c.category===cat?'selected':''}>${cat||'-- Select --'}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Images (max 5)</label><div id="ep-imgbb-container"></div></div>
      <div class="form-group"><label class="form-label">Tags</label><input class="input" id="ep-tags" value="${(c.tags||[]).join(', ')}" /></div>
      <button class="btn-neon btn-block" id="edit-prod-btn" onclick="submitEditProduct('${id}')">Save Changes</button>
    </div>
  `);
  window._epImages=[...(c.images||[])];
  renderImgBBUploader('ep-imgbb-container',(urls)=>{ window._epImages=urls; },c.images||[],5);
}

async function submitEditProduct(id) {
  const title=document.getElementById('ep-title')?.value?.trim();
  const price=parseFloat(document.getElementById('ep-price')?.value);
  if (!title||!price){ showToast('Title and price required','error'); return; }
  const btn=document.getElementById('edit-prod-btn');
  if(btn){ btn.disabled=true; btn.textContent='Saving...'; }
  const tags=(document.getElementById('ep-tags')?.value||'').split(',').map(s=>s.trim()).filter(Boolean);
  try {
    await updateCatalog(id,{
      title,
      description: document.getElementById('ep-desc')?.value||'',
      price,
      resellerPrice: parseFloat(document.getElementById('ep-rprice')?.value)||price,
      currency: document.getElementById('ep-currency')?.value||'PKR',
      stock: parseInt(document.getElementById('ep-stock')?.value)||99,
      type: document.getElementById('ep-type')?.value||'physical',
      category: document.getElementById('ep-cat')?.value||'',
      images: window._epImages||[],
      tags,
    });
    closeModalForce();
    showToast('Product updated! ✅','success');
    allCatalogs=await getCatalogs(100);
    window._adminCats=allCatalogs;
    const el=document.getElementById('admin-content');
    if(el) el.innerHTML=renderAdminProductsV3(allCatalogs);
  } catch(e){ showToast('Failed to update','error'); console.error(e); }
  if(btn){ btn.disabled=false; btn.textContent='Save Changes'; }
}

async function confirmDeleteProduct(id) {
  if (!confirm('Delete this product?')) return;
  await deleteCatalog(id);
  showToast('Product deleted','success');
  allCatalogs=allCatalogs.filter(c=>c.id!==id);
  window._adminCats=allCatalogs;
  const el=document.getElementById('admin-content');
  if(el) el.innerHTML=renderAdminProductsV3(allCatalogs);
}

// ════════════════════════════════════════════════════════════════
// SHARE PAGES
// ════════════════════════════════════════════════════════════════

async function renderShareV3(params={}) {
  const {id}=params;
  setContent(`<div class="page"><div style="text-align:center;padding:80px 0"><div style="font-size:3rem">⏳</div></div></div>`);
  const c = await getCatalogById(id);
  if (!c) {
    setContent(`<div class="page"><div class="empty"><div class="empty-icon">😕</div><div class="empty-title">Product not found</div><button class="btn-neon sm" onclick="navigate('home')">Go Home</button></div></div>`);
    return;
  }
  incrementViews(id);
  const sym    = CURRENCY_SYM[c.currency]||'₨';
  const price  = c.resellerPrice||c.price||0;
  const images = c.images||[];

  // Save ref from hash/query to localStorage
  const _shareRef = getActiveRef();
  if (_shareRef) localStorage.setItem('mich_ref', _shareRef);

  setContent(`
    <div style="min-height:100vh;background:var(--bg)">
      <div style="position:relative;overflow:hidden;padding:48px 20px 32px;text-align:center">
        <div class="hero-orb hero-orb-1" style="opacity:0.1"></div>
        <div class="hero-orb hero-orb-2" style="opacity:0.08"></div>
        <div style="max-width:500px;margin:0 auto">
          ${images.length>0?`
            <div style="position:relative;width:220px;height:220px;margin:0 auto 20px">
              <img src="${images[0]}" class="share-img" alt="${escapeHtml(c.title)}"
                style="width:220px;height:220px;cursor:zoom-in"
                onclick="openLightbox(${JSON.stringify(images)},0)" />
              ${images.length>1?`<div style="position:absolute;bottom:8px;right:8px;background:rgba(0,0,0,0.7);border-radius:20px;padding:3px 8px;font-size:0.7rem;color:#fff">+${images.length-1} more</div>`:''}
            </div>`
          :'<div style="width:200px;height:200px;border-radius:28px;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:5rem;margin:0 auto 24px">📦</div>'}

          ${images.length>1?`
            <div style="display:flex;gap:8px;justify-content:center;margin-bottom:16px;overflow-x:auto;padding:4px">
              ${images.map((img,i)=>`
                <img src="${img}" style="width:52px;height:52px;border-radius:8px;object-fit:cover;cursor:zoom-in;border:2px solid ${i===0?'var(--blue)':'var(--border)'};flex-shrink:0"
                  onclick="openLightbox(${JSON.stringify(images)},${i})" />`).join('')}
            </div>
            <div style="font-size:0.7rem;color:var(--text4);margin-bottom:12px">👆 Tap to view full size</div>`:''}

          <span class="badge badge-${c.type||'physical'}" style="margin-bottom:12px">${c.type==='digital'?'⚡ Digital':'📦 Physical'}</span>
          <h1 style="font-size:1.6rem;font-weight:900;margin:12px 0">${escapeHtml(c.title)}</h1>
          ${c.description?`<p style="color:var(--text3);font-size:0.9rem;margin-bottom:16px;line-height:1.6">${escapeHtml(c.description)}</p>`:''}
          <div class="share-price">${sym}${fmt(price)}</div>
          <div style="margin-top:24px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
            <button class="btn-neon lg" onclick="showOrderModal('${id}')">🛒 Order Now</button>
          </div>
          ${c.tags?.length?`<div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:16px">${c.tags.map(t=>`<span class="badge" style="background:var(--glass);color:var(--text3)">#${escapeHtml(t)}</span>`).join('')}</div>`:''}
          <div style="margin-top:32px;padding-top:20px;border-top:1px solid var(--border2);text-align:center">
            <div style="font-size:0.72rem;color:var(--text4);margin-bottom:6px">Powered by</div>
            <a onclick="navigate('home')" style="font-weight:800;font-size:0.9rem;cursor:pointer" class="gradient-text">MICH Digital Shop</a>
            <div style="font-size:0.72rem;color:var(--text4);margin-top:4px">Pakistan's #1 Reseller Marketplace</div>
          </div>
        </div>
      </div>
    </div>
  `);
}

// ════════════════════════════════════════════════════════════════
// EID HERO CARD + LIGHTBOX + MISC UI
// ════════════════════════════════════════════════════════════════

function getEidCountdown() {
  const eidDate = new Date('2026-05-27T00:00:00');
  const now     = new Date();
  const diff    = eidDate - now;
  if (diff<=0) return null;
  return {
    days:  Math.floor(diff/(1000*60*60*24)),
    hours: Math.floor((diff%(1000*60*60*24))/(1000*60*60)),
    mins:  Math.floor((diff%(1000*60*60))/(1000*60))
  };
}

function renderEidHeroCard() {
  const cd = getEidCountdown();
  if (!cd) return `
    <div class="eid-hero-card section">
      <div class="eid-sheep-anim">🐑</div>
      <div class="eid-hero-title">🌙 عید الاضحی مبارک! 🌙</div>
      <div class="eid-hero-sub">Eid ul Adha Special Sale — 27-29 MAY 2026</div>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button class="btn-neon lg" onclick="navigate('catalogs',{category:'eid'})">🐑 Eid Deals →</button>
        <button class="btn-outline lg" onclick="navigate('catalogs')">Browse All</button>
      </div>
    </div>`;
  return `
    <div class="eid-hero-card section">
      <div class="eid-sheep-anim">🐑</div>
      <div class="eid-hero-title">🌙 Eid ul Adha Sale 🌙</div>
      <div class="eid-hero-sub">Special discounts starting 27 MAY!</div>
      <div class="eid-countdown">
        <div class="eid-count-item"><div class="eid-count-num">${cd.days}</div><div class="eid-count-label">Days</div></div>
        <div class="eid-count-item" style="color:#ffd700;font-size:1.5rem;align-self:flex-start;margin-top:8px">:</div>
        <div class="eid-count-item"><div class="eid-count-num">${cd.hours}</div><div class="eid-count-label">Hours</div></div>
        <div class="eid-count-item" style="color:#ffd700;font-size:1.5rem;align-self:flex-start;margin-top:8px">:</div>
        <div class="eid-count-item"><div class="eid-count-num">${cd.mins}</div><div class="eid-count-label">Mins</div></div>
      </div>
      <button class="btn-neon lg" onclick="navigate('catalogs')">Shop Now →</button>
    </div>`;
}

// Lightbox
let _lightboxImages = [];
let _lightboxIndex  = 0;

function openLightbox(images, startIndex=0) {
  _lightboxImages = Array.isArray(images) ? images : [images];
  _lightboxIndex  = startIndex;
  updateLightbox();
  document.getElementById('lightbox')?.classList.remove('hidden');
  document.body.style.overflow='hidden';
}
function closeLightbox() {
  document.getElementById('lightbox')?.classList.add('hidden');
  document.body.style.overflow='';
}
function updateLightbox() {
  const img=document.getElementById('lightbox-img');
  const ctr=document.getElementById('lightbox-counter');
  if (img) img.src=_lightboxImages[_lightboxIndex];
  if (ctr) ctr.textContent=`${_lightboxIndex+1} / ${_lightboxImages.length}`;
}
function lightboxPrev(e) {
  if(e) e.stopPropagation();
  _lightboxIndex=(_lightboxIndex-1+_lightboxImages.length)%_lightboxImages.length;
  updateLightbox();
}
function lightboxNext(e) {
  if(e) e.stopPropagation();
  _lightboxIndex=(_lightboxIndex+1)%_lightboxImages.length;
  updateLightbox();
}
document.addEventListener('keydown', e=>{
  const lb=document.getElementById('lightbox');
  if (lb&&!lb.classList.contains('hidden')) {
    if(e.key==='Escape')     closeLightbox();
    if(e.key==='ArrowLeft')  lightboxPrev();
    if(e.key==='ArrowRight') lightboxNext();
  }
});

function openFullImage(src) {
  const div=document.createElement('div');
  div.className='full-image-view';
  div.innerHTML=`<div class="full-image-close">×</div><img src="${src}">`;
  div.onclick=()=>div.remove();
  document.body.appendChild(div);
}

// Global search
function handleGlobalSearch(q) {
  clearTimeout(searchTimeout);
  searchTimeout=setTimeout(async()=>{
    if (!q.trim()) return;
    if (!allCatalogs.length) allCatalogs=await getCatalogs(100);
    navigate('catalogs',{search:q});
  },400);
}

// ════════════════════════════════════════════════════════════════
// ROUTER
// ════════════════════════════════════════════════════════════════

function navigate(page, params={}) {
  const currentRef = getActiveRef();
  unsubscribeAll();
  currentPage   = page;
  currentParams = params;

  const hashParts=[];
  if (params.id)       hashParts.push('id='+encodeURIComponent(params.id));
  if (params.order)    hashParts.push('order=1');
  if (params.category) hashParts.push('category='+encodeURIComponent(params.category));
  if (currentRef)      hashParts.push('ref='+encodeURIComponent(currentRef));

  const newHash='#'+page+(hashParts.length?'?'+hashParts.join('&'):'');
  if (window.location.hash!==newHash) {
    history.pushState({page,params},'',newHash);
  }
  updateActiveNav();

  switch(page) {
    case 'home':     renderHomeV3();               break;
    case 'auth':     renderAuth();                 break;
    case 'catalogs': renderCatalogs(params);       break;
    case 'catalog':  renderCatalogDetailV3(params);break;
    case 'earnings': renderEarnings();             break;
    case 'orders':   renderOrders();               break;
    case 'clients':  renderClients();              break;
    case 'profile':  renderProfile();              break;
    case 'admin':    renderAdmin();                break;
    case 'share':    renderShareV3(params);        break;
    default:         renderHomeV3();
  }
  closeMobileMenu();
}

window.addEventListener('popstate', function(e) {
  if (!e.state||!e.state.page) return;
  try {
    const hashRef=new URLSearchParams(window.location.hash.replace(/^#[^?]*\??/,'')).get('ref');
    if(hashRef) localStorage.setItem('mich_ref',hashRef);
  } catch(err){}
  unsubscribeAll();
  currentPage   = e.state.page;
  currentParams = e.state.params||{};
  updateActiveNav();
  switch(e.state.page) {
    case 'home':     renderHomeV3();                            break;
    case 'auth':     renderAuth();                              break;
    case 'catalogs': renderCatalogs(e.state.params||{});       break;
    case 'catalog':  renderCatalogDetailV3(e.state.params||{});break;
    case 'earnings': renderEarnings();                          break;
    case 'orders':   renderOrders();                            break;
    case 'clients':  renderClients();                           break;
    case 'profile':  renderProfile();                           break;
    case 'admin':    renderAdmin();                             break;
    case 'share':    renderShareV3(e.state.params||{});         break;
    default:         renderHomeV3();
  }
});

// ════════════════════════════════════════════════════════════════
// PWA
// ════════════════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}

// ════════════════════════════════════════════════════════════════
// INIT — DOMContentLoaded
// ════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  const urlParams  = new URLSearchParams(window.location.search);
  const shareId    = urlParams.get('share');

  const rawHash    = window.location.hash.replace(/^#/,'');
  const hashPage   = rawHash.split('?')[0];
  const hashQuery  = rawHash.includes('?') ? rawHash.split('?')[1] : '';
  const hashParams = new URLSearchParams(hashQuery);

  // Save ref from any source
  const anyRef = urlParams.get('ref') || hashParams.get('ref');
  if (anyRef) localStorage.setItem('mich_ref', anyRef);

  // Auth state
  fauth.onAuthStateChanged(async (firebaseUser) => {
    currentUser = firebaseUser;
    if (firebaseUser) {
      userProfile = await getUserDoc(firebaseUser.uid);
      if (!userProfile) {
        await createUserDoc(firebaseUser.uid, {
          name:  firebaseUser.displayName||'',
          email: firebaseUser.email||'',
          photo: firebaseUser.photoURL||'',
        });
        userProfile = await getUserDoc(firebaseUser.uid);
      }
    } else {
      userProfile = null;
    }

    updateNavUI();
    setTimeout(()=>{ document.getElementById('splash')?.classList.add('hide'); }, 800);

    // Routing
    if (shareId) {
      navigate('share',{id:shareId});
    } else if (hashPage && hashPage!=='home' && hashPage!=='') {
      const hashId       = hashParams.get('id')       || undefined;
      const hashOrder    = hashParams.get('order')    === '1';
      const hashCategory = hashParams.get('category') || undefined;
      const hashRef      = hashParams.get('ref');
      if (hashRef) localStorage.setItem('mich_ref', hashRef);

      const pageParams={};
      if (hashId)       pageParams.id       = hashId;
      if (hashOrder)    pageParams.order    = true;
      if (hashCategory) pageParams.category = hashCategory;

      currentPage   = hashPage;
      currentParams = pageParams;
      switch(hashPage) {
        case 'home':     renderHomeV3();                 break;
        case 'auth':     renderAuth();                   break;
        case 'catalogs': renderCatalogs(pageParams);     break;
        case 'catalog':  renderCatalogDetailV3(pageParams);break;
        case 'earnings': renderEarnings();               break;
        case 'orders':   renderOrders();                 break;
        case 'clients':  renderClients();                break;
        case 'profile':  renderProfile();                break;
        case 'admin':    renderAdmin();                  break;
        case 'share':    renderShareV3(pageParams);      break;
        default:         renderHomeV3();
      }
    } else {
      navigate('home');
    }
  });
});
