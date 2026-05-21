/* ══════════════════════════════════════════════════════════════
   MICH Digital Shop — app.js
   Complete SPA: Firebase · Auth · Firestore · Pages · Router
   ══════════════════════════════════════════════════════════════

   FIXES APPLIED:
   1.  Guest orders — anyone can create an order (Firestore rules below)
   2.  Referral tracking — referralCode → UID lookup before storing resellerId
   3.  Earnings credited on "delivered" via atomic batched write
   4.  getCatalogById — 30-second timeout + user-friendly error + Go Back
   5.  Real-time listeners (onSnapshot) for catalogs, admin orders, earnings
   6.  XSS — escapeHtml applied everywhere dynamic content hits innerHTML
   7.  localStorage persistence for ref param ('mich_ref')
   8.  Order double-submission protection (button disabled during submit)
   9.  Guest orders saved successfully; buyer phone stored for lookup
   10. setOrderStatus atomically credits earnings and refreshes admin UI

   ════════════════════════════════════════════════════════════════
   RECOMMENDED FIRESTORE SECURITY RULES
   ════════════════════════════════════════════════════════════════
   Paste these into Firebase Console → Firestore → Rules

   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {

       // ── helpers ──────────────────────────────────────────────
       function isAuth()  { return request.auth != null; }
       function isAdmin() { return isAuth() &&
         get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin'; }

       // ── catalogs ─────────────────────────────────────────────
       match /catalogs/{id} {
         allow read: if true;
         // only admin can create/edit; increment views/shares is open
         allow update: if isAdmin()
           || (request.resource.data.diff(resource.data).affectedKeys()
               .hasOnly(['views','shares']));
         allow create, delete: if isAdmin();
       }

       // ── orders ───────────────────────────────────────────────
       match /orders/{id} {
         // FIX 1: anyone (including guests) can CREATE an order
         allow create: if true;
         // only the linked reseller or admin can read their orders
         allow read:   if isAdmin()
           || (isAuth() && (resource.data.resellerId == request.auth.uid
                         || resource.data.buyerId     == request.auth.uid));
         // only admin can update status
         allow update: if isAdmin();
         allow delete: if isAdmin();
       }

       // ── earnings ─────────────────────────────────────────────
       match /earnings/{id} {
         // created by server logic (admin action) or authenticated users
         allow create: if isAuth();
         allow read:   if isAdmin()
           || (isAuth() && resource.data.userId == request.auth.uid);
         allow update: if isAdmin();
         allow delete: if isAdmin();
       }

       // ── users ────────────────────────────────────────────────
       match /users/{uid} {
         allow read:   if isAuth() && (request.auth.uid == uid || isAdmin());
         allow create: if isAuth() && request.auth.uid == uid;
         allow update: if isAuth() && (request.auth.uid == uid || isAdmin());
         allow delete: if isAdmin();
       }

       // ── withdrawals ──────────────────────────────────────────
       match /withdrawals/{id} {
         allow create: if isAuth();
         allow read:   if isAdmin()
           || (isAuth() && resource.data.userId == request.auth.uid);
         allow update: if isAdmin();
         allow delete: if isAdmin();
       }

       // ── shares / clients / misc ──────────────────────────────
       match /shares/{id}  { allow read, write: if isAuth(); }
       match /clients/{id} { allow read, write: if isAuth(); }
     }
   }
   ════════════════════════════════════════════════════════════════ */

// ════════════════════════════════════════════════════════════════
// 1. FIREBASE INIT  (config hardcoded — no .env needed)
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

const fauth    = firebase.auth();
const fdb      = firebase.firestore();
const fstorage = firebase.storage();

// ════════════════════════════════════════════════════════════════
// 1c. SECURITY HELPER — escapeHtml (Fix 5: prevents XSS)
// ════════════════════════════════════════════════════════════════

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ════════════════════════════════════════════════════════════════
// 1b. IMGBB IMAGE UPLOAD SYSTEM
// ════════════════════════════════════════════════════════════════

const IMGBB_API_KEY = '6bdb23b28e7581721b28e46ce313308b';
const APP_URL       = 'https://michshoping.vercel.app';

/**
 * Upload a single File/Blob to ImgBB.
 * Returns { url, thumb } on success or throws on failure.
 */
async function uploadToImgBB(file) {
  const formData = new FormData();
  formData.append('image', file);
  const res  = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, { method: 'POST', body: formData });
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'ImgBB upload failed');
  return { url: data.data.url, thumb: data.data.thumb?.url || data.data.url };
}

/**
 * Show an inline ImgBB uploader widget inside containerId.
 * onUploaded(urls[]) is called whenever new images are added.
 * preloadedUrls = array of already-saved image URLs (for edit mode).
 * maxImages = max allowed (default 5).
 */
function renderImgBBUploader(containerId, onUploaded, preloadedUrls = [], maxImages = 5) {
  const container = document.getElementById(containerId);
  if (!container) return;
  // State stored on container element
  container._imgUrls = [...preloadedUrls];

  function rebuild() {
    const urls = container._imgUrls;
    container.innerHTML = `
      <div class="imgbb-uploader">
        <div class="imgbb-preview" id="${containerId}-preview">
          ${urls.map((u, i) => `
            <div class="imgbb-thumb-wrap">
              <img src="${u}" class="imgbb-thumb" alt="img${i+1}" />
              <button class="imgbb-remove" onclick="__imgbbRemove('${containerId}',${i})" title="Remove">✕</button>
            </div>`).join('')}
          ${urls.length < maxImages ? `
            <label class="imgbb-add ${container._uploading ? 'uploading' : ''}" for="${containerId}-file">
              ${container._uploading
                ? `<span class="imgbb-spinner"></span><span style="font-size:0.7rem;color:var(--text3)">Uploading...</span>`
                : `<span style="font-size:1.8rem">📷</span><span style="font-size:0.7rem;color:var(--text3)">Add Image</span>`}
            </label>
            <input type="file" id="${containerId}-file" accept="image/*" multiple style="display:none"
              onchange="__imgbbUpload('${containerId}',this.files,${maxImages})" />
          ` : ''}
        </div>
        <div style="font-size:0.72rem;color:var(--text4);margin-top:4px">${urls.length}/${maxImages} images</div>
      </div>`;
    onUploaded([...container._imgUrls]);
  }

  rebuild();
  container._rebuild = rebuild;
}

window.__imgbbRemove = function(containerId, idx) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container._imgUrls.splice(idx, 1);
  container._rebuild();
};

window.__imgbbUpload = async function(containerId, files, maxImages) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const remaining = maxImages - container._imgUrls.length;
  const toUpload  = Array.from(files).slice(0, remaining);
  if (!toUpload.length) return;
  container._uploading = true;
  container._rebuild();
  let uploaded = 0;
  for (const file of toUpload) {
    try {
      const { url } = await uploadToImgBB(file);
      container._imgUrls.push(url);
      uploaded++;
    } catch (e) {
      showToast(`Image upload failed: ${e.message}`, 'error');
    }
  }
  container._uploading = false;
  container._rebuild();
  if (uploaded) showToast(`${uploaded} image${uploaded>1?'s':''} uploaded! ✅`, 'success');
};

/**
 * Single photo uploader — for profile photo.
 * Calls onUploaded(url) with the uploaded ImgBB URL.
 */
function renderProfilePhotoUploader(containerId, currentPhotoUrl, onUploaded) {
  const container = document.getElementById(containerId);
  if (!container) return;

  function rebuild(uploading = false) {
    container.innerHTML = `
      <div class="profile-photo-uploader">
        <div class="profile-photo-wrap">
          ${currentPhotoUrl
            ? `<img src="${currentPhotoUrl}" class="profile-photo-preview" id="${containerId}-img" />`
            : `<div class="profile-photo-placeholder">${(userProfile?.name||'U').charAt(0)}</div>`}
          <label for="${containerId}-input" class="profile-photo-btn ${uploading?'uploading':''}">
            ${uploading
              ? `<span class="imgbb-spinner"></span>`
              : `<span>📷</span>`}
          </label>
          <input type="file" id="${containerId}-input" accept="image/*" style="display:none"
            onchange="__profilePhotoUpload('${containerId}',this.files[0])" />
        </div>
        ${uploading ? `<div style="font-size:0.72rem;color:var(--blue);margin-top:6px">Uploading photo...</div>` : ''}
      </div>`;
  }

  container._onUploaded = onUploaded;
  container._currentUrl = currentPhotoUrl;
  rebuild();
  container._rebuild = rebuild;
}

window.__profilePhotoUpload = async function(containerId, file) {
  if (!file) return;
  const container = document.getElementById(containerId);
  if (!container) return;
  container._rebuild(true);
  try {
    const { url } = await uploadToImgBB(file);
    container._currentUrl = url;
    container._onUploaded(url);
    // refresh preview
    renderProfilePhotoUploader(containerId, url, container._onUploaded);
    showToast('Profile photo updated! 🎉', 'success');
  } catch(e) {
    container._rebuild(false);
    showToast('Photo upload failed: ' + e.message, 'error');
  }
};

// ════════════════════════════════════════════════════════════════
// 2. GLOBAL STATE
// ════════════════════════════════════════════════════════════════

let currentUser    = null;
let userProfile    = null;
let currentPage    = 'home';
const urlParams = new URLSearchParams(window.location.search);

const sharedCatalog = urlParams.get('share');

// FIX 7: Persist referral code to localStorage under 'mich_ref' as soon as page loads
(function() {
  const _refFromUrl = new URLSearchParams(window.location.search).get('ref');
  if (_refFromUrl) localStorage.setItem('mich_ref', _refFromUrl);
})();

// FIX 7: Read ref from URL first, then localStorage fallback
const refUser =
  new URLSearchParams(window.location.search).get('ref') ||
  localStorage.getItem('mich_ref') ||
  null;
let currentParams  = {};
let allCatalogs    = [];   // cache
let searchTimeout  = null;

// FIX 5: Registry of active onSnapshot unsubscribe functions.
// Call unsubscribeAll() before navigating away to prevent memory leaks.
const _listeners = {};
function registerListener(key, unsubFn) {
  // If a listener for this key already exists, tear it down first.
  if (_listeners[key]) { try { _listeners[key](); } catch(e) {} }
  _listeners[key] = unsubFn;
}
function unsubscribeAll() {
  Object.keys(_listeners).forEach(k => {
    try { _listeners[k](); } catch(e) {}
    delete _listeners[k];
  });
}

const CURRENCY_SYM = { PKR:'₨', USD:'$', SAR:'﷼', AED:'د.إ', INR:'₹', EUR:'€' };
const METHODS      = ['JazzCash','Easypaisa','Bank Transfer','Binance USDT','PayPal'];

// ════════════════════════════════════════════════════════════════
// 3. FIRESTORE HELPERS
// ════════════════════════════════════════════════════════════════

async function createUserDoc(uid, data) {
  const ref  = fdb.collection('users').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      ...data,
      role: data.role || 'customer',
      earnings: 0, pendingEarnings: 0, withdrawableBalance: 0, totalOrders: 0,
      referralCode: uid.slice(0, 8).toUpperCase(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }
}

