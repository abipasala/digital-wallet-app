/* app.js — shared app logic for Paytm-lite demo (frontend-only) */
/* Storage:
   - users stored in localStorage 'pl_users' as array { phone, isVerified, balance, createdAt, kycStatus }
   - current user stored in 'pl_current' (phone)
   - txns stored in 'pl_txns' as array { id, type, from, to, amount, ts }
   - KYC images stored in IndexedDB under 'pl_db' objectStore 'kyc'
*/
(function(){
  const LS_USERS = 'pl_users';
  const LS_CUR = 'pl_current';
  const LS_TX = 'pl_txns';

  // simple IndexedDB for KYC images
  function openDB(){
    return new Promise((res, rej) => {
      const req = indexedDB.open('pl_db', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('kyc')) db.createObjectStore('kyc', { keyPath: 'phone' });
      };
      req.onsuccess = e => res(e.target.result);
      req.onerror = e => rej(e);
    });
  }
  async function saveKyc(phone, dataUrl){
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('kyc', 'readwrite');
      const store = tx.objectStore('kyc');
      store.put({ phone, dataUrl, status: 'submitted', updatedAt: new Date().toISOString() });
      tx.oncomplete = () => res(true);
      tx.onerror = e => rej(e);
    });
  }
  async function loadKyc(phone){
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('kyc', 'readonly');
      const store = tx.objectStore('kyc');
      const r = store.get(phone);
      r.onsuccess = e => res(e.target.result);
      r.onerror = e => rej(e);
    });
  }

  // localStorage helpers
  function readUsers(){ return JSON.parse(localStorage.getItem(LS_USERS) || '[]'); }
  function writeUsers(u){ localStorage.setItem(LS_USERS, JSON.stringify(u)); }
  function readTxns(){ return JSON.parse(localStorage.getItem(LS_TX) || '[]'); }
  function writeTxns(t){ localStorage.setItem(LS_TX, JSON.stringify(t)); }
  function setCurrent(phone){ if (phone) localStorage.setItem(LS_CUR, phone); else localStorage.removeItem(LS_CUR); }
  function getCurrent(){ return localStorage.getItem(LS_CUR); }

  // user helpers
  function findUser(phone){ return readUsers().find(u => u.phone === phone); }
  function upsertUser(obj){
    const users = readUsers();
    const idx = users.findIndex(u => u.phone === obj.phone);
    if (idx >= 0) users[idx] = obj; else users.push(obj);
    writeUsers(users);
  }

  function createTxn(t){
    const txns = readTxns();
    txns.unshift(Object.assign({ id: Math.random().toString(36).slice(2,9), ts: new Date().toISOString() }, t));
    writeTxns(txns);
  }

  // public API exported to window.App
  window.App = {
    // create user and set OTP
    createUserWithOtp(phone){
      if (!/^\d{10}$/.test(phone)) return false;
      let u = findUser(phone);
      if (!u) {
        u = { phone, isVerified: false, balance: 0, createdAt: new Date().toISOString(), kycStatus: 'not_submitted' };
      }
      // simulated OTP
      u.otp = '1234';
      upsertUser(u);
      return true;
    },

    getOtpForPhone(phone){
      const u = findUser(phone);
      return (u && u.otp) ? u.otp : '1234';
    },

    verifyOtpAndLogin(phone, otp){
      const u = findUser(phone);
      if (!u) return false;
      if (otp !== u.otp) return false;
      u.isVerified = true;
      delete u.otp;
      upsertUser(u);
      setCurrent(phone);
      return true;
    },

    getCurrentUser(){ return getCurrent(); },

    logout(){ setCurrent(null); },

    // Dashboard rendering helper
    renderDashboardPage(){
      const phone = getCurrent();
      if (!phone) return;
      const u = findUser(phone);
      document.getElementById('hdr-phone') && (document.getElementById('hdr-phone').innerText = phone);
      document.getElementById('acc-phone') && (document.getElementById('acc-phone').innerText = phone);
      document.getElementById('acc-kyc') && (document.getElementById('acc-kyc').innerText = (u.kycStatus || 'not_submitted'));
      document.getElementById('balance') && (document.getElementById('balance').innerText = `₹${(u.balance||0).toFixed(2)}`);
      // tx list
      if (document.getElementById('tx-list')){
        const tx = readTxns().filter(t => t.from === phone || t.to === phone);
        const el = document.getElementById('tx-list');
        el.innerHTML = '';
        if (!tx.length) el.innerHTML = '<div class="kv">No transactions yet.</div>';
        else tx.forEach(t => {
          const div = document.createElement('div');
          div.className = 'tx-item';
          div.innerHTML = `<div><strong>${t.type}</strong><div class="kv">${new Date(t.ts).toLocaleString()}</div></div><div class="kv">₹${t.amount}</div>`;
          el.appendChild(div);
        });
      }
    },

    addMoney(amount){
      const phone = getCurrent();
      if (!phone) return false;
      const u = findUser(phone);
      u.balance = Number(u.balance || 0) + Number(amount);
      upsertUser(u);
      createTxn({ type: 'TopUp', from: phone, to: phone, amount: Number(amount) });
      return true;
    },

    sendMoney(toPhone, amount){
      const from = getCurrent();
      if (!from) return { success: false, message: 'Not logged in' };
      if (!/^\d{10}$/.test(toPhone)) return { success: false, message: 'Invalid receiver phone' };
      const sender = findUser(from);
      let receiver = findUser(toPhone);
      const amt = Number(amount);
      if (!receiver){
        // create guest
        receiver = { phone: toPhone, isVerified: false, balance: 0, createdAt: new Date().toISOString(), kycStatus: 'not_submitted' };
        upsertUser(receiver);
      }
      if ((sender.balance || 0) < amt) {
        createTxn({ type: 'TransactionIssue:InsufficientFunds', from, to: toPhone, amount: amt });
        return { success: false, message: 'Insufficient balance', createdGuest: !findUser(toPhone) };
      }
      sender.balance = Number(sender.balance || 0) - amt;
      receiver.balance = Number(receiver.balance || 0) + amt;
      upsertUser(sender); upsertUser(receiver);
      createTxn({ type: 'Transfer', from, to: toPhone, amount: amt });
      return { success: true };
    },

    // KYC store using IndexedDB
    storeKyc(phone, dataUrl){
      return saveKyc(phone, dataUrl).then(() => {
        const u = findUser(phone); u.kycStatus = 'submitted'; upsertUser(u);
        return true;
      });
    },

    getKyc(phone){ return loadKyc(phone); },

    // small export / debug
    exportAllData(){
      return { users: readUsers(), txns: readTxns() };
    },
    debugDump(){ return { users: readUsers(), txns: readTxns() }; }
  };

  // initialize some UI elements for index / dashboard if present
  document.addEventListener('DOMContentLoaded', () => {
    // auto-fill phone if current exists
    const cur = getCurrent();
    if (cur && document.querySelector('.page-login')) {
      // prefer redirect to dashboard if already logged in
      location.href = 'dashboard.html';
    }
  });
})();
