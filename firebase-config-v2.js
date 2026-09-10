// ============================================================
//  Firebase Configuration — Cromton Academy (Planners Training)
//  ============================================================
//  NOTE: No import/require needed — Firebase is loaded via CDN
//  script tags in each HTML file. This file just declares the
//  config object that user-sync.js / auth-service.js pick up.
//
//  SECURITY NOTE: This file is public — that is fine.
//  The API key only identifies the project. Access is controlled by
//  Firebase Security Rules, not the key itself.
//
//  Auth + Realtime Database live on the same project as Hosting
//  (crompton-training-app) so RTDB rules (`auth != null`) are
//  satisfied by portal sign-ins.
// ============================================================

// GCP/Firebase project removed — use local browser accounts only until a
// non-Google auth provider is wired up. Keeps the portal usable on GitHub Pages.
window.PT_AUTH_LOCAL_ONLY = true;

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBwagGuH39hby-W2vtp9OpRFzKPoAQmZeA",
  authDomain:        "crompton-training-app.firebaseapp.com",
  databaseURL:       "https://crompton-training-app-default-rtdb.firebaseio.com",
  projectId:         "crompton-training-app",
  storageBucket:     "crompton-training-app.firebasestorage.app",
  messagingSenderId: "646633013932",
  appId:             "1:646633013932:web:4e89faa7356506b9621509"
};
