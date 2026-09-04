/**
 * PT Auth Service — Firebase Authentication + profile sync
 *
 * Uses Firebase Auth (email/password) for credentials.
 * Stores profile fields (name, plan, company, …) in Realtime Database
 * under users/{emailKey} via PTSync — never stores password hashes.
 *
 * Exposed as window.PTAuth
 */
(function () {
  'use strict';

  const USERS_STORE_KEY = 'cromton.users.v1';
  const SESSION_KEY = 'cromton.session.v1';
  const SECONDARY_APP_NAME = 'PTAuthSecondary';

  let _ready = false;
  let _readyPromise = null;
  let _auth = null;
  let _profileCache = null;

  function _encodeKey(key) {
    return String(key || '').replace(/\./g, ',');
  }

  function _stripSecret(record) {
    if (!record || typeof record !== 'object') return record;
    const out = Object.assign({}, record);
    delete out.pwd;
    delete out.password;
    return out;
  }

  function _getLocalUsers() {
    try { return JSON.parse(localStorage.getItem(USERS_STORE_KEY) || '{}'); }
    catch (_) { return {}; }
  }

  function _setLocalUsers(users) {
    localStorage.setItem(USERS_STORE_KEY, JSON.stringify(users || {}));
  }

  function _setSession(email) {
    if (!email) {
      localStorage.removeItem(SESSION_KEY);
      return;
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify({ key: email, email: email }));
  }

  function _mapAuthError(err) {
    const code = (err && err.code) || '';
    const messages = {
      'auth/email-already-in-use': 'An account with this email already exists. Try signing in.',
      'auth/invalid-email': 'Please enter a valid email address.',
      'auth/weak-password': 'Password must be at least 6 characters.',
      'auth/user-not-found': 'No account found with that email.',
      'auth/wrong-password': 'Incorrect password.',
      'auth/invalid-credential': 'Incorrect email or password.',
      'auth/too-many-requests': 'Too many attempts. Please try again later.',
      'auth/network-request-failed': 'Network error. Check your connection and try again.',
      'auth/operation-not-allowed': 'Email/password sign-in is not enabled for this project.'
    };
    return messages[code] || (err && err.message) || 'Authentication failed.';
  }

  function _requireAuth() {
    if (!_auth) throw new Error('Firebase Auth is not available. Check firebase-config.js and network.');
  }

  function _buildProfile(email, extras) {
    const e = (email || '').toLowerCase().trim();
    const base = {
      email: e,
      username: e.split('@')[0] || e,
      name: (extras && extras.name) || e.split('@')[0] || e,
      company: (extras && extras.company) || '',
      plan: (extras && extras.plan) || 'free',
      createdAt: (extras && extras.createdAt) || Date.now(),
      expiresAt: extras && 'expiresAt' in extras ? extras.expiresAt : null,
      uid: (extras && extras.uid) || null
    };
    if (extras && extras.billingCycle) base.billingCycle = extras.billingCycle;
    if (extras && extras.subscribedAt) base.subscribedAt = extras.subscribedAt;
    if (extras && extras.username) base.username = extras.username;
    return _stripSecret(base);
  }

  async function _persistProfile(email, profile) {
    const clean = _stripSecret(profile);
    const local = _getLocalUsers();
    local[email] = clean;
    _setLocalUsers(local);
    _profileCache = clean;
    if (window.PTSync && PTSync.isEnabled()) {
      const ok = await PTSync.saveUser(email, clean);
      if (!ok) throw new Error('Account could not be saved to cloud. Please try again.');
    }
    return clean;
  }

  async function _loadProfile(email, uid) {
    const e = (email || '').toLowerCase().trim();
    if (!e) return null;

    if (window.PTSync && PTSync.isEnabled()) {
      try {
        await PTSync.pullAll();
      } catch (_) {}
    }

    const local = _getLocalUsers();
    let profile = local[e];
    if (!profile) {
      profile = _buildProfile(e, { uid: uid || null, name: e.split('@')[0] });
      local[e] = profile;
      _setLocalUsers(local);
      if (window.PTSync && PTSync.isEnabled()) {
        try { await PTSync.saveUser(e, profile); } catch (_) {}
      }
    } else if (uid && !profile.uid) {
      profile = Object.assign({}, profile, { uid: uid });
      delete profile.pwd;
      local[e] = profile;
      _setLocalUsers(local);
      if (window.PTSync && PTSync.isEnabled()) {
        try { await PTSync.saveUser(e, profile); } catch (_) {}
      }
    } else if (profile.pwd) {
      profile = _stripSecret(profile);
      local[e] = profile;
      _setLocalUsers(local);
    }
    _profileCache = profile;
    return profile;
  }

  function _getSecondaryAuth() {
    _requireAuth();
    let app;
    try {
      app = firebase.app(SECONDARY_APP_NAME);
    } catch (_) {
      app = firebase.initializeApp(FIREBASE_CONFIG, SECONDARY_APP_NAME);
    }
    return app.auth();
  }

  function _init() {
    if (
      typeof firebase === 'undefined' ||
      typeof FIREBASE_CONFIG === 'undefined' ||
      !FIREBASE_CONFIG.apiKey ||
      FIREBASE_CONFIG.apiKey === 'YOUR_API_KEY'
    ) {
      console.warn('[PTAuth] Firebase Auth unavailable — local-only mode.');
      _readyPromise = Promise.resolve(false);
      return;
    }

    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(FIREBASE_CONFIG);
      }
      _auth = firebase.auth();
    } catch (err) {
      console.warn('[PTAuth] Init failed:', err.message);
      _readyPromise = Promise.resolve(false);
      return;
    }

    _readyPromise = new Promise((resolve) => {
      const unsub = _auth.onAuthStateChanged(async (fbUser) => {
        try {
          if (fbUser && fbUser.email) {
            const email = fbUser.email.toLowerCase().trim();
            _setSession(email);
            await _loadProfile(email, fbUser.uid);
          } else {
            _profileCache = null;
            _setSession(null);
          }
        } catch (err) {
          console.warn('[PTAuth] Auth state sync failed:', err.message);
        } finally {
          _ready = true;
          resolve(true);
          unsub();
          // Keep listening for later sign-in/out
          _auth.onAuthStateChanged(async (user) => {
            if (user && user.email) {
              const email = user.email.toLowerCase().trim();
              _setSession(email);
              await _loadProfile(email, user.uid);
            } else {
              _profileCache = null;
              _setSession(null);
            }
            if (typeof window.__PTAuthStateHook === 'function') {
              try { window.__PTAuthStateHook(user); } catch (_) {}
            }
          });
        }
      });
    });

    console.info('[PTAuth] Firebase Authentication ready');
  }

  async function ready() {
    if (_readyPromise) return _readyPromise;
    return false;
  }

  function isEnabled() {
    return !!_auth;
  }

  function currentUser() {
    if (_profileCache) return _profileCache;
    try {
      const session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      const key = session && (session.key || session.email);
      if (!key) return null;
      const users = _getLocalUsers();
      return users[key] || null;
    } catch (_) {
      return null;
    }
  }

  function currentFirebaseUser() {
    return _auth ? _auth.currentUser : null;
  }

  async function signUp(email, password, name, company, extras) {
    _requireAuth();
    email = (email || '').toLowerCase().trim();
    if (!email || !email.includes('@')) throw new Error('Please enter a valid email address.');
    if (!password || password.length < 6) throw new Error('Password must be at least 6 characters.');

    let cred;
    try {
      cred = await _auth.createUserWithEmailAndPassword(email, password);
    } catch (err) {
      throw new Error(_mapAuthError(err));
    }

    if (name && cred.user) {
      try { await cred.user.updateProfile({ displayName: name }); } catch (_) {}
    }

    const profile = _buildProfile(email, Object.assign({
      name: (name || email.split('@')[0]).trim(),
      company: (company || '').trim(),
      uid: cred.user.uid,
      plan: 'free'
    }, extras || {}));

    try {
      await _persistProfile(email, profile);
    } catch (err) {
      // Best-effort rollback of orphaned Auth user isn't possible from client
      // without Admin SDK; surface the cloud error instead.
      throw err;
    }
    _setSession(email);
    return profile;
  }

  async function signIn(identifier, password) {
    _requireAuth();
    const email = (identifier || '').toLowerCase().trim();
    if (!email) throw new Error('Please enter your email address.');
    if (!email.includes('@')) {
      throw new Error('Please sign in with your full email address.');
    }

    try {
      await _auth.signInWithEmailAndPassword(email, password);
    } catch (err) {
      throw new Error(_mapAuthError(err));
    }

    const fbUser = _auth.currentUser;
    const profile = await _loadProfile(email, fbUser && fbUser.uid);
    _setSession(email);
    return profile;
  }

  async function signOut() {
    if (_auth) {
      try { await _auth.signOut(); } catch (_) {}
    }
    _profileCache = null;
    _setSession(null);
  }

  /**
   * Create a user without switching the current signed-in session
   * (used by the admin panel).
   */
  async function createUserAsAdmin(email, password, profileFields) {
    _requireAuth();
    email = (email || '').toLowerCase().trim();
    if (!email || !email.includes('@')) throw new Error('Please enter a valid email address.');
    if (!password || password.length < 6) throw new Error('Password must be at least 6 characters.');

    const secondary = _getSecondaryAuth();
    let cred;
    try {
      cred = await secondary.createUserWithEmailAndPassword(email, password);
    } catch (err) {
      throw new Error(_mapAuthError(err));
    }

    const profile = _buildProfile(email, Object.assign({}, profileFields || {}, {
      uid: cred.user.uid,
      name: (profileFields && profileFields.name) || email.split('@')[0],
      company: (profileFields && profileFields.company) || '',
      plan: (profileFields && profileFields.plan) || 'free',
      createdAt: Date.now(),
      expiresAt: (profileFields && profileFields.expiresAt) || null
    }));

    // Write profile while the new user session is active on the secondary app
    // (RTDB rules require auth). Then sign the secondary session out.
    try {
      const secondaryDb = firebase.app(SECONDARY_APP_NAME).database();
      await secondaryDb.ref(`users/${_encodeKey(email)}`).set(profile);
    } catch (err) {
      try { await secondary.signOut(); } catch (_) {}
      throw new Error(err.message || 'Could not save user profile to Firebase.');
    }

    try { await secondary.signOut(); } catch (_) {}

    const local = _getLocalUsers();
    local[email] = profile;
    _setLocalUsers(local);
    return profile;
  }

  async function updateProfile(email, patch) {
    const e = (email || '').toLowerCase().trim();
    const local = _getLocalUsers();
    const existing = local[e] || _buildProfile(e, {});
    const next = _stripSecret(Object.assign({}, existing, patch || {}, { email: e }));
    return _persistProfile(e, next);
  }

  async function ensureSeedAdmin(config) {
    const cfg = config || {};
    const email = (cfg.email || '').toLowerCase().trim();
    const password = cfg.password || '';
    if (!email || !email.includes('@') || !password || password.length < 6) {
      return null;
    }
    if (!_auth) return null;

    // If already signed in as this admin, just ensure profile exists.
    const current = _auth.currentUser;
    if (current && (current.email || '').toLowerCase() === email) {
      return _loadProfile(email, current.uid);
    }

    try {
      return await createUserAsAdmin(email, password, {
        username: cfg.username || email.split('@')[0],
        name: cfg.name || 'Administrator',
        company: cfg.company || 'Cromton Academy',
        plan: cfg.plan || 'enterprise',
        billingCycle: 'annual',
        subscribedAt: Date.now(),
        expiresAt: null
      });
    } catch (err) {
      const msg = (err && err.message) || '';
      if (/already exists/i.test(msg)) {
        const local = _getLocalUsers();
        if (local[email]) {
          local[email] = _stripSecret(local[email]);
          _setLocalUsers(local);
          return local[email];
        }
        return _buildProfile(email, {
          username: cfg.username || email.split('@')[0],
          name: cfg.name || 'Administrator',
          company: cfg.company || 'Cromton Academy',
          plan: cfg.plan || 'enterprise',
          billingCycle: 'annual',
          expiresAt: null
        });
      }
      console.warn('[PTAuth] Seed admin skipped:', msg);
      return null;
    }
  }

  window.PTAuth = {
    ready,
    isEnabled,
    currentUser,
    currentFirebaseUser,
    signUp,
    signIn,
    signOut,
    createUserAsAdmin,
    updateProfile,
    ensureSeedAdmin,
    stripSecret: _stripSecret
  };

  _init();
})();