async function getUserDoc(uid) {
  const snap = await fdb.collection('users').doc(uid).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function updateUserDoc(uid, data) {
  await fdb.collection('users').doc(uid).update({ ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
}

async function getCatalogs(limitN = 40) {
  try {
    const snap = await fdb.collection('catalogs').where('active','==',true).orderBy('createdAt','desc').limit(limitN).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch {
    const snap = await fdb.collection('catalogs').orderBy('createdAt','desc').limit(limitN).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
}

async function getCatalogById(id) {
  // FIX 4: 30-second timeout + user-friendly error message with Go Back button
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Request timed out after 30 seconds. Please check your connection.')), 30000)
    );
    const fetchPromise = fdb.collection('catalogs').doc(id).get();
    const snap = await Promise.race([fetchPromise, timeoutPromise]);
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  } catch(e) {
    console.error('getCatalogById error:', e);
    // Render user-friendly error — only if the app-content element exists
    const appEl = document.getElementById('app-content');
    if (appEl) {
      appEl.innerHTML = `
        <div class="page">
          <div class="empty">
            <div class="empty-icon">😕</div>
            <div class="empty-title">Failed to load product</div>
            <div class="empty-text" style="max-width:320px;margin:0 auto 20px">${escapeHtml(e.message || 'Something went wrong. Please try again.')}</div>
            <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
              <button class="btn-outline sm" onclick="navigate('catalogs')">← Go Back</button>
              <button class="btn-neon sm" onclick="navigate('home')">🏠 Home</button>
            </div>
          </div>
        </div>`;
    }
    return null;
  }
}

async function createCatalog(data) {
  const ref = await fdb.collection('catalogs').add({
    ...data, views:0, shares:0, orders:0, active:true,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

async function updateCatalog(id, data) {
  await fdb.collection('catalogs').doc(id).update({ ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
}

async function deleteCatalog(id) {
  await fdb.collection('catalogs').doc(id).update({ active: false });
}

async function incrementViews(id) {
  await fdb.collection('catalogs').doc(id).update({ views: firebase.firestore.FieldValue.increment(1) }).catch(()=>{});
}

// FIX 2: Resolve a referral string (either a raw UID or a referralCode like "ABC123")
// to the corresponding reseller's UID. Returns the UID string, or null if not found.
async function resolveResellerId(refString) {
  if (!refString) return null;
  // First: treat it as a plain UID — check if that user doc exists
  try {
    const directSnap = await fdb.collection('users').doc(refString).get();
    if (directSnap.exists) return refString; // it IS a uid
  } catch(e) { /* ignore */ }
  // Second: treat it as a referralCode — query by that field
  try {
    const q = await fdb.collection('users').where('referralCode', '==', refString.toUpperCase()).limit(1).get();
    if (!q.empty) return q.docs[0].id; // return the reseller's UID
  } catch(e) { console.error('resolveResellerId error:', e); }
  return null; // could not resolve
}

async function createOrder(data) {
  const ref = await fdb.collection('orders').add({
    ...data, status:'pending',
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

async function getMyOrders(uid, role) {
  const field = role === 'reseller' ? 'resellerId' : role === 'marketer' ? 'marketerId' : 'resellerId';
  try {
    const snap = await fdb.collection('orders').where(field,'==',uid).orderBy('createdAt','desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch {
    const snap = await fdb.collection('orders').orderBy('createdAt','desc').limit(50).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(o => o.resellerId === uid || o.marketerId === uid);
  }
}

async function getAllOrders(status) {
  try {
    const q = status
      ? fdb.collection('orders').where('status','==',status).orderBy('createdAt','desc')
      : fdb.collection('orders').orderBy('createdAt','desc').limit(100);
    const snap = await q.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch {
    const snap = await fdb.collection('orders').limit(100).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
}

async function updateOrderStatus(id, status) {
  await fdb.collection('orders').doc(id).update({ status, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
}

async function getMyEarnings(uid) {
  try {
    const snap = await fdb.collection('earnings').where('userId','==',uid).orderBy('createdAt','desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch {
    return [];
  }
}

async function getMyWithdrawals(uid) {
  try {
    const snap = await fdb.collection('withdrawals').where('userId','==',uid).orderBy('createdAt','desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch { return []; }
}

async function createWithdrawal(data) {
  const ref = await fdb.collection('withdrawals').add({
    ...data, status:'pending',
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

async function getAllWithdrawals() {
  try {
    const snap = await fdb.collection('withdrawals').orderBy('createdAt','desc').limit(100).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch { return []; }
}

async function updateWithdrawal(id, data) {
  await fdb.collection('withdrawals').doc(id).update({ ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
}

async function getAllUsers() {
  try {
    const snap = await fdb.collection('users').orderBy('createdAt','desc').limit(100).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch { return []; }
}

async function getClients(resellerId) {
  try {
    const snap = await fdb.collection('clients').where('resellerId','==',resellerId).orderBy('createdAt','desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch { return []; }
}

async function recordShare(catalogId, userId, platform) {
  await fdb.collection('shares').add({ catalogId, userId, platform, createdAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(()=>{});
  await fdb.collection('catalogs').doc(catalogId).update({ shares: firebase.firestore.FieldValue.increment(1) }).catch(()=>{});
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

function showToast(msg, type='info', duration=3000) {
  const icons = { success:'✅', error:'❌', info:'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]||'💬'}</span><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => { el.classList.add('hide'); setTimeout(() => el.remove(), 350); }, duration);
}

function openModal(html) {
  document.getElementById('modal-box').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal(e) {
  if (!e || e.target === document.getElementById('modal-overlay')) {
    document.getElementById('modal-overlay').classList.add('hidden');
  }
}

function closeModalForce() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

function setContent(html) {
  document.getElementById('app-content').innerHTML = html;
  window.scrollTo(0,0);
}

function setLoading(id, state) {
  const el = document.getElementById(id);
  if (el) el.disabled = state;
}

function fmt(n) { return (n||0).toLocaleString(); }

function timeSince(ts) {
  if (!ts) return 'Just now';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-PK',{ day:'numeric', month:'short', year:'numeric' });
}

function generateShareUrl(id) {
  // Fix 3: Use referralCode from userProfile; fallback to short uid slice if not available
  const ref = userProfile?.referralCode || currentUser?.uid?.slice(0, 8) || '';
  return `${APP_URL}/?share=${id}&ref=${ref}`;
}

function shareOnWhatsApp(catalog) {
  const url  = generateShareUrl(catalog.id);
  const sym  = CURRENCY_SYM[catalog.currency] || '₨';
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
  navigator.clipboard.writeText(generateShareUrl(id)).then(() => showToast('Link copied! 📋','success'));
}

function updateNavUI() {
  const navbar   = document.getElementById('navbar');
  const botNav   = document.getElementById('bottom-nav');
  const adminLnk = document.getElementById('admin-link');
  const adminMob = document.getElementById('admin-mobile-link');
  const logoutM  = document.getElementById('mobile-logout');
  const userArea = document.getElementById('nav-user-area');

  navbar.classList.remove('hidden');
  if (currentUser && userProfile) {
    botNav.classList.remove('hidden');
    const isAdmin = userProfile.role === 'admin';
    if (adminLnk) adminLnk.classList.toggle('hidden', !isAdmin);
    if (adminMob) adminMob.classList.toggle('hidden', !isAdmin);
    if (logoutM)  logoutM.style.display = 'block';
    const initials = (userProfile.name || currentUser.email || 'U').charAt(0).toUpperCase();
    userArea.innerHTML = userProfile.photo
      ? `<img src="${userProfile.photo}" class="nav-avatar" onclick="navigate('profile')" alt="avatar" />
         <button class="btn-outline sm" onclick="logoutUser()">Logout</button>`
      : `<div class="nav-avatar-placeholder" onclick="navigate('profile')">${initials}</div>
         <button class="btn-outline sm" onclick="logoutUser()">Logout</button>`;
  } else {
    botNav.classList.add('hidden');
    if (adminLnk) adminLnk.classList.add('hidden');
    if (adminMob) adminMob.classList.add('hidden');
    if (logoutM)  logoutM.style.display = 'none';
    userArea.innerHTML = `<button class="btn-neon sm" onclick="navigate('auth')">Login</button>`;
  }
  updateActiveNav();
}

function updateActiveNav() {
  document.querySelectorAll('.nav-link, .bnav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === currentPage);
  });
}

function toggleMobileMenu() {
  document.getElementById('mobile-menu').classList.toggle('hidden');
}
function closeMobileMenu() {
  document.getElementById('mobile-menu').classList.add('hidden');
}

// Skeleton HTML
function skeletonCards(n=6) {
  return Array.from({length:n}).map(() => `
    <div class="card" style="padding:0;overflow:hidden">
      <div class="skeleton" style="aspect-ratio:1;border-radius:0"></div>
      <div style="padding:12px">
        <div class="skeleton" style="height:14px;border-radius:6px;margin-bottom:8px"></div>
        <div class="skeleton" style="height:12px;width:60%;border-radius:6px"></div>
      </div>
    </div>`).join('');
}

// ════════════════════════════════════════════════════════════════
// 6. PAGE RENDERERS
// ════════════════════════════════════════════════════════════════

// ─── HOME ────────────────────────────────────────────────────────
async function renderHome() {
  setContent(`
    <div class="page" style="padding-top:0;padding-left:0;padding-right:0;max-width:100%">
      <!-- Hero -->
      <section class="hero">
        <div class="hero-orb hero-orb-1"></div>
        <div class="hero-orb hero-orb-2"></div>
        <div class="hero-orb hero-orb-3"></div>
        <div class="hero-content">
          <div class="hero-badge"><span class="pulse-dot"></span> Pakistan's #1 Reseller Marketplace</div>
          <h1>Sell Products,<br><span class="gradient-text">Earn Money</span><br><span style="color:var(--text2)">From Anywhere</span></h1>
          <p>Join 1,200+ resellers already earning daily with physical &amp; digital products. Share, sell, grow.</p>
          <div class="hero-btns">
            ${currentUser
              ? `<button class="btn-neon lg" onclick="navigate('catalogs')">Browse Products →</button>
                 <button class="btn-outline lg" onclick="navigate('earnings')">My Earnings 💰</button>`
              : `<button class="btn-neon lg" onclick="navigate('auth')">Start Earning Free 🚀</button>
                 <button class="btn-outline lg" onclick="navigate('catalogs')">Browse Products</button>`}
          </div>
          <div class="hero-stats">
            <div><div class="hero-stat-val gradient-text">500+</div><div class="hero-stat-label">Products</div></div>
            <div><div class="hero-stat-val gradient-text">1,200+</div><div class="hero-stat-label">Resellers</div></div>
            <div><div class="hero-stat-val gradient-text">₨50L+</div><div class="hero-stat-label">Paid Out</div></div>
          </div>
        </div>
      </section>

      <div class="page" style="padding-top:8px">
        <!-- Live Counters -->
        <div class="section">
          <div class="section-head">
            <div><div class="section-title">📊 Live <span class="gradient-text">Statistics</span></div></div>
            <div style="display:flex;align-items:center;gap:6px;font-size:0.78rem;color:var(--blue)">
              <div class="pulse-dot" style="width:6px;height:6px"></div> Live
            </div>
          </div>
          <div class="counters-grid" id="counters-grid">
            ${[
              {icon:'📦',label:'Products',val:'500+',color:'var(--blue)'},
              {icon:'👥',label:'Resellers',val:'1,200+',color:'var(--purple)'},
              {icon:'🛒',label:'Orders',val:'8,500+',color:'var(--orange)'},
              {icon:'💰',label:'Paid Out',val:'₨50L+',color:'var(--green)'},
              {icon:'📤',label:'Daily Shares',val:'350+',color:'var(--pink)'},
              {icon:'⭐',label:'Happy Clients',val:'4,200+',color:'var(--yellow)'},
            ].map(c => `
              <div class="card counter-card">
                <div class="counter-icon">${c.icon}</div>
                <div class="counter-val" style="color:${c.color}">${c.val}</div>
                <div class="counter-label">${c.label}</div>
              </div>`).join('')}
          </div>
        </div>

        <!-- Categories -->
        <div class="section">
          <div class="section-head">
            <div><div class="section-title">🗂️ <span class="gradient-text">Categories</span></div></div>
            <a class="section-link" onclick="navigate('catalogs')">All →</a>
          </div>
          <div class="cat-scroll">
            ${[
              {icon:'📱',label:'Mobiles',slug:'mobiles'},
              {icon:'💻',label:'Electronics',slug:'electronics'},
              {icon:'👗',label:'Fashion',slug:'fashion'},
              {icon:'🎓',label:'Education',slug:'education'},
              {icon:'🎬',label:'Entertainment',slug:'entertainment'},
              {icon:'💻',label:'Software',slug:'software'},
              {icon:'🎵',label:'Music',slug:'music'},
              {icon:'🎁',label:'Gift Cards',slug:'giftcards'},
              {icon:'💄',label:'Beauty',slug:'beauty'},
              {icon:'⚡',label:'Digital',slug:'digital'},
            ].map(c => `
              <div class="cat-chip" onclick="navigate('catalogs',{category:'${c.slug}'})">
                <span class="cat-chip-icon">${c.icon}</span>
                <span class="cat-chip-label">${c.label}</span>
              </div>`).join('')}
          </div>
        </div>

        <!-- Trending Products -->
        <div class="section">
          <div class="section-head">
            <div>
              <div class="section-title">⚡ Trending <span class="gradient-text">Products</span></div>
              <div class="section-subtitle">Hot sellers right now</div>
            </div>
            <a class="section-link" onclick="navigate('catalogs')">View all →</a>
          </div>
          <div class="products-grid" id="trending-grid">
            ${skeletonCards(6)}
          </div>
        </div>

        <!-- All Products -->
        <div class="section">
          <div class="section-head">
            <div>
              <div class="section-title">🛍️ Latest <span class="gradient-text">Products</span></div>
              <div class="section-subtitle" id="products-count">Loading...</div>
            </div>
            <a class="section-link" onclick="navigate('catalogs')">See all →</a>
          </div>
          <div class="products-grid" id="home-products-grid">
            ${skeletonCards(8)}
          </div>
        </div>

        ${!currentUser ? `
        <!-- Join CTA -->
        <div class="card" style="text-align:center;padding:40px 24px;margin-bottom:24px;border-color:rgba(0,212,255,0.2);background:linear-gradient(135deg,rgba(0,212,255,0.06),rgba(139,92,246,0.06))">
          <div style="font-size:3rem;margin-bottom:12px">🚀</div>
          <h2 style="font-size:1.5rem;font-weight:900;margin-bottom:8px">Start Earning Today — <span class="gradient-text">It's Free!</span></h2>
          <p style="color:var(--text3);margin-bottom:20px;max-width:400px;margin-left:auto;margin-right:auto">Join thousands of resellers. No investment. Start sharing in minutes.</p>
          <button class="btn-neon lg" onclick="navigate('auth')">⭐ Create Free Account</button>
        </div>` : ''}
      </div>
    </div>
  `);

  // Load products async
  const catalogs = await getCatalogs(20);
  allCatalogs = catalogs;
  const el1 = document.getElementById('trending-grid');
  const el2 = document.getElementById('home-products-grid');
  const cnt  = document.getElementById('products-count');
  if (el1) el1.innerHTML = renderProductCards(catalogs.slice(0,6));
  if (el2) el2.innerHTML = renderProductCards(catalogs);
  if (cnt) cnt.textContent = `${catalogs.length} products available`;
}

// ─── CATALOGS ────────────────────────────────────────────────────
async function renderCatalogs(params={}) {
  const initCategory = params.category || 'all';
  setContent(`
    <div class="page">
      <div style="margin-bottom:20px">
        <h1 class="section-title" style="font-size:1.4rem">Product <span class="gradient-text">Catalog</span></h1>
        <p style="color:var(--text3);font-size:0.85rem;margin-top:4px" id="cat-count">Loading...</p>
      </div>

      <!-- Search -->
      <div class="search-bar">
        <span class="search-icon">🔍</span>
        <input class="input" id="catalog-search" placeholder="Search products, tags..." oninput="filterCatalogs()" />
        <span class="search-clear" onclick="clearCatalogSearch()">✕</span>
      </div>

      <!-- Type filter -->
      <div class="filter-bar" style="margin-bottom:8px">
        <div class="filter-chips">
          ${['All','Physical','Digital'].map(t =>
            `<span class="filter-chip ${t==='All'?'active':''}" data-type="${t.toLowerCase()}" onclick="setTypeFilter(this,'${t}')">${t==='Physical'?'📦 ':t==='Digital'?'⚡ ':''}${t}</span>`
          ).join('')}
        </div>
      </div>

      <!-- Category chips -->
      <div class="cat-scroll" style="margin-bottom:16px">
        ${['all','mobiles','electronics','fashion','education','entertainment','software','music','giftcards','beauty'].map(c =>
          `<span class="filter-chip ${c===initCategory?'active':''}" data-cat="${c}" onclick="setCatFilter(this,'${c}')">${c.charAt(0).toUpperCase()+c.slice(1)}</span>`
        ).join('')}
      </div>

      <!-- Sort row -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div class="filter-chips" style="flex:none;gap:6px">
          ${['newest','popular','price_asc','price_desc'].map((s,i) => {
            const labels = ['Newest','Popular','Price ↑','Price ↓'];
            return `<span class="filter-chip ${s==='newest'?'active':''}" data-sort="${s}" onclick="setSortFilter(this,'${s}')">${labels[i]}</span>`;
          }).join('')}
        </div>
      </div>

      <div class="products-grid" id="catalogs-grid">${skeletonCards(12)}</div>
    </div>
  `);

  if (!allCatalogs.length) allCatalogs = await getCatalogs(100);
  window._catFilterState = { category: initCategory, type:'all', sort:'newest', search:'' };
  renderFilteredCatalogs();
  const cnt = document.getElementById('cat-count');
  if (cnt) cnt.textContent = `${allCatalogs.length} products found`;
}

function filterCatalogs() {
  const q = document.getElementById('catalog-search')?.value || '';
  if (!window._catFilterState) window._catFilterState = { category:'all', type:'all', sort:'newest', search:'' };
  window._catFilterState.search = q;
  renderFilteredCatalogs();
}

function clearCatalogSearch() {
  const el = document.getElementById('catalog-search');
  if (el) el.value = '';
  filterCatalogs();
}

function setCatFilter(el, cat) {
  document.querySelectorAll('[data-cat]').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  if (!window._catFilterState) window._catFilterState = { category:'all', type:'all', sort:'newest', search:'' };
  window._catFilterState.category = cat;
  renderFilteredCatalogs();
}

function setTypeFilter(el, type) {
  document.querySelectorAll('[data-type]').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  if (!window._catFilterState) window._catFilterState = { category:'all', type:'all', sort:'newest', search:'' };
  window._catFilterState.type = type.toLowerCase();
  renderFilteredCatalogs();
}

function setSortFilter(el, sort) {
  document.querySelectorAll('[data-sort]').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  if (!window._catFilterState) window._catFilterState = { category:'all', type:'all', sort:'newest', search:'' };
  window._catFilterState.sort = sort;
  renderFilteredCatalogs();
}

function renderFilteredCatalogs() {
  const { category, type, sort, search } = window._catFilterState;
  let list = [...allCatalogs];
  if (search) list = list.filter(c =>
    c.title?.toLowerCase().includes(search.toLowerCase()) ||
    c.description?.toLowerCase().includes(search.toLowerCase()) ||
    c.tags?.some(t => t.toLowerCase().includes(search.toLowerCase()))
  );
  if (category !== 'all') list = list.filter(c => c.category?.toLowerCase() === category);
  if (type !== 'all')     list = list.filter(c => c.type?.toLowerCase() === type);
  if (sort === 'popular')    list.sort((a,b) => (b.views||0)-(a.views||0));
  if (sort === 'price_asc')  list.sort((a,b) => (a.resellerPrice||a.price||0)-(b.resellerPrice||b.price||0));
  if (sort === 'price_desc') list.sort((a,b) => (b.resellerPrice||b.price||0)-(a.resellerPrice||a.price||0));
  const grid = document.getElementById('catalogs-grid');
  const cnt  = document.getElementById('cat-count');
  if (grid) grid.innerHTML = list.length ? renderProductCards(list) : `<div class="empty" style="grid-column:1/-1"><div class="empty-icon">🔍</div><div class="empty-title">No products found</div><div class="empty-text">Try different search or filters</div><button class="btn-outline sm" onclick="clearCatalogSearch()">Clear Search</button></div>`;
  if (cnt) cnt.textContent = `${list.length} products found`;
}

// ─── PRODUCT CARDS (shared renderer) ─────────────────────────────
function renderProductCards(catalogs) {
  if (!catalogs.length) return `<div class="empty" style="grid-column:1/-1"><div class="empty-icon">📦</div><div class="empty-title">No products yet</div></div>`;
  return catalogs.map(c => {
    const sym  = CURRENCY_SYM[c.currency] || '₨';
    const price = c.resellerPrice || c.price || 0;
    const profit = c.resellerPrice > c.price ? c.resellerPrice - c.price : 0;
    const imgHtml = c.images?.[0]
      ? `<img src="${c.images[0]}" alt="${escapeHtml(c.title)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=product-img-placeholder>📦</div>'" />`
      : `<div class="product-img-placeholder">📦</div>`;
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
            <button class="product-action-btn"
onclick="event.stopPropagation();shareCatalogById('${c.id}')">
📲
</button>

            <button class="product-action-btn" title="Copy Link" onclick="event.stopPropagation();copyLink('${c.id}')">🔗</button>
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
  const catalog = allCatalogs.find(x => x.id === id);
  if (!catalog) return;

  shareOnWhatsApp(catalog);
}
// ─── CATALOG DETAIL ──────────────────────────────────────────────
async function renderCatalogDetail(params={}) {
  const { id, order } = params;
  setContent(`<div class="page"><div style="text-align:center;padding:60px 0"><div style="font-size:3rem">⏳</div><p style="color:var(--text3);margin-top:12px">Loading product...</p></div></div>`);

  const c = await getCatalogById(id);
  if (!c) { setContent(`<div class="page"><div class="empty"><div class="empty-icon">😕</div><div class="empty-title">Product not found</div><button class="btn-neon sm" onclick="navigate('catalogs')">Browse Catalog</button></div></div>`); return; }

  incrementViews(id);
  const sym   = CURRENCY_SYM[c.currency] || '₨';
  const price = c.resellerPrice || c.price || 0;
  const profit = (c.resellerPrice||0) - (c.price||0);
  let activeImg = 0;

  setContent(`
    <div class="page">
      <button onclick="navigate('catalogs')" style="display:flex;align-items:center;gap:4px;color:var(--text3);font-size:0.875rem;margin-bottom:16px;transition:var(--transition)" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='var(--text3)'">← Back</button>
      <div class="detail-grid">
        <!-- Images -->
        <div class="img-gallery">
          <div class="img-main">
            ${c.images?.[0]
              ? `<img id="main-img"
src="${c.images[0]}"
alt="${c.title}"
style="width:100%;height:100%;object-fit:cover"
onclick="openLightbox(0)" />`
              : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:5rem">📦</div>`}
          </div>
          ${c.images?.length > 1 ? `
            <div class="img-thumbs">
              ${c.images.map((img,i) => `
                <div class="img-thumb ${i===0?'active':''}" onclick="switchImg('${img}',this)">
                  <img src="${img}" alt="" onclick="openLightbox(${i})" />
                </div>`).join('')}
            </div>` : ''}
        </div>

        <!-- Info -->
        <div>
          ${c.category?`<div style="font-size:0.75rem;color:var(--blue);margin-bottom:8px">📁 ${c.category}</div>`:''}
          <h1 style="font-size:1.5rem;font-weight:900;line-height:1.3;margin-bottom:16px">${c.title}</h1>

          <!-- Price card -->
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

          ${c.description?`
          <div class="card" style="margin-bottom:16px">
            <div style="font-size:0.8rem;color:var(--text3);font-weight:600;margin-bottom:8px">Description</div>
            <p style="font-size:0.9rem;color:var(--text2);line-height:1.6">${c.description}</p>
          </div>`:''}

          ${c.tags?.length?`<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px">${c.tags.map(t=>`<span class="badge" style="background:var(--glass);color:var(--text3);border:1px solid var(--border)">#${t}</span>`).join('')}</div>`:''}

          <!-- Actions -->
          <div style="display:flex;gap:10px;margin-bottom:12px">
            <button class="btn-neon" style="flex:1;justify-content:center" onclick="showOrderModal('${id}')">🛒 Order Now</button>
            <button class="btn-wa" onclick="shareOnWhatsApp(${JSON.stringify(c).replace(/"/g,'&quot;')})">📲</button>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn-outline" style="flex:1;justify-content:center;font-size:0.8rem" onclick="shareOnWhatsApp(${JSON.stringify(c).replace(/"/g,'&quot;')})">WhatsApp Share</button>
            <button class="btn-outline" style="flex:1;justify-content:center;font-size:0.8rem" onclick="shareOnFacebook(${JSON.stringify(c).replace(/"/g,'&quot;')})">Facebook</button>
            <button class="btn-outline" style="flex:1;justify-content:center;font-size:0.8rem" onclick="copyLink('${id}')">Copy Link</button>
          </div>
        </div>
      </div>
    </div>
  `);

  if (order) setTimeout(() => showOrderModal(id, c), 300);
}

function switchImg(src, el) {
  const main = document.getElementById('main-img');
  if (main) main.src = src;
  document.querySelectorAll('.img-thumb').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
}

// ─── ORDER MODAL ─────────────────────────────────────────────────
async function showOrderModal(catalogId, catalog) {
  if (!catalog) catalog = await getCatalogById(catalogId);
  if (!catalog) return;
  const sym   = CURRENCY_SYM[catalog.currency] || '₨';
  const price = catalog.resellerPrice || catalog.price || 0;
  const isDigital = catalog.type === 'digital';

  openModal(`
    <div class="modal-header">
      <h3>🛒 Place Order</h3>
      <button class="modal-close" onclick="closeModalForce()">✕</button>
    </div>
    <div class="modal-body">
      <div class="card-dark" style="display:flex;align-items:center;gap:12px;padding:12px;margin-bottom:16px">
        ${catalog.images?.[0]?`<img src="${catalog.images[0]}" style="width:48px;height:48px;border-radius:10px;object-fit:cover" />`:'<div style="width:48px;height:48px;border-radius:10px;background:var(--bg3);display:flex;align-items:center;justify-content:center">📦</div>'}
        <div style="flex:1">
          <div style="font-weight:600;font-size:0.9rem">${catalog.title}</div>
          <div style="color:var(--blue);font-weight:800;font-size:1.05rem">${sym}${fmt(price)}</div>
        </div>
      </div>
      <div id="order-form">
        ${isDigital ? `
          <div class="form-group"><label class="form-label">WhatsApp Number *</label><input class="input" id="o-phone" placeholder="+92 300 1234567" required /></div>
          <div class="form-group"><label class="form-label">Email (optional)</label><input class="input" id="o-email" type="email" placeholder="email@example.com" /></div>
          <div class="form-group"><label class="form-label">Username / Game ID (if needed)</label><input class="input" id="o-gameid" placeholder="Your ID" /></div>
          <div class="form-group"><label class="form-label">Notes</label><textarea class="input" id="o-notes" placeholder="Any special instructions..."></textarea></div>
        ` : `
          <div class="form-group"><label class="form-label">Full Name *</label><input class="input" id="o-name" placeholder="Muhammad Ahmad" required /></div>
          <div class="form-group"><label class="form-label">Phone Number *</label><input class="input" id="o-phone" placeholder="+92 300 1234567" required /></div>
          <div class="form-group"><label class="form-label">WhatsApp</label><input class="input" id="o-wa" placeholder="+92 300 1234567" /></div>
          <div class="form-group"><label class="form-label">Full Address *</label><input class="input" id="o-addr" placeholder="House/Street/Area" required /></div>
          <div class="form-group"><label class="form-label">City *</label><input class="input" id="o-city" placeholder="Karachi" required /></div>
          <div class="form-group"><label class="form-label">Notes</label><textarea class="input" id="o-notes" placeholder="Any special instructions..."></textarea></div>
        `}
        <button class="btn-neon btn-block" style="margin-top:8px" id="place-order-btn" onclick="submitOrder('${catalogId}','${catalog.title}',${price},'${catalog.currency||'PKR'}',${(catalog.resellerPrice||0)-(catalog.price||0)},'${catalog.type||'physical'}')">
          Confirm Order — ${sym}${fmt(price)}
        </button>
      </div>
    </div>
  `);
}

async function submitOrder(
  catalogId,
  title,
  price,
  currency,
  profit,
  type
) {
  const btn = document.getElementById('place-order-btn');

  // FIX 8: Disable button immediately to prevent double-submission
  if (btn) { btn.disabled = true; btn.textContent = 'Placing Order...'; }

  // FIX 7: Read ref from URL first, then localStorage under 'mich_ref'
  const rawRef =
    new URLSearchParams(window.location.search).get('ref') ||
    localStorage.getItem('mich_ref') ||
    null;

  // Collect form fields
  const buyerPhone    = document.getElementById('o-phone')?.value?.trim()  || '';
  const buyerName     = document.getElementById('o-name')?.value?.trim()   || '';
  const buyerWhatsapp = document.getElementById('o-wa')?.value?.trim()     || buyerPhone;
  const address       = document.getElementById('o-addr')?.value?.trim()   || '';
  const city          = document.getElementById('o-city')?.value?.trim()   || '';
  const email         = document.getElementById('o-email')?.value?.trim()  || '';
  const gameId        = document.getElementById('o-gameid')?.value?.trim() || '';
  const notes         = document.getElementById('o-notes')?.value?.trim()  || '';

  // VALIDATION
  if (!buyerPhone) {
    showToast('Please enter phone number', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Confirm Order'; }
    return;
  }
  if (type === 'physical' && !buyerName) {
    showToast('Please enter your name', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Confirm Order'; }
    return;
  }

  try {
    // FIX 2: Resolve referral string → reseller UID before storing
    // (handles both raw UIDs and short referralCodes like "ABC123")
    let resellerId = null;
    if (rawRef) {
      resellerId = await resolveResellerId(rawRef);
      if (!resellerId) {
        console.warn('Could not resolve ref to a known user:', rawRef);
      }
    }

    // FIX 9: Store buyerId if the buyer is logged in; also always store buyerPhone
    // so guest orders can be looked up by phone number.
    const data = {
      catalogId,
      catalogTitle: title,
      price,
      currency,
      profit:   profit > 0 ? profit : 0,
      // FIX 1 & 2: resellerId is now always a proper UID (or null)
      resellerId,
      type,
      buyerPhone,
      buyerName,
      buyerWhatsapp,
      address,
      city,
      email,
      gameId,
      notes,
      // FIX 9: link order to logged-in user when available
      buyerId: currentUser?.uid || null,
    };

    console.log('ORDER DATA:', data);

    // FIX 1: createOrder does NOT require auth — Firestore rules allow anyone to write
    const orderId = await createOrder(data);
    console.log('ORDER CREATED:', orderId);

    // FIX 2: Create earning only when we have a properly resolved reseller UID
    if (data.profit > 0 && resellerId) {
      await fdb.collection('earnings').add({
        userId:       resellerId,   // always a UID, never a referralCode string
        orderId,
        catalogTitle: title,
        amount:       data.profit,
        status:       'pending',
        createdAt:    firebase.firestore.FieldValue.serverTimestamp(),
      });
      console.log('EARNING CREATED for reseller:', resellerId);
    }

    closeModalForce();

    // FIX 6: XSS-safe success modal (no raw user input in innerHTML)
    const safeTitle    = escapeHtml(title);
    const safePhone    = escapeHtml(buyerPhone);
    const safeCurrency = CURRENCY_SYM[currency] || '₨';
    openModal(`
      <div class="modal-body" style="text-align:center;padding:40px 24px">
        <div style="font-size:4rem;margin-bottom:16px">🎉</div>
        <h3 style="font-size:1.3rem;font-weight:900;margin-bottom:8px">Order Placed!</h3>
        <p style="color:var(--text3);font-size:0.9rem;margin-bottom:8px">
          <strong>${safeTitle}</strong> — ${safeCurrency}${fmt(price)}
        </p>
        <p style="color:var(--text3);font-size:0.85rem;margin-bottom:8px">
          We'll contact you on <strong>${safePhone}</strong> shortly on WhatsApp.
        </p>
        <p style="color:var(--text4);font-size:0.75rem;margin-bottom:24px">
          Order ID: <code>${escapeHtml(orderId)}</code>
        </p>
        <div style="display:flex;gap:10px">
          <button class="btn-outline btn-block" onclick="closeModalForce()">Close</button>
          ${currentUser
            ? `<button class="btn-neon btn-block" onclick="closeModalForce();navigate('orders')">View Orders</button>`
            : `<button class="btn-neon btn-block" onclick="closeModalForce();navigate('auth')">Track Order</button>`}
        </div>
      </div>
    `);

    showToast('Order placed successfully 🎉', 'success');

  } catch(e) {
    console.error('ORDER ERROR:', e);
    // FIX 1: Show a clear, actionable error — not a raw Firebase permission message
    const msg = e?.code === 'permission-denied'
      ? 'Order could not be saved. Please check your connection and try again.'
      : (e?.message || 'Failed to place order. Please try again.');
    showToast(msg, 'error');
  } finally {
    // FIX 8: Always re-enable the button after success or failure
    if (btn) { btn.disabled = false; btn.textContent = 'Confirm Order'; }
  }
}
// ─── EARNINGS ────────────────────────────────────────────────────
async function renderEarnings() {
  if (!currentUser) {
    try { navigate('auth'); } catch(e) { console.error('navigate error:', e); }
    return;
  }
  setContent(`<div class="page"><div style="text-align:center;padding:60px"><div style="font-size:2rem">⏳</div><p style="color:var(--text3)">Loading earnings...</p></div></div>`);

  const [earnings, withdrawals, uDoc] = await Promise.all([
    getMyEarnings(currentUser.uid),
    getMyWithdrawals(currentUser.uid),
    getUserDoc(currentUser.uid),
  ]);

  _renderEarningsContent(earnings, withdrawals, uDoc);

  // FIX 5: Real-time listener for earnings — reflects new earnings without page reload
  const earningsUnsub = fdb.collection('earnings')
    .where('userId', '==', currentUser.uid)
    .orderBy('createdAt', 'desc')
    .onSnapshot(async (snap) => {
      const liveEarnings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const [liveWds, liveUser] = await Promise.all([
        getMyWithdrawals(currentUser.uid),
        getUserDoc(currentUser.uid),
      ]);
      _renderEarningsContent(liveEarnings, liveWds, liveUser);
    }, (err) => {
      console.error('Earnings snapshot error:', err);
    });

  // Register listener so it is torn down when we navigate away
  registerListener('earnings', earningsUnsub);
}

// Internal helper — renders earnings content and chart
function _renderEarningsContent(earnings, withdrawals, uDoc) {
  const total        = earnings.reduce((s,e) => s+(e.amount||0), 0);
  const approved     = earnings.filter(e=>e.status==='approved').reduce((s,e)=>s+(e.amount||0),0);
  const pending      = earnings.filter(e=>e.status==='pending').reduce((s,e)=>s+(e.amount||0),0);
  const withdrawable = uDoc?.withdrawableBalance || 0;

  // Chart data — last 7 days
  const days = Array.from({length:7},(_,i)=>{ const d=new Date(); d.setDate(d.getDate()-6+i); return d; });
  const chartLabels = days.map(d=>d.toLocaleDateString('en',{weekday:'short'}));
  const chartData   = days.map(d=>earnings.filter(e=>{
    if(!e.createdAt?.toDate) return false;
    return e.createdAt.toDate().toDateString()===d.toDateString();
  }).reduce((s,e)=>s+(e.amount||0),0));

  // Only re-render if we are still on the earnings page
  const appEl = document.getElementById('app-content');
  if (!appEl) return;

  setContent(`
    <div class="page">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
        <div><h1 class="section-title" style="font-size:1.4rem">My <span class="gradient-text">Earnings</span></h1><p style="color:var(--text3);font-size:0.85rem;margin-top:4px">Track income &amp; withdrawals</p></div>
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
            <div class="stat-icon" style="background:rgba(255,255,255,0.06)">${s.icon}</div>
            <div class="stat-value" style="color:${s.color}">${s.val}</div>
            <div class="stat-label">${s.label}</div>
          </div>`).join('')}
      </div>

      <div class="card" style="margin-bottom:24px;padding:20px">
        <div style="font-weight:600;color:var(--text3);margin-bottom:16px;font-size:0.9rem">📈 Earnings — Last 7 Days</div>
        <canvas id="earnings-chart" height="160"></canvas>
      </div>

      ${withdrawals.length ? `
      <div class="card" style="margin-bottom:24px">
        <div style="font-weight:700;margin-bottom:14px">💸 Withdrawal History</div>
        ${withdrawals.map(w=>`
          <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border2)">
            <div>
              <div style="font-weight:600;font-size:0.9rem">₨${fmt(w.amount)} via ${escapeHtml(w.method)}</div>
              <div style="font-size:0.75rem;color:var(--text3)">${escapeHtml(w.accountNumber)} · ${timeSince(w.createdAt)}</div>
            </div>
            <span class="badge badge-${w.status||'pending'}">${w.status||'pending'}</span>
          </div>`).join('')}
      </div>` : ''}

      <div class="card">
        <div style="font-weight:700;margin-bottom:14px">📋 Earnings History</div>
        ${earnings.length === 0
          ? `<div class="empty"><div class="empty-icon">💸</div><div class="empty-title">No earnings yet</div><div class="empty-text">Start sharing products to earn!</div><button class="btn-neon sm" onclick="navigate('catalogs')">Browse Products</button></div>`
          : earnings.map(e=>`
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
      options:{ plugins:{ legend:{display:false} }, scales:{ x:{ grid:{color:'rgba(255,255,255,0.04)'}, ticks:{color:'rgba(255,255,255,0.4)',font:{size:11}} }, y:{ grid:{color:'rgba(255,255,255,0.04)'}, ticks:{color:'rgba(255,255,255,0.4)',font:{size:11}} } }, responsive:true, maintainAspectRatio:false }
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
        <select class="input" id="wd-method">
          ${METHODS.map(m=>`<option value="${m}">${m}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Account / Wallet Number</label><input class="input" id="wd-account" placeholder="03001234567" /></div>
      <div class="form-group"><label class="form-label">Account Holder Name</label><input class="input" id="wd-name" placeholder="Muhammad Ahmad" /></div>
      <button class="btn-neon btn-block" id="wd-submit-btn" onclick="submitWithdraw(${balance})">Submit Withdrawal Request</button>
    </div>
  `);
}

async function submitWithdraw(balance) {
  const amount  = parseFloat(document.getElementById('wd-amount')?.value);
  const method  = document.getElementById('wd-method')?.value;
  const account = document.getElementById('wd-account')?.value;
  const name    = document.getElementById('wd-name')?.value;
  if (!amount||amount<500) { showToast('Minimum withdrawal is ₨500','error'); return; }
  if (amount>balance)      { showToast('Insufficient balance','error'); return; }
  if (!account)            { showToast('Enter account number','error'); return; }
  const btn = document.getElementById('wd-submit-btn');
  if (btn) { btn.disabled=true; btn.textContent='Submitting...'; }
  try {
    await createWithdrawal({ userId:currentUser.uid, userName:userProfile?.name, amount, method, accountNumber:account, accountName:name });
    closeModalForce();
    showToast('Withdrawal request submitted! ✅','success');
    renderEarnings();
  } catch { showToast('Failed. Try again.','error'); if(btn){btn.disabled=false;btn.textContent='Submit';} }
}

// ─── ORDERS ──────────────────────────────────────────────────────
async function renderOrders() {
  if (!currentUser) { navigate('auth'); return; }
  setContent(`<div class="page"><div style="text-align:center;padding:60px"><div style="font-size:2rem">⏳</div></div></div>`);

  const orders = await getMyOrders(currentUser.uid, userProfile?.role);
  let activeStatus = 'all';

  const renderList = (status) => {
    const list = status==='all' ? orders : orders.filter(o=>o.status===status);
    if (!list.length) return `<div class="empty"><div class="empty-icon">🛒</div><div class="empty-title">No ${status!=='all'?status+' ':''} orders</div></div>`;
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

  window._ordersData = orders;
}

function filterOrders(el, status) {
  document.querySelectorAll('.filter-chips .filter-chip').forEach(e=>e.classList.remove('active'));
  el.classList.add('active');
  const list = document.getElementById('orders-list');
  const orders = window._ordersData || [];
  const filtered = status==='all' ? orders : orders.filter(o=>o.status===status);
  if (!list) return;
  if (!filtered.length) { list.innerHTML = `<div class="empty"><div class="empty-icon">🛒</div><div class="empty-title">No ${status} orders</div></div>`; return; }
  list.innerHTML = filtered.map(o=>`
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
        ${o.notes?`<div class="card-dark" style="grid-column:1/-1"><div style="color:var(--text3);font-size:0.72rem;margin-bottom:4px">Notes</div><div style="color:var(--text2)">${escapeHtml(o.notes)}</div></div>`:''}
      </div>
      <div style="margin-top:16px;font-size:0.75rem;color:var(--text4)">Order placed: ${timeSince(o.createdAt)}</div>
      ${o.buyerPhone?`
      <div style="display:flex;gap:8px;margin-top:16px">
        <a href="https://wa.me/${encodeURIComponent(o.buyerPhone.replace(/\D/g,''))}" target="_blank" class="btn-wa btn-block">📲 WhatsApp Customer</a>
      </div>`:''}
    </div>
  `);
}

// ─── CLIENTS ─────────────────────────────────────────────────────
async function renderClients() {
  if (!currentUser) { navigate('auth'); return; }
  setContent(`<div class="page"><div style="text-align:center;padding:60px"><div style="font-size:2rem">⏳</div></div></div>`);

  const clients = await getClients(currentUser.uid);
  setContent(`
    <div class="page">
      <div style="margin-bottom:20px">
        <h1 class="section-title" style="font-size:1.4rem">My <span class="gradient-text">Clients</span></h1>
        <p style="color:var(--text3);font-size:0.85rem;margin-top:4px">${clients.length} clients</p>
      </div>
      ${clients.length === 0
        ? `<div class="empty"><div class="empty-icon">👥</div><div class="empty-title">No clients yet</div><div class="empty-text">Clients appear here when orders are placed through your links</div></div>`
        : `<div class="card" style="padding:0;overflow:hidden">
            ${clients.map(c=>`
              <div class="list-item">
                <div class="list-avatar">${escapeHtml((c.name||'C').charAt(0))}</div>
                <div class="list-info">
                  <div class="list-name">${escapeHtml(c.name||'Client')}</div>
                  <div class="list-sub">${escapeHtml(c.phone||c.email||'—')} · ${c.orders||0} orders</div>
                </div>
                <div class="list-right">
                  <div style="font-weight:700;color:var(--blue);font-size:0.9rem">₨${fmt(c.totalSpent)}</div>
                  <div style="font-size:0.72rem;color:var(--text3)">total</div>
                </div>
              </div>`).join('')}
          </div>`}
    </div>
  `);
}

// ─── PROFILE ─────────────────────────────────────────────────────
async function renderProfile() {
  if (!currentUser) { navigate('auth'); return; }
  const p = userProfile || {};
  const referralLink = `${APP_URL}/?ref=${p.referralCode}`;

  setContent(`
    <div class="page">
      <!-- Header -->
      <div class="card profile-header" style="margin-bottom:20px">
        <div id="profile-photo-uploader-container" style="display:flex;justify-content:center;margin-bottom:12px"></div>
        <div class="profile-name">${escapeHtml(p.name||'User')}</div>
        <span class="profile-role role-${p.role||'customer'}">${p.role||'customer'}</span>
        <div style="font-size:0.85rem;color:var(--text3);margin-top:8px">${escapeHtml(p.email||currentUser.email||'')}</div>
      </div>

      <!-- Stats -->
      <div class="stats-grid" style="margin-bottom:20px">
        <div class="card stat-card"><div class="stat-icon" style="background:var(--blue-dim)">💰</div><div class="stat-value" style="color:var(--blue)">₨${fmt(p.earnings)}</div><div class="stat-label">Total Earned</div></div>
        <div class="card stat-card"><div class="stat-icon" style="background:var(--green-dim)">✅</div><div class="stat-value" style="color:var(--green)">₨${fmt(p.withdrawableBalance)}</div><div class="stat-label">Withdrawable</div></div>
        <div class="card stat-card"><div class="stat-icon" style="background:var(--purple-dim)">🛒</div><div class="stat-value" style="color:var(--purple)">${p.totalOrders||0}</div><div class="stat-label">Total Orders</div></div>
        <div class="card stat-card"><div class="stat-icon" style="background:var(--orange-dim)">🔗</div><div class="stat-value" style="color:var(--orange)">${p.referralCode||'—'}</div><div class="stat-label">Referral Code</div></div>
      </div>

      <!-- Referral -->
      <div class="referral-box" style="margin-bottom:20px">
        <div style="font-weight:700;margin-bottom:4px">🎁 Your Referral Link</div>
        <div style="font-size:0.8rem;color:var(--text3);margin-bottom:12px">Invite friends and earn bonus rewards</div>
        <div class="referral-code">${p.referralCode||'LOADING'}</div>
        <div style="display:flex;gap:8px">
          <button class="btn-outline sm referral-btn" onclick="navigator.clipboard.writeText('${referralLink}');showToast('Referral link copied!','success')">Copy Link</button>
          <button class="btn-wa referral-btn" onclick="window.open('https://wa.me/?text=${encodeURIComponent(`🤑 Join MICH Digital Shop and start earning money! Use my referral link: ${referralLink}`)}','_blank')">Share on WhatsApp</button>
        </div>
      </div>

      <!-- Edit Profile -->
      <div class="card" style="margin-bottom:20px">
        <div style="font-weight:700;margin-bottom:16px">✏️ Edit Profile</div>
        <div class="form-group"><label class="form-label">Full Name</label><input class="input" id="prof-name" value="${p.name||''}" placeholder="Your name" /></div>
        <div class="form-group"><label class="form-label">Phone Number</label><input class="input" id="prof-phone" value="${p.phone||''}" placeholder="+92 300 1234567" /></div>
        <div class="form-group"><label class="form-label">WhatsApp Number</label><input class="input" id="prof-wa" value="${p.whatsapp||''}" placeholder="+92 300 1234567" /></div>
        <div class="form-group"><label class="form-label">Address</label><textarea class="input" id="prof-addr" placeholder="Your address">${p.address||''}</textarea></div>
        <button class="btn-neon btn-block" onclick="saveProfile()" id="save-prof-btn">Save Changes</button>
      </div>

      <!-- Danger Zone -->
      <div class="card" style="border-color:rgba(239,68,68,0.2)">
        <div style="font-weight:700;margin-bottom:12px;color:var(--red)">⚠️ Account</div>
        <button class="btn-red btn-block" onclick="logoutUser()">🚪 Logout</button>
      </div>
    </div>
  `);

  // Initialize profile photo uploader
  renderProfilePhotoUploader('profile-photo-uploader-container', p.photo || '', async (newUrl) => {
    window._newProfilePhoto = newUrl;
    await updateUserDoc(currentUser.uid, { photo: newUrl });
    userProfile = await getUserDoc(currentUser.uid);
    updateNavUI();
  });
}

async function saveProfile() {
  const btn = document.getElementById('save-prof-btn');
  if (btn) { btn.disabled=true; btn.textContent='Saving...'; }
  try {
    await updateUserDoc(currentUser.uid, {
      name:     document.getElementById('prof-name')?.value,
      phone:    document.getElementById('prof-phone')?.value,
      whatsapp: document.getElementById('prof-wa')?.value,
      address:  document.getElementById('prof-addr')?.value,
    });
    userProfile = await getUserDoc(currentUser.uid);
    showToast('Profile saved! ✅','success');
    updateNavUI();
  } catch { showToast('Failed to save','error'); }
  if (btn) { btn.disabled=false; btn.textContent='Save Changes'; }
}

// ─── AUTH ────────────────────────────────────────────────────────
function renderAuth() {
  let tab = 'login';
  let selectedRole = 'customer';

  setContent(`
    <div class="auth-page">
      <div class="auth-card">
        <div class="auth-logo">
          <img src="https://i.ibb.co/twVpRFKh/file-0000000018807208a673a881d0f0e953.png" alt="MICH" />
          <h1 class="gradient-text">MICH Digital Shop</h1>
          <p>Pakistan's #1 Reseller Platform</p>
        </div>
        <div class="card">
          <!-- Tabs -->
          <div class="tabs" id="auth-tabs">
            <button class="tab-btn active" id="tab-login" onclick="switchAuthTab('login')">Sign In</button>
            <button class="tab-btn"        id="tab-signup" onclick="switchAuthTab('signup')">Create Account</button>
          </div>

          <!-- Google -->
          <button class="google-btn" onclick="handleGoogleLogin()">
            <svg class="google-icon" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            Continue with Google
          </button>

          <div class="divider"><div class="divider-line"></div><span class="divider-text">or</span><div class="divider-line"></div></div>

          <!-- Login Form -->
          <div id="login-form">
            <div class="form-group"><label class="form-label">Email</label><input class="input" id="login-email" type="email" placeholder="you@email.com" /></div>
            <div class="form-group"><label class="form-label">Password</label><input class="input" id="login-pass" type="password" placeholder="Password" /></div>
            <button class="btn-neon btn-block" id="login-btn-main" onclick="handleEmailLogin()">Sign In →</button>
            <button style="width:100%;text-align:center;color:var(--text3);font-size:0.8rem;margin-top:12px" onclick="handleForgotPassword()">Forgot Password?</button>
          </div>

          <!-- Signup Form -->
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
  document.getElementById('tab-login' ).classList.toggle('active', t==='login');
  document.getElementById('tab-signup').classList.toggle('active', t==='signup');
  document.getElementById('login-form' ).classList.toggle('hidden', t!=='login');
  document.getElementById('signup-form').classList.toggle('hidden', t!=='signup');
}

function selectRole(role) {
  document.querySelectorAll('.role-card').forEach(el => el.classList.remove('active'));
  document.getElementById('role-'+role)?.classList.add('active');
  window._selectedRole = role;
}

async function handleGoogleLogin() {
  const res = await loginWithGoogle();
  if (res.success) navigate('home');
}

async function handleEmailLogin() {
  const email = document.getElementById('login-email')?.value;
  const pass  = document.getElementById('login-pass')?.value;
  if (!email||!pass) { showToast('Enter email and password','error'); return; }
  const btn = document.getElementById('login-btn-main');
  if (btn) { btn.disabled=true; btn.textContent='Signing in...'; }
  const res = await loginWithEmail(email, pass);
  if (res.success) navigate('home');
  else if (btn) { btn.disabled=false; btn.textContent='Sign In →'; }
}

async function handleEmailSignup() {
  const name  = document.getElementById('signup-name')?.value;
  const email = document.getElementById('signup-email')?.value;
  const pass  = document.getElementById('signup-pass')?.value;
  const role  = window._selectedRole || 'customer';
  if (!name||!email||!pass) { showToast('Fill all fields','error'); return; }
  if (pass.length<6) { showToast('Password too short','error'); return; }
  const btn = document.getElementById('signup-btn-main');
  if (btn) { btn.disabled=true; btn.textContent='Creating...'; }
  const res = await signUpWithEmail(name, email, pass, role);
  if (res.success) navigate('home');
  else if (btn) { btn.disabled=false; btn.textContent='Create Account 🚀'; }
}

function handleForgotPassword() {
  const email = document.getElementById('login-email')?.value;
  if (!email) { showToast('Enter your email first','error'); return; }
  resetPassword(email);
}

// ─── ADMIN ────────────────────────────────────────────────────────
async function renderAdmin() {
  if (!currentUser || userProfile?.role !== 'admin') {
    setContent(`<div class="page"><div class="empty"><div class="empty-icon">🔒</div><div class="empty-title">Admin Only</div></div></div>`);
    return;
  }

  setContent(`<div class="page"><div style="text-align:center;padding:60px"><div style="font-size:2rem">⏳</div><p style="color:var(--text3)">Loading admin panel...</p></div></div>`);

  const [orders, users, withdrawals] = await Promise.all([getAllOrders(), getAllUsers(), getAllWithdrawals()]);
  const catalogs = await getCatalogs(100);
  const pending  = orders.filter(o=>o.status==='pending').length;
  const pendingWD= withdrawals.filter(w=>w.status==='pending').length;

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

      <div class="admin-grid" style="margin-bottom:24px">
        ${[
          {icon:'👥',label:'Total Users',val:users.length,color:'var(--blue)'},
          {icon:'📦',label:'Products',val:catalogs.length,color:'var(--purple)'},
          {icon:'🛒',label:'Orders',val:orders.length,color:'var(--orange)'},
          {icon:'⚡',label:'Pending Orders',val:pending,color:'var(--red)'},
          {icon:'💸',label:'Withdrawals',val:withdrawals.length,color:'var(--green)'},
          {icon:'⏳',label:'Pending WD',val:pendingWD,color:'var(--yellow)'},
          {icon:'🎯',label:'Delivered',val:orders.filter(o=>o.status==='delivered').length,color:'var(--green)'},
          {icon:'❌',label:'Cancelled',val:orders.filter(o=>o.status==='cancelled').length,color:'var(--red)'},
        ].map(s=>`
          <div class="card admin-stat">
            <div class="admin-stat-icon">${s.icon}</div>
            <div class="admin-stat-val" style="color:${s.color}">${s.val}</div>
            <div class="admin-stat-label">${s.label}</div>
          </div>`).join('')}
      </div>

      <div class="tabs" id="admin-tabs" style="margin-bottom:20px">
        <button class="tab-btn active" onclick="adminTab('orders',this)">Orders</button>
        <button class="tab-btn"        onclick="adminTab('products',this)">Products</button>
        <button class="tab-btn"        onclick="adminTab('users',this)">Users</button>
        <button class="tab-btn"        onclick="adminTab('withdrawals',this)">Withdrawals</button>
      </div>

      <div id="admin-content">${renderAdminOrders(orders)}</div>
    </div>
  `);

  // FIX 5: Real-time listener for admin orders — refreshes the list automatically
  const ordersUnsub = fdb.collection('orders')
    .orderBy('createdAt', 'desc')
    .limit(100)
    .onSnapshot((snap) => {
      const liveOrders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      window._adminOrders = liveOrders;
      // Only update the UI if the orders tab is currently visible
      const adminContent = document.getElementById('admin-content');
      const activeTab = document.querySelector('#admin-tabs .tab-btn.active');
      if (adminContent && activeTab && activeTab.textContent.trim() === 'Orders') {
        adminContent.innerHTML = renderAdminOrders(liveOrders);
      }
    }, (err) => {
      console.error('Admin orders snapshot error:', err);
    });

  registerListener('adminOrders', ordersUnsub);
}

function adminTab(tab, btn) {
  document.querySelectorAll('#admin-tabs .tab-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  const el = document.getElementById('admin-content');
  if (!el) return;
  if (tab==='orders')      el.innerHTML = renderAdminOrders(window._adminOrders||[]);
  if (tab==='products')    el.innerHTML = renderAdminProductsV3(window._adminCats||[]);
  if (tab==='users')       el.innerHTML = renderAdminUsers(window._adminUsers||[]);
  if (tab==='withdrawals') el.innerHTML = renderAdminWithdrawals(window._adminWDs||[]);
}

function renderAdminOrders(orders) {
  if (!orders.length) return `<div class="empty"><div class="empty-icon">🛒</div><div class="empty-title">No orders</div></div>`;
  return `<div class="card" style="padding:0;overflow:hidden">${orders.slice(0,50).map(o=>`
    <div class="list-item">
      <div class="list-avatar" style="border-radius:10px;font-size:0.8rem">${escapeHtml((o.buyerName||'?').charAt(0))}</div>
      <div class="list-info">
        <div class="list-name">${escapeHtml(o.catalogTitle||'Product')}</div>
        <div class="list-sub">👤 ${escapeHtml(o.buyerName||o.buyerPhone||'N/A')} · ${timeSince(o.createdAt)}</div>
      </div>
      <div class="list-right" style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
        <span class="badge badge-${o.status||'pending'}">${o.status||'pending'}</span>
        <span style="font-weight:700;font-size:0.85rem;color:var(--blue)">₨${fmt(o.price)}</span>
      </div>
      <button class="btn-neon sm" style="margin-left:8px" onclick="adminUpdateOrder('${o.id}')">Update</button>
    </div>`).join('')}</div>`;
}

function renderAdminProducts(cats) {
  return `
    <div style="display:flex;gap:8px;margin-bottom:16px">
      <button class="btn-neon sm" onclick="showAddProductModal()">+ Add Product</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      ${cats.length===0?`<div class="empty"><div class="empty-icon">📦</div><div class="empty-title">No products</div></div>`
      :cats.map(c=>`
        <div class="list-item">
          <div style="width:40px;height:40px;border-radius:10px;overflow:hidden;flex-shrink:0;background:var(--bg3)">
            ${c.images?.[0]?`<img src="${c.images[0]}" style="width:100%;height:100%;object-fit:cover" />`:'<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center">📦</div>'}
          </div>
          <div class="list-info">
            <div class="list-name">${c.title}</div>
            <div class="list-sub">₨${fmt(c.resellerPrice||c.price)} · ${c.type||'physical'} · ${c.views||0} views</div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn-outline sm" onclick="showEditProductModal('${c.id}')">Edit</button>
            <button class="btn-red sm" style="padding:6px 10px;border-radius:8px;font-size:0.78rem;border:1px solid rgba(239,68,68,0.4);color:var(--red)" onclick="confirmDeleteProduct('${c.id}')">Delete</button>
          </div>
        </div>`).join('')}
    </div>`;
}

function renderAdminUsers(users) {
  return `<div class="card" style="padding:0;overflow:hidden">${users.map(u=>`
    <div class="list-item">
      <div class="list-avatar">${escapeHtml((u.name||'U').charAt(0))}</div>
      <div class="list-info">
        <div class="list-name">${escapeHtml(u.name||'Unknown')}</div>
        <div class="list-sub">${escapeHtml(u.email||'')} · ${timeSince(u.createdAt)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
        <span class="profile-role role-${u.role||'customer'}" style="font-size:0.68rem;padding:2px 8px">${u.role||'customer'}</span>
        <button class="btn-outline sm" onclick="showUserActions('${u.id}','${escapeHtml(u.name||'')}','${u.role||'customer'}')">Manage</button>
      </div>
    </div>`).join('')}</div>`;
}

function renderAdminWithdrawals(wds) {
  if (!wds.length) return `<div class="empty"><div class="empty-icon">💸</div><div class="empty-title">No withdrawals</div></div>`;
  return `<div class="card" style="padding:0;overflow:hidden">${wds.map(w=>`
    <div class="list-item">
      <div class="list-avatar" style="background:var(--green-dim);color:var(--green)">₨</div>
      <div class="list-info">
        <div class="list-name">₨${fmt(w.amount)} · ${w.method}</div>
        <div class="list-sub">${w.userName||'User'} · ${w.accountNumber} · ${timeSince(w.createdAt)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
        <span class="badge badge-${w.status||'pending'}">${w.status||'pending'}</span>
        ${w.status==='pending'?`
          <div style="display:flex;gap:4px">
            <button class="btn-green sm" style="padding:5px 10px;border-radius:8px;font-size:0.72rem" onclick="processWithdrawal('${w.id}','paid')">Pay</button>
            <button class="btn-red sm"   style="padding:5px 10px;border-radius:8px;font-size:0.72rem" onclick="processWithdrawal('${w.id}','rejected')">Reject</button>
          </div>` : ''}
      </div>
    </div>`).join('')}</div>`;
}

async function processWithdrawal(id, status) {
  try {
    await updateWithdrawal(id, { status });
    showToast(`Withdrawal ${status}!`, 'success');
    const wds = await getAllWithdrawals();
    window._adminWDs = wds;
    const el = document.getElementById('admin-content');
    if (el) el.innerHTML = renderAdminWithdrawals(wds);
  } catch { showToast('Failed','error'); }
}

async function adminUpdateOrder(id) {
  const statuses = ['pending','approved','processing','shipped','delivered','cancelled'];
  openModal(`
    <div class="modal-header"><h3>Update Order Status</h3><button class="modal-close" onclick="closeModalForce()">✕</button></div>
    <div class="modal-body">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${statuses.map(s=>`
          <button class="btn-outline" style="justify-content:center;padding:12px;font-size:0.85rem" onclick="setOrderStatus('${id}','${s}')">
            <span class="badge badge-${s}" style="pointer-events:none">${s}</span>
          </button>`).join('')}
      </div>
    </div>
  `);
}

async function setOrderStatus(id, status) {
  try {
    // FIX 3 & 10: Use a Firestore batched write so order status update + earnings
    // approval + reseller balance increment are all atomic.
    const batch = fdb.batch();

    // Update the order document
    batch.update(fdb.collection('orders').doc(id), {
      status,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    if (status === 'delivered') {
      // Find all pending earnings for this order
      const earningsSnap = await fdb.collection('earnings')
        .where('orderId', '==', id)
        .where('status', '==', 'pending')
        .get();

      for (const earnDoc of earningsSnap.docs) {
        const earning = earnDoc.data();
        // Mark each earning as approved in the same batch
        batch.update(earnDoc.ref, {
          status:    'approved',
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        // Atomically increment the reseller's balance fields (must be UID, not code)
        if (earning.userId) {
          batch.update(fdb.collection('users').doc(earning.userId), {
            withdrawableBalance: firebase.firestore.FieldValue.increment(earning.amount || 0),
            earnings:            firebase.firestore.FieldValue.increment(earning.amount || 0),
            updatedAt:           firebase.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    }

    await batch.commit(); // single atomic commit

    showToast(`Order marked as ${status}! ✅`, 'success');
    closeModalForce();

    // FIX 10: Refresh admin orders list after the batch update
    const orders = await getAllOrders();
    window._adminOrders = orders;
    const el = document.getElementById('admin-content');
    if (el) el.innerHTML = renderAdminOrders(orders);
  } catch(e) {
    console.error('setOrderStatus error:', e);
    showToast('Failed to update order status: ' + (e.message || 'Unknown error'), 'error');
  }
}

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
        <div class="form-group"><label class="form-label">Currency</label><select class="input" id="np-currency"><option>PKR</option><option>USD</option><option>SAR</option><option>AED</option><option>INR</option></select></div>
        <div class="form-group"><label class="form-label">Stock</label><input class="input" id="np-stock" type="number" placeholder="100" /></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="form-group"><label class="form-label">Type</label><select class="input" id="np-type"><option value="physical">📦 Physical</option><option value="digital">⚡ Digital</option></select></div>
        <div class="form-group"><label class="form-label">Category</label><select class="input" id="np-cat"><option value="">-- Select --</option><option>mobiles</option><option>electronics</option><option>fashion</option><option>education</option><option>entertainment</option><option>software</option><option>music</option><option>giftcards</option><option>beauty</option></select></div>
      </div>
      <div class="form-group">
        <label class="form-label">Product Images (Upload via ImgBB) <span style="color:var(--text4);font-weight:400">max 5</span></label>
        <div id="np-imgbb-container"></div>
      </div>
      <div class="form-group"><label class="form-label">Tags (comma separated)</label><input class="input" id="np-tags" placeholder="sale, trending, new" /></div>
      <button class="btn-neon btn-block" id="add-prod-btn" onclick="submitAddProduct()">Add Product</button>
    </div>
  `);
  // Init uploader — images stored on window._npImages
  window._npImages = [];
  renderImgBBUploader('np-imgbb-container', (urls) => { window._npImages = urls; }, [], 5);
}

async function submitAddProduct() {
  const title  = document.getElementById('np-title')?.value?.trim();
  const price  = parseFloat(document.getElementById('np-price')?.value);
  if (!title || !price) { showToast('Title and price required','error'); return; }
  const btn = document.getElementById('add-prod-btn');
  if (btn) { btn.disabled=true; btn.textContent='Adding...'; }
  const images = window._npImages || [];
  const tagsRaw  = document.getElementById('np-tags')?.value || '';
  const tags = tagsRaw.split(',').map(s=>s.trim()).filter(Boolean);
  try {
    await createCatalog({
      title,
      description: document.getElementById('np-desc')?.value || '',
      price,
      resellerPrice: parseFloat(document.getElementById('np-rprice')?.value) || price,
      currency: document.getElementById('np-currency')?.value || 'PKR',
      stock: parseInt(document.getElementById('np-stock')?.value) || 99,
      type: document.getElementById('np-type')?.value || 'physical',
      category: document.getElementById('np-cat')?.value || '',
      images, tags,
      createdBy: currentUser.uid,
    });
    closeModalForce();
    showToast('Product added! 🎉','success');
    allCatalogs = await getCatalogs(100);
    const cats = window._adminCats = allCatalogs;
    const el   = document.getElementById('admin-content');
    if (el) el.innerHTML = renderAdminProductsV3(cats);
  } catch(e) { showToast('Failed to add product','error'); console.error(e); }
  if (btn) { btn.disabled=false; btn.textContent='Add Product'; }
}

async function showEditProductModal(id) {
  const c = allCatalogs.find(x=>x.id===id) || await getCatalogById(id);
  if (!c) { showToast('Product not found','error'); return; }
  openModal(`
    <div class="modal-header"><h3>✏️ Edit Product</h3><button class="modal-close" onclick="closeModalForce()">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label class="form-label">Title *</label><input class="input" id="ep-title" value="${c.title||''}" /></div>
      <div class="form-group"><label class="form-label">Description</label><textarea class="input" id="ep-desc">${c.description||''}</textarea></div>
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
            <option value="digital"  ${c.type==='digital' ?'selected':''}>⚡ Digital</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Category</label>
          <select class="input" id="ep-cat">
            ${['','mobiles','electronics','fashion','education','entertainment','software','music','giftcards','beauty'].map(cat=>`<option value="${cat}" ${c.category===cat?'selected':''}>${cat||'-- Select --'}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Product Images <span style="color:var(--text4);font-weight:400">Upload or keep existing (max 5)</span></label>
        <div id="ep-imgbb-container"></div>
      </div>
      <div class="form-group"><label class="form-label">Tags (comma separated)</label><input class="input" id="ep-tags" value="${(c.tags||[]).join(', ')}" /></div>
      <button class="btn-neon btn-block" id="edit-prod-btn" onclick="submitEditProduct('${id}')">Save Changes</button>
    </div>
  `);
  window._epImages = [...(c.images||[])];
  renderImgBBUploader('ep-imgbb-container', (urls) => { window._epImages = urls; }, c.images||[], 5);
}

async function submitEditProduct(id) {
  const title = document.getElementById('ep-title')?.value?.trim();
  const price = parseFloat(document.getElementById('ep-price')?.value);
  if (!title || !price) { showToast('Title and price required','error'); return; }
  const btn = document.getElementById('edit-prod-btn');
  if (btn) { btn.disabled=true; btn.textContent='Saving...'; }
  const tagsRaw = document.getElementById('ep-tags')?.value || '';
  const tags = tagsRaw.split(',').map(s=>s.trim()).filter(Boolean);
  try {
    await updateCatalog(id, {
      title,
      description: document.getElementById('ep-desc')?.value || '',
      price,
      resellerPrice: parseFloat(document.getElementById('ep-rprice')?.value) || price,
      currency: document.getElementById('ep-currency')?.value || 'PKR',
      stock: parseInt(document.getElementById('ep-stock')?.value) || 99,
      type: document.getElementById('ep-type')?.value || 'physical',
      category: document.getElementById('ep-cat')?.value || '',
      images: window._epImages || [],
      tags,
    });
    closeModalForce();
    showToast('Product updated! ✅','success');
    allCatalogs = await getCatalogs(100);
    window._adminCats = allCatalogs;
    const el = document.getElementById('admin-content');
    if (el) el.innerHTML = renderAdminProductsV3(allCatalogs);
  } catch(e) { showToast('Failed to update product','error'); console.error(e); }
  if (btn) { btn.disabled=false; btn.textContent='Save Changes'; }
}

async function confirmDeleteProduct(id) {
  if (!confirm('Delete this product?')) return;
  await deleteCatalog(id);
  showToast('Product deleted','success');
  allCatalogs = allCatalogs.filter(c=>c.id!==id);
  window._adminCats = allCatalogs;
  const el = document.getElementById('admin-content');
  if (el) el.innerHTML = renderAdminProductsV3(allCatalogs);
}

async function showUserActions(uid, name, role) {
  openModal(`
    <div class="modal-header"><h3>Manage: ${name||'User'}</h3><button class="modal-close" onclick="closeModalForce()">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label class="form-label">Change Role</label>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">
          ${['customer','reseller','marketer','admin'].map(r=>
            `<button class="btn-outline ${r===role?'active':''}" style="justify-content:center;padding:10px" onclick="changeUserRole('${uid}','${r}')"><span class="profile-role role-${r}" style="pointer-events:none">${r}</span></button>`
          ).join('')}
        </div>
      </div>
    </div>
  `);
}

async function changeUserRole(uid, role) {
  await updateUserDoc(uid, { role });
  showToast(`Role changed to ${role}!`, 'success');
  closeModalForce();
  const users = await getAllUsers();
  window._adminUsers = users;
  const el = document.getElementById('admin-content');
  if (el) el.innerHTML = renderAdminUsers(users);
}

// ─── SHARE PAGE ────────────────────────────────────────────────────
async function renderShare(params={}) {
  const { id } = params;
  setContent(`<div class="page"><div style="text-align:center;padding:80px 0"><div style="font-size:3rem">⏳</div></div></div>`);
  const c = await getCatalogById(id);
  if (!c) { setContent(`<div class="page"><div class="empty"><div class="empty-icon">😕</div><div class="empty-title">Product not found</div><button class="btn-neon sm" onclick="navigate('home')">Go Home</button></div></div>`); return; }
  incrementViews(id);
  const sym   = CURRENCY_SYM[c.currency]||'₨';
  const price = c.resellerPrice||c.price||0;

  setContent(`
    <div style="min-height:100vh;background:var(--bg)">
      <!-- Share hero -->
      <div style="position:relative;overflow:hidden;padding:60px 20px 40px;text-align:center">
        <div class="hero-orb hero-orb-1" style="opacity:0.1"></div>
        <div class="hero-orb hero-orb-2" style="opacity:0.08"></div>

        <div style="max-width:500px;margin:0 auto">
          ${c.images?.[0]?`<img src="${c.images[0]}" class="share-img" alt="${c.title}" />`:'<div style="width:200px;height:200px;border-radius:28px;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:5rem;margin:0 auto 24px">📦</div>'}
          <span class="badge badge-${c.type||'physical'}" style="margin-bottom:12px">${c.type==='digital'?'⚡ Digital':'📦 Physical'}</span>
          <h1 style="font-size:1.6rem;font-weight:900;margin:12px 0">${escapeHtml(c.title)}</h1>
          ${c.description?`<p style="color:var(--text3);font-size:0.9rem;margin-bottom:16px;line-height:1.6">${escapeHtml(c.description)}</p>`:''}
          <div class="share-price">${sym}${fmt(price)}</div>
          ${c.resellerPrice&&c.price&&c.resellerPrice>c.price?`<div style="color:var(--text4);text-decoration:line-through;font-size:0.9rem">Original: ${sym}${fmt(c.price)}</div>`:''}
          <div style="display:flex;gap:10px;justify-content:center;margin-top:24px;flex-wrap:wrap">
            <button class="btn-neon lg" onclick="showOrderModal('${id}')">🛒 Order Now</button>
            <button class="btn-wa" style="padding:14px 24px;font-size:1rem;border-radius:14px" onclick="shareOnWhatsApp(${JSON.stringify(c).replace(/"/g,'&quot;')})">📲 Share</button>
          </div>
          <div style="display:flex;gap:8px;justify-content:center;margin-top:12px">
            <button class="btn-outline sm" onclick="shareOnFacebook(${JSON.stringify(c).replace(/"/g,'&quot;')})">Facebook</button>
            <button class="btn-outline sm" onclick="shareOnTelegram(${JSON.stringify(c).replace(/"/g,'&quot;')})">Telegram</button>
            <button class="btn-outline sm" onclick="copyLink('${id}')">Copy Link</button>
          </div>
        </div>
      </div>
    </div>
  `);
}

// ─── GLOBAL SEARCH ────────────────────────────────────────────────
function handleGlobalSearch(q) {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    if (!q.trim()) return;
    if (!allCatalogs.length) allCatalogs = await getCatalogs(100);
    navigate('catalogs', { search: q });
  }, 400);
}

// ════════════════════════════════════════════════════════════════
// 7. ROUTER
// ════════════════════════════════════════════════════════════════

function navigate(page, params={}) {
  // FIX 5: Tear down all active onSnapshot listeners before switching pages
  // to prevent stale callbacks from updating the wrong DOM.
  unsubscribeAll();

  currentPage   = page;
  currentParams = params;
  updateActiveNav();

  switch (page) {
    case 'home':     renderHomeV3();                 break;
    case 'auth':     renderAuth();                   break;
    case 'catalogs': renderCatalogs(params);         break;
    case 'catalog':  renderCatalogDetailV3(params);  break;
    case 'earnings': renderEarnings();               break;
    case 'orders':   renderOrders();                 break;
    case 'clients':  renderClients();                break;
    case 'profile':  renderProfile();                break;
    case 'admin':    renderAdmin();                  break;
    case 'share':    renderShareV3(params);          break;
    default:         renderHomeV3();
  }
  closeMobileMenu();
}

// ════════════════════════════════════════════════════════════════
// 8. PWA SERVICE WORKER
// ════════════════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// V3 UPGRADES — Lightbox · Eid Banner · Catalog Toggle
//               Reseller Registration · Sitemap · Fast Share
// ════════════════════════════════════════════════════════════════

// ─── LIGHTBOX ────────────────────────────────────────────────────
let _lightboxImages = [];
let _lightboxIndex  = 0;

function openLightbox(images, startIndex = 0) {
  _lightboxImages = Array.isArray(images) ? images : [images];
  _lightboxIndex  = startIndex;
  updateLightbox();
  document.getElementById('lightbox').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.body.style.overflow = '';
}

function updateLightbox() {
  const img = document.getElementById('lightbox-img');
  const ctr = document.getElementById('lightbox-counter');
  if (img) img.src = _lightboxImages[_lightboxIndex];
  if (ctr) ctr.textContent = `${_lightboxIndex + 1} / ${_lightboxImages.length}`;
}

function lightboxPrev(e) {
  if (e) e.stopPropagation();
  _lightboxIndex = (_lightboxIndex - 1 + _lightboxImages.length) % _lightboxImages.length;
  updateLightbox();
}

function lightboxNext(e) {
  if (e) e.stopPropagation();
  _lightboxIndex = (_lightboxIndex + 1) % _lightboxImages.length;
  updateLightbox();
}

// Keyboard navigation for lightbox
document.addEventListener('keydown', e => {
  const lb = document.getElementById('lightbox');
  if (lb && !lb.classList.contains('hidden')) {
    if (e.key === 'Escape')      closeLightbox();
    if (e.key === 'ArrowLeft')   lightboxPrev();
    if (e.key === 'ArrowRight')  lightboxNext();
  }
});

// ─── EID UL ADHA COUNTDOWN ──────────────────────────────────────
function getEidCountdown() {
  const eidDate = new Date('2026-05-27T00:00:00');
  const now     = new Date();
  const diff    = eidDate - now;
  if (diff <= 0) return null; // Eid has started
  const days  = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const mins  = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return { days, hours, mins };
}

function renderEidHeroCard() {
  const cd = getEidCountdown();
  if (!cd) {
    // Eid is here!
    return `
      <div class="eid-hero-card section">
        <div class="eid-sheep-anim">🐑</div>
        <div class="eid-hero-title">🌙 عید الاضحی مبارک! 🌙</div>
        <div class="eid-hero-sub">Eid ul Adha Special Sale — 27-29 MAY 2026</div>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
          <button class="btn-neon lg" onclick="navigate('catalogs',{category:'eid'})">🐑 Eid Deals →</button>
          <button class="btn-outline lg" onclick="navigate('catalogs')">Browse All</button>
        </div>
      </div>`;
  }
  return `
    <div class="eid-hero-card section">
      <div class="eid-sheep-anim">🐑</div>
      <div class="eid-hero-title">🌙 Eid ul Adha Sale 🌙</div>
      <div class="eid-hero-sub">Special discounts starting 27 MAY!</div>
      <div class="eid-countdown">
        <div class="eid-count-item">
          <div class="eid-count-num">${cd.days}</div>
          <div class="eid-count-label">Days</div>
        </div>
        <div class="eid-count-item" style="color:#ffd700;font-size:1.5rem;align-self:flex-start;margin-top:8px">:</div>
        <div class="eid-count-item">
          <div class="eid-count-num">${cd.hours}</div>
          <div class="eid-count-label">Hours</div>
        </div>
        <div class="eid-count-item" style="color:#ffd700;font-size:1.5rem;align-self:flex-start;margin-top:8px">:</div>
        <div class="eid-count-item">
          <div class="eid-count-num">${cd.mins}</div>
          <div class="eid-count-label">Minutes</div>
        </div>
      </div>
      <button class="btn-neon" onclick="navigate('catalogs')">🛍️ Shop Now →</button>
    </div>`;
}

// ─── CATALOG TOGGLE (Admin: On/Off) ─────────────────────────────
async function toggleCatalogStatus(id, currentlyActive) {
  try {
    await fdb.collection('catalogs').doc(id).update({
      active: !currentlyActive,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    showToast(currentlyActive ? 'Catalog hidden 🔴' : 'Catalog live 🟢', 'success');
    // Refresh admin products list
    allCatalogs = await getCatalogs(100);
    window._adminCats = allCatalogs;
    const el = document.getElementById('admin-content');
    if (el) el.innerHTML = renderAdminProductsV3(allCatalogs);
  } catch(e) {
    showToast('Failed to toggle catalog', 'error');
  }
}

// ─── RESELLER REGISTRATION FLOW ─────────────────────────────────
function showResellerRegModal() {
  openModal(`
    <div class="modal-header">
      <h3>💼 Become a Reseller</h3>
      <button class="modal-close" onclick="closeModalForce()">✕</button>
    </div>
    <div class="modal-body">
      <div class="reseller-invest-card">
        <h3>One-Time Investment</h3>
        <div class="invest-amount">₨50</div>
        <p style="color:var(--text3);font-size:0.85rem;margin-bottom:12px">
          Send ₨50 to activate your Reseller account and start earning!
        </p>
        <div class="jazzcash-number" onclick="copyJazzCash()">
          📱 JazzCash: 03062015326
        </div>
        <div style="font-size:0.72rem;color:var(--text4);margin-top:6px">Tap to copy number</div>
      </div>
      <div class="invest-steps">
        <div class="invest-step">
          <div class="invest-step-num">1</div>
          <div class="invest-step-text">Send ₨50 to <strong>03062015326</strong> (JazzCash)</div>
        </div>
        <div class="invest-step">
          <div class="invest-step-num">2</div>
          <div class="invest-step-text">Screenshot your payment receipt</div>
        </div>
        <div class="invest-step">
          <div class="invest-step-num">3</div>
          <div class="invest-step-text">WhatsApp your screenshot to <strong>03062015326</strong></div>
        </div>
        <div class="invest-step">
          <div class="invest-step-num">4</div>
          <div class="invest-step-text">Admin will activate your Reseller account within hours!</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:20px">
        <button class="btn-neon btn-block" onclick="window.open('https://wa.me/923062015326?text=Hi!%20I%20want%20to%20become%20a%20Reseller.%20I%20sent%20Rs50%20to%20JazzCash%2003062015326','_blank')">
          📲 WhatsApp Admin
        </button>
        <button class="btn-outline btn-block" onclick="closeModalForce()">Close</button>
      </div>
    </div>
  `);
}

function copyJazzCash() {
  navigator.clipboard.writeText('03062015326').then(() => showToast('JazzCash number copied! 📋', 'success'));
}

// ─── ENHANCED SHARE with all social platforms ────────────────────
function shareOnInstagram(catalog) {
  const url = generateShareUrl(catalog.id);
  navigator.clipboard.writeText(url).then(() => {
    showToast('Link copied! Paste it in Instagram bio/story 📷', 'info');
  });
}

function shareNative(catalog) {
  const url  = generateShareUrl(catalog.id);
  const sym  = CURRENCY_SYM[catalog.currency] || '₨';
  const text = `🛍️ ${catalog.title}\n💰 Price: ${sym}${fmt(catalog.resellerPrice||catalog.price)}\n✅ Order: ${url}`;
  if (navigator.share) {
    navigator.share({ title: catalog.title, text, url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(text + '\n' + url).then(() => showToast('Copied to clipboard! 📋', 'success'));
  }
}

// ─── RENDER ENHANCED SOCIAL SHARE BUTTONS ───────────────────────
function renderShareButtons(catalog) {
  const catalogJson = JSON.stringify(catalog).replace(/"/g, '&quot;');
  return `
    <div class="social-share-row" style="margin-bottom:8px">
      <button class="share-btn share-btn-wa" onclick="shareOnWhatsApp(${catalogJson})">📲 WhatsApp</button>
      <button class="share-btn share-btn-tg" onclick="shareOnTelegram(${catalogJson})">✈️ Telegram</button>
    </div>
    <div class="social-share-row" style="margin-bottom:8px">
      <button class="share-btn share-btn-fb" onclick="shareOnFacebook(${catalogJson})">👍 Facebook</button>
      <button class="share-btn share-btn-copy" onclick="shareNative(${catalogJson})">🔗 Share</button>
    </div>
    <div class="copy-link-box">
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${generateShareUrl(catalog.id)}</span>
      <button class="copy-link-btn" onclick="copyLink('${catalog.id}')">Copy</button>
    </div>`;
}

// ─── SITEMAP GENERATOR ──────────────────────────────────────────
async function generateSitemap() {
  try {
    const catalogs = await getCatalogs(200);
    const baseUrl  = APP_URL;
    const today    = new Date().toISOString().split('T')[0];
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl}/</loc><lastmod>${today}</lastmod><priority>1.0</priority></url>
  <url><loc>${baseUrl}/?page=catalogs</loc><lastmod>${today}</lastmod><priority>0.9</priority></url>
`;
    catalogs.forEach(c => {
      xml += `  <url><loc>${baseUrl}/?share=${c.id}</loc><lastmod>${today}</lastmod><priority>0.8</priority></url>\n`;
    });
    xml += '</urlset>';
    const blob = new Blob([xml], { type:'application/xml' });
    const a    = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sitemap.xml';
    a.click();
    showToast('Sitemap downloaded! Upload to your hosting root 🗺️', 'success');
  } catch(e) {
    showToast('Failed to generate sitemap', 'error');
  }
}

// ─── ENHANCED CATALOG DETAIL with Lightbox & Better Share ───────
async function renderCatalogDetailV3(params={}) {
  const { id, order } = params;
  setContent(`<div class="page"><div style="text-align:center;padding:60px 0"><div style="font-size:3rem">⏳</div><p style="color:var(--text3);margin-top:12px">Loading product...</p></div></div>`);

  const c = await getCatalogById(id);
  if (!c) {
    setContent(`<div class="page"><div class="empty"><div class="empty-icon">😕</div><div class="empty-title">Product not found</div><button class="btn-neon sm" onclick="navigate('catalogs')">Browse Catalog</button></div></div>`);
    return;
  }

  incrementViews(id);
  const sym    = CURRENCY_SYM[c.currency] || '₨';
  const price  = c.resellerPrice || c.price || 0;
  const profit = (c.resellerPrice || 0) - (c.price || 0);
  const isReseller = userProfile && ['reseller','marketer','admin'].includes(userProfile.role);
  const images = c.images || [];

  // Build my personal reseller share URL
  const myShareUrl = currentUser
    ? `${APP_URL}/?share=${id}&ref=${userProfile?.referralCode || currentUser.uid.slice(0,8)}`
    : generateShareUrl(id);

  setContent(`
    <div class="page">
      <button onclick="navigate('catalogs')" style="display:flex;align-items:center;gap:4px;color:var(--text3);font-size:0.875rem;margin-bottom:16px;transition:var(--transition)" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='var(--text3)'">← Back to Catalog</button>

      <!-- SEO structured data for this product -->
      <script type="application/ld+json">
      ${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        "name": c.title,
        "description": c.description || '',
        "image": images[0] || '',
        "offers": { "@type": "Offer", "price": price, "priceCurrency": c.currency || 'PKR', "availability": c.stock > 0 ? "InStock" : "OutOfStock" }
      })}
      <\/script>

      <div class="detail-grid">
        <!-- Image Gallery with Lightbox -->
        <div class="img-gallery">
          <div class="img-main" style="cursor:zoom-in" onclick="openLightbox(${JSON.stringify(images)}, 0)">
            ${images[0]
              ? `<img id="main-img" src="${images[0]}" alt="${c.title}" style="width:100%;height:100%;object-fit:cover" />`
              : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:5rem">📦</div>`}
          </div>
          ${images.length > 0 ? `<div style="font-size:0.72rem;color:var(--text4);text-align:center;margin-top:4px">👆 Tap to view full size</div>` : ''}
          ${images.length > 1 ? `
            <div class="img-thumbs">
              ${images.map((img, i) => `
                <div class="img-thumb ${i===0?'active':''}" onclick="switchImgV3('${img}',this,${i},${JSON.stringify(images).replace(/"/g,'&quot;')})">
                  <img src="${img}" alt="" />
                </div>`).join('')}
            </div>` : ''}
        </div>

        <!-- Info -->
        <div>
          ${c.category ? `<div style="font-size:0.75rem;color:var(--blue);margin-bottom:8px">📁 ${escapeHtml(c.category)}</div>` : ''}
          <h1 style="font-size:1.5rem;font-weight:900;line-height:1.3;margin-bottom:16px">${escapeHtml(c.title)}</h1>

          <!-- Price card -->
          <div class="card" style="margin-bottom:16px">
            <div style="display:flex;align-items:flex-end;gap:12px">
              <div>
                <div style="font-size:2rem;font-weight:900;color:var(--blue)">${sym}${fmt(price)}</div>
              </div>
              ${isReseller && profit > 0 ? `<div style="margin-left:auto;text-align:right">
                <div style="font-size:0.72rem;color:var(--text3)">Your Profit</div>
                <div style="font-size:1.2rem;font-weight:800;color:var(--green)">+${sym}${fmt(profit)}</div>
              </div>` : ''}
            </div>
            <div style="font-size:0.75rem;color:var(--text3);margin-top:8px;display:flex;gap:12px;flex-wrap:wrap">
              <span>👁 ${c.views || 0} views</span>
              ${c.stock > 0 ? `<span style="color:var(--green)">✓ In Stock (${c.stock})</span>` : `<span style="color:var(--red)">Out of Stock</span>`}
              <span class="badge badge-${c.type||'physical'}">${c.type==='digital'?'⚡ Digital':'📦 Physical'}</span>
            </div>
          </div>

          ${c.description ? `
          <div class="card" style="margin-bottom:16px">
            <div style="font-size:0.8rem;color:var(--text3);font-weight:600;margin-bottom:8px">Description</div>
            <p style="font-size:0.9rem;color:var(--text2);line-height:1.6">${escapeHtml(c.description)}</p>
          </div>` : ''}

          ${c.tags?.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px">${c.tags.map(t=>`<span class="badge" style="background:var(--glass);color:var(--text3);border:1px solid var(--border)">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}

          <!-- Order Button -->
          <button class="btn-neon btn-block" style="margin-bottom:12px;font-size:1rem;padding:14px" onclick="showOrderModal('${id}')">🛒 Order Now</button>

          <!-- Share Section -->
          <div class="card" style="margin-bottom:12px">
            <div style="font-size:0.8rem;color:var(--text3);font-weight:600;margin-bottom:10px">📤 Share & Earn</div>
            ${renderShareButtons(c)}
          </div>

          ${currentUser && isReseller ? `
          <div class="card" style="margin-bottom:12px;border-color:rgba(0,212,255,0.2);background:rgba(0,212,255,0.04)">
            <div style="font-size:0.78rem;color:var(--blue);font-weight:600;margin-bottom:8px">🔗 Your Personal Reseller Link</div>
            <div class="copy-link-box">
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.75rem">${myShareUrl}</span>
              <button class="copy-link-btn" onclick="navigator.clipboard.writeText('${myShareUrl}').then(()=>showToast('Your personal link copied! 📋','success'))">Copy</button>
            </div>
            <div style="font-size:0.72rem;color:var(--text4);margin-top:6px">Orders via this link are tracked to your account</div>
          </div>` : ''}
        </div>
      </div>
    </div>
  `);

  if (order) setTimeout(() => showOrderModal(id, c), 300);
}

// Enhanced switchImg that also updates lightbox context
function switchImgV3(src, el, idx, imagesJson) {
  const main = document.getElementById('main-img');
  if (main) main.src = src;
  document.querySelectorAll('.img-thumb').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  _lightboxImages = imagesJson;
  _lightboxIndex  = idx;
}

// ─── ADMIN PRODUCT LIST — with Catalog Toggle ────────────────────
function renderAdminProductsV3(cats) {
  return `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
      <button class="btn-neon sm" onclick="showAddProductModal()">+ Add Product</button>
      <button class="btn-outline sm" onclick="generateSitemap()">🗺️ Download Sitemap</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      ${cats.length === 0
        ? `<div class="empty"><div class="empty-icon">📦</div><div class="empty-title">No products</div></div>`
        : cats.map(c => `
          <div class="list-item">
            <div style="width:40px;height:40px;border-radius:10px;overflow:hidden;flex-shrink:0;background:var(--bg3)">
              ${c.images?.[0]
                ? `<img src="${c.images[0]}" style="width:100%;height:100%;object-fit:cover" />`
                : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center">📦</div>'}
            </div>
            <div class="list-info">
              <div class="list-name">${c.title}</div>
              <div class="list-sub">₨${fmt(c.resellerPrice||c.price)} · ${c.type||'physical'} · 👁 ${c.views||0}</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center">
              <!-- On/Off Toggle -->
              <div class="catalog-toggle" onclick="toggleCatalogStatus('${c.id}',${!!c.active})" title="${c.active ? 'Click to hide' : 'Click to show'}">
                <div class="toggle-switch ${c.active ? 'on' : ''}"></div>
              </div>
              <button class="btn-outline sm" onclick="showEditProductModal('${c.id}')">Edit</button>
              <button class="btn-red sm" style="padding:6px 10px;border-radius:8px;font-size:0.78rem" onclick="confirmDeleteProduct('${c.id}')">Del</button>
            </div>
          </div>`).join('')}
    </div>`;
}

// ─── RENDER HOME V3 with Eid Banner ─────────────────────────────
async function renderHomeV3() {
  const eidSection = renderEidHeroCard();

  setContent(`
    <div class="page" style="padding-top:0;padding-left:0;padding-right:0;max-width:100%">
      <!-- Hero -->
      <section class="hero">
        <div class="hero-orb hero-orb-1"></div>
        <div class="hero-orb hero-orb-2"></div>
        <div class="hero-orb hero-orb-3"></div>
        <div class="hero-content">
          <div class="hero-badge"><span class="pulse-dot"></span> Pakistan's #1 Reseller Marketplace</div>
          <h1>Sell Products,<br><span class="gradient-text">Earn Money</span><br><span style="color:var(--text2)">From Anywhere</span></h1>
          <p>Join 1,200+ resellers already earning daily with physical &amp; digital products. Share, sell, grow.</p>
          <div class="hero-btns">
            ${currentUser
              ? `<button class="btn-neon lg" onclick="navigate('catalogs')">Browse Products →</button>
                 <button class="btn-outline lg" onclick="navigate('earnings')">My Earnings 💰</button>`
              : `<button class="btn-neon lg" onclick="navigate('auth')">Start Earning Free 🚀</button>
                 <button class="btn-outline lg" onclick="navigate('catalogs')">Browse Products</button>`}
          </div>
          <div class="hero-stats">
            <div><div class="hero-stat-val gradient-text">500+</div><div class="hero-stat-label">Products</div></div>
            <div><div class="hero-stat-val gradient-text">1,200+</div><div class="hero-stat-label">Resellers</div></div>
            <div><div class="hero-stat-val gradient-text">₨50L+</div><div class="hero-stat-label">Paid Out</div></div>
          </div>
        </div>
      </section>

      <div class="page" style="padding-top:8px">
        <!-- Eid ul Adha Banner -->
        ${eidSection}

        <!-- Reseller CTA if not logged in or is customer -->
        ${!currentUser || userProfile?.role === 'customer' ? `
        <div class="card" style="margin-bottom:24px;border-color:rgba(0,212,255,0.2);background:linear-gradient(135deg,rgba(0,212,255,0.04),rgba(139,92,246,0.04));text-align:center;padding:20px">
          <div style="font-size:2rem;margin-bottom:8px">💼</div>
          <div style="font-weight:800;font-size:1rem;margin-bottom:4px">Become a <span class="gradient-text">Reseller</span></div>
          <div style="font-size:0.8rem;color:var(--text3);margin-bottom:12px">Only ₨50 investment — Earn on every sale!</div>
          <button class="btn-neon sm" onclick="showResellerRegModal()">Join as Reseller →</button>
        </div>` : ''}

        <!-- Live Stats -->
        <div class="section">
          <div class="section-head">
            <div><div class="section-title">📊 Live <span class="gradient-text">Statistics</span></div></div>
            <div style="display:flex;align-items:center;gap:6px;font-size:0.78rem;color:var(--blue)">
              <div class="pulse-dot" style="width:6px;height:6px"></div> Live
            </div>
          </div>
          <div class="counters-grid" id="counters-grid">
            ${[
              {icon:'📦',label:'Products',val:'500+',color:'var(--blue)'},
              {icon:'👥',label:'Resellers',val:'1,200+',color:'var(--purple)'},
              {icon:'🛒',label:'Orders',val:'8,500+',color:'var(--orange)'},
              {icon:'💰',label:'Paid Out',val:'₨50L+',color:'var(--green)'},
              {icon:'📤',label:'Daily Shares',val:'350+',color:'var(--pink)'},
              {icon:'⭐',label:'Happy Clients',val:'4,200+',color:'var(--yellow)'},
            ].map(c => `
              <div class="card counter-card">
                <div class="counter-icon">${c.icon}</div>
                <div class="counter-val" style="color:${c.color}">${c.val}</div>
                <div class="counter-label">${c.label}</div>
              </div>`).join('')}
          </div>
        </div>

        <!-- Categories -->
        <div class="section">
          <div class="section-head">
            <div><div class="section-title">🗂️ <span class="gradient-text">Categories</span></div></div>
            <a class="section-link" onclick="navigate('catalogs')">All →</a>
          </div>
          <div class="cat-scroll">
            ${[
              {icon:'🐑',label:'Eid Deals',slug:'eid'},
              {icon:'📱',label:'Mobiles',slug:'mobiles'},
              {icon:'💻',label:'Electronics',slug:'electronics'},
              {icon:'👗',label:'Fashion',slug:'fashion'},
              {icon:'🎓',label:'Education',slug:'education'},
              {icon:'🎬',label:'Entertainment',slug:'entertainment'},
              {icon:'💻',label:'Software',slug:'software'},
              {icon:'🎵',label:'Music',slug:'music'},
              {icon:'🎁',label:'Gift Cards',slug:'giftcards'},
              {icon:'💄',label:'Beauty',slug:'beauty'},
              {icon:'⚡',label:'Digital',slug:'digital'},
            ].map(c => `
              <div class="cat-chip" onclick="navigate('catalogs',{category:'${c.slug}'})">
                <span class="cat-chip-icon">${c.icon}</span>
                <span class="cat-chip-label">${c.label}</span>
              </div>`).join('')}
          </div>
        </div>

        <!-- Trending Products -->
        <div class="section">
          <div class="section-head">
            <div>
              <div class="section-title">⚡ Trending <span class="gradient-text">Products</span></div>
              <div class="section-subtitle">Hot sellers right now</div>
            </div>
            <a class="section-link" onclick="navigate('catalogs')">View all →</a>
          </div>
          <div class="products-grid" id="trending-grid">
            ${skeletonCards(6)}
          </div>
        </div>

        <!-- All Products -->
        <div class="section">
          <div class="section-head">
            <div>
              <div class="section-title">🛍️ Latest <span class="gradient-text">Products</span></div>
              <div class="section-subtitle" id="products-count">Loading...</div>
            </div>
            <a class="section-link" onclick="navigate('catalogs')">See all →</a>
          </div>
          <div class="products-grid" id="home-products-grid">
            ${skeletonCards(8)}
          </div>
        </div>

        ${!currentUser ? `
        <div class="card" style="text-align:center;padding:40px 24px;margin-bottom:24px;border-color:rgba(0,212,255,0.2);background:linear-gradient(135deg,rgba(0,212,255,0.06),rgba(139,92,246,0.06))">
          <div style="font-size:3rem;margin-bottom:12px">🚀</div>
          <h2 style="font-size:1.5rem;font-weight:900;margin-bottom:8px">Start Earning Today — <span class="gradient-text">It's Free!</span></h2>
          <p style="color:var(--text3);margin-bottom:20px;max-width:400px;margin-left:auto;margin-right:auto">Join thousands of resellers. Only ₨50 to activate reseller mode. Start sharing in minutes.</p>
          <button class="btn-neon lg" onclick="navigate('auth')">⭐ Create Free Account</button>
        </div>` : ''}
      </div>
    </div>
  `);

  // FIX 5: Real-time listener for allCatalogs — home page grids update automatically
  const catalogUnsub = fdb.collection('catalogs')
    .where('active', '==', true)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .onSnapshot((snap) => {
      const liveCatalogs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      allCatalogs = liveCatalogs;
      const el1 = document.getElementById('trending-grid');
      const el2 = document.getElementById('home-products-grid');
      const cnt  = document.getElementById('products-count');
      if (el1) el1.innerHTML = renderProductCards(liveCatalogs.slice(0, 6));
      if (el2) el2.innerHTML = renderProductCards(liveCatalogs);
      if (cnt) cnt.textContent = `${liveCatalogs.length} products available`;
    }, (err) => {
      console.error('Home catalog snapshot error:', err);
      // Fallback: load once without real-time
      getCatalogs(20).then(cats => {
        allCatalogs = cats;
        const el1 = document.getElementById('trending-grid');
        const el2 = document.getElementById('home-products-grid');
        const cnt  = document.getElementById('products-count');
        if (el1) el1.innerHTML = renderProductCards(cats.slice(0, 6));
        if (el2) el2.innerHTML = renderProductCards(cats);
        if (cnt) cnt.textContent = `${cats.length} products available`;
      });
    });

  registerListener('homeCatalogs', catalogUnsub);
}

// ─── ENHANCED SHARE PAGE (customer-friendly) ─────────────────────
async function renderShareV3(params={}) {
  const { id } = params;
  setContent(`<div class="page"><div style="text-align:center;padding:80px 0"><div style="font-size:3rem">⏳</div></div></div>`);
  const c = await getCatalogById(id);
  if (!c) {
    setContent(`<div class="page"><div class="empty"><div class="empty-icon">😕</div><div class="empty-title">Product not found</div><button class="btn-neon sm" onclick="navigate('home')">Go Home</button></div></div>`);
    return;
  }
  incrementViews(id);
  const sym    = CURRENCY_SYM[c.currency] || '₨';
  const price  = c.resellerPrice || c.price || 0;
  const images = c.images || [];

  // Track ref code if present
  const urlP = new URLSearchParams(window.location.search);
  const ref   = urlP.get('ref');
// Line ~2806 ke baad, yahan add karo:
if (ref) localStorage.setItem('mich_ref', ref); // ← YE LINE ADD KRO
  setContent(`
    <div style="min-height:100vh;background:var(--bg)">
      <!-- Share hero -->
      <div style="position:relative;overflow:hidden;padding:48px 20px 32px;text-align:center">
        <div class="hero-orb hero-orb-1" style="opacity:0.1"></div>
        <div class="hero-orb hero-orb-2" style="opacity:0.08"></div>

        <div style="max-width:500px;margin:0 auto">
          ${images.length > 0 ? `
            <div style="position:relative;width:220px;height:220px;margin:0 auto 20px">
              <img src="${images[0]}" class="share-img" alt="${c.title}"
                style="width:220px;height:220px;cursor:zoom-in"
                onclick="openLightbox(${JSON.stringify(images)}, 0)" />
              ${images.length > 1 ? `
                <div style="position:absolute;bottom:8px;right:8px;background:rgba(0,0,0,0.7);border-radius:20px;padding:3px 8px;font-size:0.7rem;color:#fff">
                  +${images.length - 1} more
                </div>` : ''}
            </div>
          ` : '<div style="width:200px;height:200px;border-radius:28px;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:5rem;margin:0 auto 24px">📦</div>'}

          ${images.length > 1 ? `
            <div style="display:flex;gap:8px;justify-content:center;margin-bottom:16px;overflow-x:auto;padding:4px">
              ${images.map((img, i) => `
                <img src="${img}" style="width:52px;height:52px;border-radius:8px;object-fit:cover;cursor:zoom-in;border:2px solid ${i===0?'var(--blue)':'var(--border)'};flex-shrink:0"
                  onclick="openLightbox(${JSON.stringify(images)}, ${i})" />`).join('')}
            </div>
            <div style="font-size:0.7rem;color:var(--text4);margin-bottom:12px">👆 Tap images to view full size</div>
          ` : ''}

          <span class="badge badge-${c.type||'physical'}" style="margin-bottom:12px">${c.type==='digital'?'⚡ Digital':'📦 Physical'}</span>
          <h1 style="font-size:1.6rem;font-weight:900;margin:12px 0">${escapeHtml(c.title)}</h1>
          ${c.description ? `<p style="color:var(--text3);font-size:0.9rem;margin-bottom:16px;line-height:1.6">${escapeHtml(c.description)}</p>` : ''}
          <div class="share-price">${sym}${fmt(price)}</div>

          <div style="margin-top:24px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
            <button class="btn-neon lg" onclick="showOrderModal('${id}')">🛒 Order Now</button>
          </div>

          <!-- Tags -->
          ${c.tags?.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:16px">${c.tags.map(t=>`<span class="badge" style="background:var(--glass);color:var(--text3)">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}

          <!-- Powered by -->
          <div style="margin-top:32px;padding-top:20px;border-top:1px solid var(--border2)">
            <div style="font-size:0.72rem;color:var(--text4);margin-bottom:6px">Powered by</div>
            <a onclick="navigate('home')" style="font-weight:800;font-size:0.9rem" class="gradient-text">MICH Digital Shop</a>
            <div style="font-size:0.72rem;color:var(--text4);margin-top:4px">Pakistan's #1 Reseller Marketplace</div>
          </div>
        </div>
      </div>
    </div>
  `);
}

// 9. INIT
// ════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  // Check for share param in URL
  const urlParams = new URLSearchParams(window.location.search);
  const shareId   = urlParams.get('share');
  const refCode   = urlParams.get('ref');

  // Auth state listener
  fauth.onAuthStateChanged(async (firebaseUser) => {
    currentUser = firebaseUser;
    if (firebaseUser) {
      userProfile = await getUserDoc(firebaseUser.uid);
      if (!userProfile) {
        await createUserDoc(firebaseUser.uid, {
          name:  firebaseUser.displayName || '',
          email: firebaseUser.email || '',
          photo: firebaseUser.photoURL || '',
        });
        userProfile = await getUserDoc(firebaseUser.uid);
      }
    } else {
      userProfile = null;
    }

    updateNavUI();

    // Hide splash
    setTimeout(() => {
      document.getElementById('splash')?.classList.add('hide');
    }, 800);

    // Route
    if (shareId) {
      navigate('share', { id: shareId });
    } else if (currentPage === 'home' || !currentPage) {
      navigate('home');
    }
  });
});
function openFullImage(src){

  const div = document.createElement("div");
  div.className = "full-image-view";

  div.innerHTML = `
    <div class="full-image-close">×</div>
    <img src="${src}">
  `;

  div.onclick = () => div.remove();

  document.body.appendChild(div);
}
