// ============================================================
//  ScrapMap configuration
// ============================================================
//
//  The map uses OpenStreetMap — FREE, no account, no key, no card.
//  You only need to set up ONE thing: Firebase (also free, no card).
//
// ------------------------------------------------------------
//  1) FIREBASE CONFIG  (where your places are saved in the cloud)
// ------------------------------------------------------------
window.firebaseConfig = {
  apiKey: "AIzaSyBEW8gBnArou-Fc9Da6yy8T3BIQri0XD_E",
  authDomain: "scrapmaps-b3487.firebaseapp.com",
  projectId: "scrapmaps-b3487",
  storageBucket: "scrapmaps-b3487.firebasestorage.app",
  messagingSenderId: "641442671717",
  appId: "1:641442671717:web:34d15d9528cacd9322aa8c",
};

// ------------------------------------------------------------
//  2) 4-digit code to open the app (so random people can't).
//     Change "1234" to your own code. Leave as "" for no code.
//     You only type it once per phone/computer.
// ------------------------------------------------------------
window.APP_PIN = "1234";

// ------------------------------------------------------------
//  3) Where the map opens by default (change to your area).
//     Default = Reykjavík, Iceland.  [longitude, latitude]
// ------------------------------------------------------------
window.MAP_START = {
  center: [-21.9426, 64.1466],
  zoom: 12,
};
