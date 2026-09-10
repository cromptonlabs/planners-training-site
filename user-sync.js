/**
 * PT User Sync Module — user-sync.js
 *
 * Wraps Firebase Realtime Database to provide cross-device user account sync
 * for Crompton Academy (Planners Training portal).
 *
 * Falls back silently to localStorage-only mode if Firebase is not configured
 * or is unreachable.
 *
 * Exposed as window.PTSync = { pullAll, saveUser, deleteUser,
 *                               restoreUser, purgeUser, isEnabled }
 *
 * Storage layout:
 *   Firebase RTDB path : users / deleted_users
 *   localStorage key   : cromton.users.v1  (shared with portal Auth module)
 */
(function () {
  'use strict';

  const USERS_PATH        = 'users';
  const DELETED_PATH      = 'deleted_users';
  const USERS_STORE_KEY   = 'cromton.users.v1';
  const DELETED_STORE_KEY = 'cromton.deleted_users.v1';
  const PULL_TIMEOUT_MS   = 10000; // max wait for Firebase pull

  let _db          = null;
  let _syncEnabled = false;
  let _lastPullMeta = {
    ok: false,
    timedOut: false,
    remoteCount: 0,
    error: null
  };

  // ── Email key sanitisation ────────────────────────────────────────────────
  // Firebase RTDB keys cannot contain . / [ ] # $
  // We encode email dots as commas (reversible, unambiguous for email keys).
  function _encodeKey(key) {
    return String(key || '').replace(/\./g, ',');
  }
  function _decodeKey(key) {
    return String(key || '').replace(/,/g, '.');
  }

  // ── Initialise ────────────────────────────────────────────────────────────
  function _init() {
    if (
      typeof FIREBASE_CONFIG === 'undefined' ||
      !FIREBASE_CONFIG.apiKey ||
      FIREBASE_CONFIG.apiKey === 'YOUR_API_KEY' ||
      !FIREBASE_CONFIG.databaseURL ||
      FIREBASE_CONFIG.databaseURL.includes('YOUR_PROJECT_ID')
    ) {
      console.warn('[PTSync] firebase-config.js not filled in — running in local-only mode.');
      return;
    }

    try {
      // Avoid re-initialising if TIA or another script already called initializeApp
      if (!firebase.apps.length) {
        firebase.initializeApp(FIREBASE_CONFIG);
      }
      _db = firebase.database();
      _syncEnabled = true;
      console.info('[PTSync] Connected to Firebase Realtime Database ✓');
        _testConnection();
    } catch (err) {
      console.warn('[PTSync] Firebase init failed — local-only mode:', err.message);
    }
  }

    // ── Connection test ───────────────────────────────────────────────────────
    function _testConnection() {
      if (!_db) return;
      _db.ref('.info/connected').on('value', snap => {
        if (snap.val() === true) {
          console.info('[PTSync] Realtime connection confirmed ✓');
        } else {
          console.warn('[PTSync] Realtime connection lost — operating offline');
        }
      });
    }

  // ── Local helpers ─────────────────────────────────────────────────────────
  function _getLocal(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
  }
  function _setLocal(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
  }

  function _getAdminOnly(localUsers) {
    const src = localUsers && typeof localUsers === 'object' ? localUsers : {};
    const allow = Array.isArray(window.PORTAL_ADMIN_EMAILS)
      ? window.PORTAL_ADMIN_EMAILS.map(e => String(e).toLowerCase().trim())
      : [];
    const out = {};
    for (const k of Object.keys(src)) {
      const rec = src[k] || {};
      const email = String(rec.email || k || '').toLowerCase().trim();
      const username = String(rec.username || '').toLowerCase().trim();
      const isAdmin = rec.isAdmin === true
        || String(rec.role || '').toLowerCase() === 'admin'
        || username === 'admin'
        || email === 'admin'
        || allow.includes(email);
      if (isAdmin) out[k] = rec;
    }
    return out;
  }

  // ── Timeout race ──────────────────────────────────────────────────────────
  function _withTimeout(promise, ms) {
    const timer = new Promise(resolve => setTimeout(resolve, ms, null));
    return Promise.race([promise, timer]);
  }

  // ── Key helpers: Firebase keys use encoded email; localStorage uses raw email
  function _fbToLocal(fbObj) {
    if (!fbObj) return {};
    const out = {};
    for (const k of Object.keys(fbObj)) {
      out[_decodeKey(k)] = fbObj[k];
    }
    return out;
  }
  function _localToFb(localObj) {
    if (!localObj) return {};
    const out = {};
    for (const k of Object.keys(localObj)) {
      out[_encodeKey(k)] = localObj[k];
    }
    return out;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Pull all users from Firebase and merge into localStorage.
   * Remote record always wins for same-key conflicts.
   * Returns true on success, false on failure/timeout.
   */
  async function pullAll() {
    if (!_syncEnabled || !_db) return false;
    try {
      _lastPullMeta = { ok: false, timedOut: false, remoteCount: 0, error: null };
      const result = await _withTimeout(_db.ref(USERS_PATH).get(), PULL_TIMEOUT_MS);
        if (!result) {
          console.warn('[PTSync] pullAll timed out after', PULL_TIMEOUT_MS, 'ms');
          _lastPullMeta = { ok: false, timedOut: true, remoteCount: 0, error: 'timeout' };
          return false;
        }

      if (result.exists()) {
        const remote = _fbToLocal(result.val() || {});
          _lastPullMeta.remoteCount = Object.keys(remote).length;
          console.info('[PTSync] pullAll — fetched', Object.keys(remote).length, 'users from Firebase');
        const local = _getLocal(USERS_STORE_KEY);
        // Cloud is source of truth. Keep only seeded admin fallback from local.
        const next = Object.assign({}, _getAdminOnly(local), remote);
        _setLocal(USERS_STORE_KEY, next);
        } else {
          _lastPullMeta.remoteCount = 0;
          console.info('[PTSync] pullAll — users node is empty in Firebase');
          // If cloud is empty, drop local non-admin users to avoid ghost accounts.
          const local = _getLocal(USERS_STORE_KEY);
          _setLocal(USERS_STORE_KEY, _getAdminOnly(local));
      }

      // Also sync deleted users table
      const delResult = await _withTimeout(_db.ref(DELETED_PATH).get(), PULL_TIMEOUT_MS);
      if (delResult && delResult.exists()) {
        _setLocal(DELETED_STORE_KEY, _fbToLocal(delResult.val() || {}));
      }

      _lastPullMeta.ok = true;
      return true;
    } catch (err) {
      console.warn('[PTSync] pullAll failed:', err.message);
      _lastPullMeta = { ok: false, timedOut: false, remoteCount: 0, error: err.message || 'pull failed' };
      return false;
    }
  }

  /**
   * Publish a full local users object to Firebase users node.
   * Used to bootstrap cloud from an existing local admin dataset.
   */
  async function pushAll(localUsers) {
    const source = localUsers && typeof localUsers === 'object' ? localUsers : _getLocal(USERS_STORE_KEY);
    if (!_syncEnabled || !_db) return false;
    try {
      await _db.ref(USERS_PATH).set(_localToFb(source));
      console.info('[PTSync] pushAll ✓', Object.keys(source).length, 'users published');
      return true;
    } catch (err) {
      console.warn('[PTSync] pushAll failed:', err.message);
      return false;
    }
  }

  function getLastPullMeta() {
    return { ..._lastPullMeta };
  }

  /**
   * Save (create or update) a single user record to Firebase.
   * emailKey is the raw email used as localStorage key.
   * Also mirrors to localStorage immediately.
   */
  async function saveUser(emailKey, record) {
    if (!emailKey || !record) return false;

    // Always update localStorage first (instant)
    const local = _getLocal(USERS_STORE_KEY);
    local[emailKey] = record;
    _setLocal(USERS_STORE_KEY, local);

    if (!_syncEnabled || !_db) return false;
    try {
      await _db.ref(`${USERS_PATH}/${_encodeKey(emailKey)}`).set(record);
        console.info('[PTSync] saveUser ✓', emailKey);
      return true;
    } catch (err) {
      console.warn('[PTSync] saveUser failed:', err.message);
      return false;
    }
  }

  /**
   * Soft-delete a user: updates the main users path (marks deleted=true)
   * and writes to the deleted archive path.
   */
  async function deleteUser(emailKey, mainRecord, archivedRecord) {
    if (!emailKey) return false;

    if (mainRecord) {
      const local = _getLocal(USERS_STORE_KEY);
      local[emailKey] = mainRecord;
      _setLocal(USERS_STORE_KEY, local);
    }
    if (archivedRecord) {
      const deleted = _getLocal(DELETED_STORE_KEY);
      deleted[emailKey] = archivedRecord;
      _setLocal(DELETED_STORE_KEY, deleted);
    }

    if (!_syncEnabled || !_db) return false;
    try {
      const fbKey = _encodeKey(emailKey);
      const updates = {};
      if (mainRecord)    updates[`${USERS_PATH}/${fbKey}`]   = mainRecord;
      if (archivedRecord) updates[`${DELETED_PATH}/${fbKey}`] = archivedRecord;
      await _db.ref().update(updates);
      return true;
    } catch (err) {
      console.warn('[PTSync] deleteUser failed:', err.message);
      return false;
    }
  }

  /**
   * Restore a soft-deleted user back to the active users path.
   */
  async function restoreUser(emailKey, record) {
    if (!emailKey || !record) return false;

    const local = _getLocal(USERS_STORE_KEY);
    const deletedLocal = _getLocal(DELETED_STORE_KEY);
    local[emailKey] = { ...record, deleted: false };
    delete deletedLocal[emailKey];
    _setLocal(USERS_STORE_KEY, local);
    _setLocal(DELETED_STORE_KEY, deletedLocal);

    if (!_syncEnabled || !_db) return false;
    try {
      const fbKey = _encodeKey(emailKey);
      const updates = {};
      updates[`${USERS_PATH}/${fbKey}`] = { ...record, deleted: false };
      updates[`${DELETED_PATH}/${fbKey}`] = null; // remove from deleted archive
      await _db.ref().update(updates);
      return true;
    } catch (err) {
      console.warn('[PTSync] restoreUser failed:', err.message);
      return false;
    }
  }

  /**
   * Permanently delete a user from both Firebase and localStorage.
   */
  async function purgeUser(emailKey) {
    if (!emailKey) return false;

    const local = _getLocal(USERS_STORE_KEY);
    const deletedLocal = _getLocal(DELETED_STORE_KEY);
    delete local[emailKey];
    delete deletedLocal[emailKey];
    _setLocal(USERS_STORE_KEY, local);
    _setLocal(DELETED_STORE_KEY, deletedLocal);

    if (!_syncEnabled || !_db) return false;
    try {
      const fbKey = _encodeKey(emailKey);
      const updates = {};
      updates[`${USERS_PATH}/${fbKey}`]   = null;
      updates[`${DELETED_PATH}/${fbKey}`] = null;
      await _db.ref().update(updates);
      return true;
    } catch (err) {
      console.warn('[PTSync] purgeUser failed:', err.message);
      return false;
    }
  }

  /**
   * Returns true if Firebase sync is active.
   */
  function isEnabled() {
    if (window.PT_AUTH_LOCAL_ONLY) return false;
    return _syncEnabled && !!_db;
  }

  // ── Expose & boot ─────────────────────────────────────────────────────────
  window.PTSync = { pullAll, pushAll, getLastPullMeta, saveUser, deleteUser, restoreUser, purgeUser, isEnabled };
  _init();

})();
