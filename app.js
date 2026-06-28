import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updateProfile,
  updateEmail,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js";
import {
  doc, setDoc, getDoc, getDocs, deleteDoc, addDoc, updateDoc,
  collection, query, where, orderBy, limit,
  onSnapshot, serverTimestamp, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
// Catatan: tidak pakai Firebase Storage lagi (butuh paket Blaze/berbayar).
// Foto & voice note disimpan langsung sebagai base64 di Firestore (gratis, paket Spark).
//
// ══ FIRESTORE SECURITY RULES yang dibutuhkan ══════════════════════════
//
// rules_version = '2';
// service cloud.firestore {
//   match /databases/{database}/documents {
//
//     // User profiles & username index
//     match /users/{uid}         { allow read: if request.auth != null; allow write: if request.auth.uid == uid; }
//     match /usernames/{name}    { allow read: if request.auth != null; allow write: if request.auth != null; }
//
//     // Contacts (setiap user baca koleksi miliknya sendiri; tulis dibuka untuk
//     // user terotentikasi manapun karena unfollow/terima-teman butuh menulis
//     // ke koleksi milik LAWAN juga, mis. waktu A batal-ikuti B, A perlu hapus
//     // dokumen contacts/B/list/A. Tanpa ini, operasi itu gagal sebagian/total
//     // dan kedua sisi jadi tidak sinkron.
//     match /contacts/{uid}/list/{tid} {
//       allow read:  if request.auth.uid == uid;
//       allow write: if request.auth != null;
//     }
//
//     // Friend requests
//     match /friendRequests/{reqId} { allow read, write: if request.auth != null; }
//
//     // Chats & messages
//     match /chats/{chatId}          { allow read, write: if request.auth != null && request.auth.uid in resource.data.members; }
//     match /chats/{chatId}/messages/{msgId} { allow read, write: if request.auth != null; }
//
//     // Blokir — PENTING: dua koleksi terpisah supaya tidak perlu cross-read
//     // blocks/{uid}/list/{targetUid}  → "aku memblokir siapa" — dibaca pemilik
//     // blocked/{uid}/by/{blockerUid}  → "aku diblokir siapa"  — dibaca pemilik
//     match /blocks/{uid}/list/{tid}   { allow read, write: if request.auth.uid == uid; }
//     match /blocked/{uid}/by/{bid}    { allow read: if request.auth.uid == uid;
//                                        allow write: if request.auth != null; }
//
//     // Groups (grup chat)
//     match /groups/{groupId} {
//       allow read, update, delete: if request.auth != null && request.auth.uid in resource.data.members;
//       allow create: if request.auth != null && request.auth.uid in request.resource.data.members;
//     }
//     match /groups/{groupId}/messages/{msgId} { allow read, write: if request.auth != null; }
//
//     // IP limits
//     match /ipLimits/{ip} { allow read, write: if true; }
//   }
// }
//

// ─── Helpers ─────────────────────────────────────────────────────
const el  = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");

function toast(msg, duration = 3200) {
  const t = el("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), duration);
}

function firebaseErr(code) {
  return ({
    "auth/user-not-found"        : "Email belum terdaftar.",
    "auth/wrong-password"        : "Password salah.",
    "auth/invalid-credential"    : "Email atau password salah.",
    "auth/email-already-in-use"  : "Email sudah dipakai akun lain.",
    "auth/weak-password"         : "Password minimal 6 karakter.",
    "auth/invalid-email"         : "Format email tidak valid.",
    "auth/too-many-requests"     : "Terlalu banyak percobaan, coba lagi nanti.",
    "auth/network-request-failed": "Tidak ada koneksi internet.",
    "auth/operation-not-allowed" : "Login email belum diaktifkan di Firebase Console.",
    "auth/requires-recent-login" : "Sesi terlalu lama. Masukkan password saat ini untuk konfirmasi.",
  })[code] || ("Error: " + code);
}

// Dipakai di mana-mana: mendukung error code Firebase ATAU Error custom (cuma .message)
function describeAuthError(err) {
  if (err && err.code) return firebaseErr(err.code);
  return (err && err.message) || "Terjadi kesalahan tidak terduga.";
}

function fmtTime(ts) {
  try {
    const d = ts?.toDate ? ts.toDate() : (ts instanceof Date ? ts : null);
    if (!d) return "";
    return d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

// ─── Routing ──────────────────────────────────────────────────────
const PANELS = ["panel-splash","panel-auth","panel-home","panel-new-chat","panel-chat-room","panel-group-room","panel-create-group","panel-view-profile","panel-group-info"];
function show(name) {
  PANELS.forEach(p => { const n = el(p); if (n) n.style.display = "none"; });
  const t = el("panel-" + name);
  if (t) t.style.display = "flex";
}

// ─── Theme ────────────────────────────────────────────────────────
let currentTheme = localStorage.getItem("xgram_theme") || "light";
function setTheme(t) {
  currentTheme = t;
  document.body.classList.toggle("dark", t === "dark");
  localStorage.setItem("xgram_theme", t);
}

// ─── Multi-akun: konstanta & local storage ─────────────────────────
const MAX_SAVED_ACCOUNTS = 999;          // maksimal akun tersimpan / boleh dibuat dari 1 IP-web
const SAVED_ACCOUNTS_KEY = "xgram_saved_accounts";

function getSavedAccounts() {
  try { return JSON.parse(localStorage.getItem(SAVED_ACCOUNTS_KEY) || "[]"); }
  catch { return []; }
}
function setSavedAccounts(list) {
  localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(list));
}
// Simpan/refresh akun di daftar lokal. Akun paling baru dipakai naik ke urutan
// pertama; kalau sudah penuh (>MAX_SAVED_ACCOUNTS) akun paling lama tergeser.
function upsertSavedAccount({ uid, email, username, password, photoURL }) {
  let list = getSavedAccounts();
  const idx = list.findIndex(a => a.uid === uid);
  if (idx >= 0) {
    const merged = {
      ...list[idx],
      email:    email    ?? list[idx].email,
      username: username ?? list[idx].username,
      password: password ?? list[idx].password,
      photoURL: photoURL ?? list[idx].photoURL,
    };
    list.splice(idx, 1);
    list.unshift(merged);
  } else {
    list.unshift({ uid, email, username, password, photoURL: photoURL || "" });
  }
  if (list.length > MAX_SAVED_ACCOUNTS) list = list.slice(0, MAX_SAVED_ACCOUNTS);
  setSavedAccounts(list);
}
function updateSavedAccountMeta(uid, patch) {
  const list = getSavedAccounts();
  const idx = list.findIndex(a => a.uid === uid);
  if (idx >= 0) { list[idx] = { ...list[idx], ...patch }; setSavedAccounts(list); }
}
function removeSavedAccount(uid) {
  setSavedAccounts(getSavedAccounts().filter(a => a.uid !== uid));
}

// ─── Multi-akun: limit registrasi 2 akun per IP/jaringan ───────────
async function getClientIp() {
  try {
    const res  = await fetch("https://api.ipify.org?format=json");
    const data = await res.json();
    return data?.ip || null;
  } catch (e) {
    console.warn("Gagal mendeteksi IP publik:", e);
    return null; // kalau gagal deteksi, jangan blokir user — biarkan lanjut
  }
}
function sanitizeIpKey(ip) {
  return String(ip).replace(/[^A-Za-z0-9_.-]/g, "_");
}
// Dipanggil SEBELUM createUserWithEmailAndPassword. Melempar Error kalau IP
// sudah mencapai batas maksimal akun yang dibuat.
async function enforceIpRegisterLimit() {
  // IP limit dinonaktifkan — registrasi tidak dibatasi per IP.
  return null;
}
async function registerIpAccount(ipKey, uid) {
  if (!ipKey) return;
  try {
    await setDoc(doc(db, "ipLimits", ipKey),
      { uids: arrayUnion(uid), updatedAt: serverTimestamp() },
      { merge: true });
  } catch (e) {
    console.warn("Gagal mencatat ipLimits (non-fatal):", e);
  }
}

// ─── Logout ─────────────────────────────────────────────────────────
// Dipakai bareng oleh tombol Logout di Settings.
async function doLogout() {
  // Reset flag supaya onAuthStateChanged tidak di-skip
  authTransitionInProgress = false;
  await cleanupCurrentSessionListeners();
  try {
    await signOut(auth);
    currentUser = null;
    lastUid     = null;
    toast("Sudah logout.");
    show("auth");
  } catch (err) {
    console.error("Logout error:", err);
    toast("Gagal logout: " + (err?.message || err));
  }
}
let currentUser     = null;
let lastUid          = null;  // uid terakhir yang ditangani onAuthStateChanged (deteksi ganti akun)
let authTransitionInProgress = false; // true selagi performLogin/performRegister jalan manual

let homeTabUnsubs    = [];   // listener aktif punya tab Home saat ini
let incomingReqUnsub = null; // listener global: permintaan teman masuk
let incomingRequests = [];   // cache permintaan masuk
let onIncomingChange = null; // dipanggil ulang render kalau tab Contacts aktif

let messagesUnsub    = null; // listener pesan di chat room aktif
let currentChatId        = null;
let currentChatPeer      = null;  // {uid, username, displayName}
let currentChatMembers   = null;
let currentChatMemberInfo= null;

let isRecording   = false;
let mediaRecorder = null;
let recordedChunks = [];
let mediaStream    = null;
let recordingAutoStopTimer = null;

function clearHomeTabListeners() {
  homeTabUnsubs.forEach(u => { try { u(); } catch {} });
  homeTabUnsubs = [];
  onIncomingChange = null;
  // Remove contacts FAB if present
  const fab = document.getElementById("contacts-fab-wrap");
  if (fab) fab.remove();
}

// Bersihkan semua listener punya akun yang SEDANG aktif sebelum pindah ke akun lain.
async function cleanupCurrentSessionListeners() {
  stopIncomingRequestsListener();
  clearHomeTabListeners();
  if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
}

// ─── Firestore helpers: users & username index ────────────────────

async function saveUserToFirestore(user, username) {
  await setDoc(doc(db, "users", user.uid), {
    uid:           user.uid,
    username:      username,
    usernameLower: username.toLowerCase(),
    email:         user.email,
    displayName:   username,
    photoURL:      "",
    bio:           "",
    createdAt:     serverTimestamp(),
  });
}

async function isUsernameTaken(username) {
  const snap = await getDoc(doc(db, "usernames", username.toLowerCase()));
  if (snap.exists()) return true;
  // double-check langsung ke collection users, jaga-jaga index belum ada
  try {
    const qs = await getDocs(query(collection(db, "users"), where("usernameLower", "==", username.toLowerCase())));
    return !qs.empty;
  } catch { return false; }
}

async function reserveUsername(username, uid) {
  await setDoc(doc(db, "usernames", username.toLowerCase()), { uid });
}

// Cari user: index dulu (cepat), kalau gagal/ga ada baru fallback query
// langsung ke collection "users". Ini benerin bug "user ada tapi gak ketemu"
// yang terjadi kalau dokumen index usernames/{username} gagal/telat tersimpan.
async function findUserByUsername(usernameRaw) {
  const uname      = String(usernameRaw || "").trim();
  const unameLower = uname.toLowerCase();
  if (!unameLower) return null;

  // 1) lewat index
  try {
    const idxSnap = await getDoc(doc(db, "usernames", unameLower));
    if (idxSnap.exists()) {
      const uid      = idxSnap.data().uid;
      const userSnap = await getDoc(doc(db, "users", uid));
      if (userSnap.exists()) return userSnap.data();
    }
  } catch (e) {
    console.warn("Lookup index username gagal, lanjut fallback:", e);
  }

  // 2) fallback: query langsung ke users (tetap ketemu walau index hilang/telat)
  try {
    const qs = await getDocs(
      query(collection(db, "users"), where("usernameLower", "==", unameLower), limit(1))
    );
    if (!qs.empty) {
      const data = qs.docs[0].data();
      // self-heal: perbaiki index supaya pencarian berikutnya lebih cepat
      reserveUsername(data.username, data.uid).catch(() => {});
      return data;
    }
  } catch (e) {
    console.warn("Fallback query users gagal:", e);
  }

  return null;
}

// ─── Settings: ganti username & email ───────────────────────────────

async function changeUsername(newUsernameRaw) {
  const newUsername = String(newUsernameRaw || "").trim();
  if (newUsername.length < 3) throw new Error("Username minimal 3 karakter.");
  if (!/^[a-zA-Z0-9_]+$/.test(newUsername)) {
    throw new Error("Username hanya boleh huruf, angka, dan underscore (_).");
  }

  const oldUsername = currentUser.displayName || "";
  if (newUsername.toLowerCase() === oldUsername.toLowerCase()) {
    throw new Error("Username baru sama dengan username sekarang.");
  }

  const taken = await isUsernameTaken(newUsername);
  if (taken) throw new Error(`Username "${newUsername}" sudah dipakai. Coba nama lain.`);

  // 1) Update profil utama
  await updateProfile(currentUser, { displayName: newUsername });
  await setDoc(doc(db, "users", currentUser.uid), {
    username:      newUsername,
    usernameLower: newUsername.toLowerCase(),
    displayName:   newUsername,
  }, { merge: true });
  await reserveUsername(newUsername, currentUser.uid);
  if (oldUsername) {
    try { await deleteDoc(doc(db, "usernames", oldUsername.toLowerCase())); } catch {}
  }
  updateSavedAccountMeta(currentUser.uid, { username: newUsername });

  // 2) Update dokumen contacts milik semua kontak yang menyimpan username lama kita
  try {
    const myContactsSnap = await getDocs(collection(db, "contacts", currentUser.uid, "list"));
    const friendUids = myContactsSnap.docs.map(d => d.id);
    await Promise.allSettled(
      friendUids.map(fuid =>
        setDoc(
          doc(db, "contacts", fuid, "list", currentUser.uid),
          { username: newUsername, displayName: newUsername },
          { merge: true }
        )
      )
    );
  } catch (e) {
    console.warn("Gagal update contacts teman (non-fatal):", e);
  }

  // 3) Update memberInfo di semua dokumen chat yang melibatkan kita
  try {
    const chatsSnap = await getDocs(
      query(collection(db, "chats"), where("members", "array-contains", currentUser.uid))
    );
    await Promise.allSettled(
      chatsSnap.docs.map(d =>
        setDoc(
          doc(db, "chats", d.id),
          { memberInfo: { [currentUser.uid]: { username: newUsername, displayName: newUsername } } },
          { merge: true }
        )
      )
    );
  } catch (e) {
    console.warn("Gagal update memberInfo chat (non-fatal):", e);
  }
}

async function changeEmail(newEmailRaw, currentPassword) {
  const newEmail = String(newEmailRaw || "").trim();
  if (!newEmail) throw new Error("Email baru wajib diisi.");
  if (newEmail.toLowerCase() === (currentUser.email || "").toLowerCase()) {
    throw new Error("Email baru sama dengan email sekarang.");
  }

  try {
    if (currentPassword) {
      const cred = EmailAuthProvider.credential(currentUser.email, currentPassword);
      await reauthenticateWithCredential(currentUser, cred);
    }
    await updateEmail(currentUser, newEmail);
  } catch (err) {
    if (err.code === "auth/requires-recent-login" && !currentPassword) {
      throw new Error("Sesi terlalu lama. Masukkan password saat ini untuk konfirmasi, lalu coba lagi.");
    }
    throw err;
  }

  await setDoc(doc(db, "users", currentUser.uid), { email: newEmail }, { merge: true });
  updateSavedAccountMeta(currentUser.uid, { email: newEmail, password: currentPassword || undefined });
}

async function changePassword(currentPass, newPass) {
  if (!currentPass) throw new Error("Password saat ini wajib diisi.");
  if (!newPass || newPass.length < 6) throw new Error("Password baru minimal 6 karakter.");
  if (currentPass === newPass) throw new Error("Password baru tidak boleh sama dengan yang lama.");
  const cred = EmailAuthProvider.credential(currentUser.email, currentPass);
  await reauthenticateWithCredential(currentUser, cred);
  await updatePassword(currentUser, newPass);
  updateSavedAccountMeta(currentUser.uid, { password: newPass });
}

// ─── Block / Unfollow ─────────────────────────────────────────────────

async function blockUser(targetUid) {
  // Tulis di sisi blocker (aku memblokir siapa)
  await setDoc(doc(db, "blocks", currentUser.uid, "list", targetUid), {
    uid: targetUid, blockedAt: serverTimestamp(),
  });
  // Tulis di sisi yang diblokir (aku diblokir siapa) → bisa dibaca sendiri tanpa cross-permission
  await setDoc(doc(db, "blocked", targetUid, "by", currentUser.uid), {
    uid: currentUser.uid, blockedAt: serverTimestamp(),
  });
  // Hapus kontak & request di semua sisi
  await Promise.allSettled([
    deleteDoc(doc(db, "contacts", currentUser.uid, "list", targetUid)),
    deleteDoc(doc(db, "contacts", targetUid, "list", currentUser.uid)),
    deleteDoc(doc(db, "friendRequests", reqId(currentUser.uid, targetUid))),
    deleteDoc(doc(db, "friendRequests", reqId(targetUid, currentUser.uid))),
    // Hapus chat dari daftar kedua user (hidden flag di dokumen chat)
    setDoc(doc(db, "chats", chatIdFor(currentUser.uid, targetUid)),
      { hiddenFor: arrayUnion(currentUser.uid, targetUid) }, { merge: true }),
  ]);
}

async function unblockUser(targetUid) {
  await Promise.allSettled([
    deleteDoc(doc(db, "blocks", currentUser.uid, "list", targetUid)),
    deleteDoc(doc(db, "blocked", targetUid, "by", currentUser.uid)),
  ]);
  // Unhide chat hanya dari sisi blocker (yang membuka blokir)
  const chatId = chatIdFor(currentUser.uid, targetUid);
  try {
    const chatSnap = await getDoc(doc(db, "chats", chatId));
    if (chatSnap.exists()) {
      const hidden = (chatSnap.data().hiddenFor || []).filter(u => u !== currentUser.uid);
      await setDoc(doc(db, "chats", chatId), { hiddenFor: hidden }, { merge: true });
    }
  } catch {}
}

async function unfriendUser(targetUid) {
  // Hapus kontak di kedua sisi; TIDAK memblokir — masih bisa minta teman lagi
  // Sembunyikan chat dari daftar kedua sisi
  const results = await Promise.allSettled([
    deleteDoc(doc(db, "contacts", currentUser.uid, "list", targetUid)),
    deleteDoc(doc(db, "contacts", targetUid, "list", currentUser.uid)),
    setDoc(doc(db, "chats", chatIdFor(currentUser.uid, targetUid)),
      { hiddenFor: arrayUnion(currentUser.uid) }, { merge: true }),
  ]);
  const failed = results.find(r => r.status === "rejected");
  if (failed) {
    // Jangan biarkan gagal diam-diam — kalau salah satu sisi gagal terhapus,
    // status pertemanan jadi tidak sinkron antara kedua user (sumber bug
    // "cannot read properties of undefined" saat user lain mencari/lihat profil).
    console.error("unfriendUser: salah satu operasi gagal:", failed.reason);
    throw new Error(
      "Batal ikuti tidak sepenuhnya berhasil (kemungkinan rules Firestore koleksi " +
      "'contacts' belum dibuka untuk tulis dua arah). Cek konsol untuk detail."
    );
  }
}

async function isBlocked(targetUid) {
  // Aku memblokir target — baca koleksi milikku sendiri ✓
  const snap = await getDoc(doc(db, "blocks", currentUser.uid, "list", targetUid));
  return snap.exists();
}

async function isBlockedBy(targetUid) {
  // Aku diblokir target — baca koleksi milikku sendiri (`blocked/{myUid}/by/{targetUid}`) ✓
  // Tidak perlu cross-read ke koleksi milik user lain
  const snap = await getDoc(doc(db, "blocked", currentUser.uid, "by", targetUid));
  return snap.exists();
}

// ─── Auth inti: dipakai bersama oleh form login utama & "Tambah Akun" ─

async function performRegister(emailRaw, pass, unameRaw) {
  const email = String(emailRaw || "").trim();
  const uname = String(unameRaw || "").trim();

  if (!email) throw new Error("Email wajib diisi.");
  if (!pass)  throw new Error("Password wajib diisi.");
  if (uname.length < 3) throw new Error("Username minimal 3 karakter.");
  if (!/^[a-zA-Z0-9_]+$/.test(uname)) {
    throw new Error("Username hanya boleh huruf, angka, dan underscore (_).");
  }

  const taken = await isUsernameTaken(uname);
  if (taken) throw new Error(`Username "${uname}" sudah dipakai. Coba nama lain.`);

  // Batasi maksimal 2 akun yang boleh terdaftar dari IP/jaringan yang sama.
  const ipKey = await enforceIpRegisterLimit();

  await cleanupCurrentSessionListeners();
  authTransitionInProgress = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await updateProfile(cred.user, { displayName: uname });
    await saveUserToFirestore(cred.user, uname);

    // index username tidak boleh menggagalkan seluruh registrasi —
    // kalau ini gagal, pencarian tetap bisa jalan lewat fallback query.
    try { await reserveUsername(uname, cred.user.uid); }
    catch (e) { console.warn("reserveUsername gagal (non-fatal):", e); }

    await registerIpAccount(ipKey, cred.user.uid);
    upsertSavedAccount({ uid: cred.user.uid, email, username: uname, password: pass });

    currentUser = cred.user;
    lastUid     = cred.user.uid;
    startIncomingRequestsListener();
    return cred.user;
  } finally {
    authTransitionInProgress = false;
  }
}

async function performLogin(emailRaw, pass) {
  const email = String(emailRaw || "").trim();
  if (!email) throw new Error("Email wajib diisi.");
  if (!pass)  throw new Error("Password wajib diisi.");

  await cleanupCurrentSessionListeners();
  authTransitionInProgress = true;
  try {
    const cred = await signInWithEmailAndPassword(auth, email, pass);
    upsertSavedAccount({
      uid: cred.user.uid, email: cred.user.email,
      username: cred.user.displayName || "", password: pass,
    });
    currentUser = cred.user;
    lastUid     = cred.user.uid;
    startIncomingRequestsListener();
    return cred.user;
  } finally {
    authTransitionInProgress = false;
  }
}

async function switchToSavedAccount(acc) {
  if (!acc?.password) { toast("❌ Tidak ada kredensial tersimpan untuk akun ini."); return; }
  if (currentUser && acc.uid === currentUser.uid) { toast("Akun ini sedang aktif."); return; }
  try {
    toast("🔄 Mengganti akun…", 4000);
    await performLogin(acc.email, acc.password);
    show("home");
    setTab("chats");
    toast("✅ Sekarang masuk sebagai @" + (acc.username || acc.email));
  } catch (err) {
    console.error("Switch account error:", err);
    toast("❌ Gagal ganti akun: " + describeAuthError(err));
  }
}

// ─── Firestore helpers: kontak & permintaan teman ──────────────────

async function isAlreadyContact(targetUid) {
  const snap = await getDoc(doc(db, "contacts", currentUser.uid, "list", targetUid));
  return snap.exists();
}

function reqId(fromUid, toUid) { return `${fromUid}_${toUid}`; }

// status: 'none' | 'contact' | 'sent' | 'received' | 'blocking' | 'blocked_by'
async function getRelationship(targetUid) {
  if (!currentUser || !targetUid) return { status: "none" };

  // Cek blokir dulu
  if (await isBlocked(targetUid).catch(() => false)) return { status: "blocking" };
  if (await isBlockedBy(targetUid).catch(() => false)) return { status: "blocked_by" };

  if (await isAlreadyContact(targetUid).catch(() => false)) return { status: "contact" };

  try {
    const sentSnap = await getDoc(doc(db, "friendRequests", reqId(currentUser.uid, targetUid)));
    if (sentSnap.exists() && sentSnap.data()?.status === "pending") {
      return { status: "sent" };
    }
  } catch (e) { console.warn("Cek friendRequest terkirim gagal:", e); }

  try {
    const recvSnap = await getDoc(doc(db, "friendRequests", reqId(targetUid, currentUser.uid)));
    if (recvSnap.exists() && recvSnap.data()?.status === "pending") {
      return { status: "received", req: { id: recvSnap.id, ...recvSnap.data() } };
    }
  } catch (e) { console.warn("Cek friendRequest masuk gagal:", e); }

  return { status: "none" };
}

async function sendFriendRequest(targetUser) {
  await setDoc(doc(db, "friendRequests", reqId(currentUser.uid, targetUser.uid)), {
    from:            currentUser.uid,
    to:              targetUser.uid,
    fromUsername:    currentUser.displayName,
    fromDisplayName: currentUser.displayName,
    toUsername:      targetUser.username,
    toDisplayName:   targetUser.displayName || targetUser.username,
    status:          "pending",
    createdAt:       serverTimestamp(),
  });
}

async function acceptFriendRequest(reqIdToAccept, fromUid, fromUsername, fromDisplayName) {
  const results = await Promise.allSettled([
    setDoc(doc(db, "contacts", currentUser.uid, "list", fromUid), {
      uid: fromUid, username: fromUsername,
      displayName: fromDisplayName || fromUsername,
      addedAt: serverTimestamp(),
    }),
    setDoc(doc(db, "contacts", fromUid, "list", currentUser.uid), {
      uid: currentUser.uid, username: currentUser.displayName,
      displayName: currentUser.displayName,
      addedAt: serverTimestamp(),
    }),
  ]);
  const failed = results.find(r => r.status === "rejected");
  if (failed) {
    console.error("acceptFriendRequest gagal menulis kontak:", failed.reason);
    throw new Error(
      "Gagal menyimpan pertemanan (kemungkinan rules Firestore untuk koleksi 'contacts' " +
      "belum dibuka untuk tulis dua arah). Cek konsol untuk detail."
    );
  }
  await deleteDoc(doc(db, "friendRequests", reqIdToAccept));

  // Munculkan kembali riwayat chat jika sebelumnya tersembunyi (setelah batal ikuti / re-follow)
  const chatId = chatIdFor(currentUser.uid, fromUid);
  try {
    const chatSnap = await getDoc(doc(db, "chats", chatId));
    if (chatSnap.exists()) {
      await setDoc(doc(db, "chats", chatId), { hiddenFor: [] }, { merge: true });
    }
  } catch {}
}

async function rejectFriendRequest(reqIdToReject) {
  await deleteDoc(doc(db, "friendRequests", reqIdToReject));
}

// ─── Permintaan teman masuk: listener global (untuk badge + tab Contacts) ─

function startIncomingRequestsListener() {
  if (incomingReqUnsub || !currentUser) return;
  incomingReqUnsub = onSnapshot(
    query(collection(db, "friendRequests"),
      where("to", "==", currentUser.uid), where("status", "==", "pending")),
    (snap) => {
      incomingRequests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      updateRequestBadge();
      if (onIncomingChange) onIncomingChange();
    },
    (err) => console.error("Incoming requests listener error:", err)
  );
}

function stopIncomingRequestsListener() {
  if (incomingReqUnsub) { incomingReqUnsub(); incomingReqUnsub = null; }
  incomingRequests = [];
  updateRequestBadge();
}

// Titik kecil notifikasi di tab Contacts (bottom nav) kalau ada permintaan masuk.
function updateRequestBadge() {
  const btn = document.querySelector('.bottom-nav button[data-tab="contacts"]');
  if (btn) btn.classList.toggle("has-badge", incomingRequests.length > 0);
}

// ─── Home Tabs ────────────────────────────────────────────────────
async function setTab(tab) {
  document.querySelectorAll(".bottom-nav button[data-tab]").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === tab)
  );
  el("home-title").textContent =
    { chats:"Chats", contacts:"Contacts", profile:"Profile", settings:"Settings" }[tab] || tab;

  // Tombol + di header hanya muncul di tab Chats
  const newChatBtn = el("btn-new-chat");
  if (newChatBtn) newChatBtn.style.display = (tab === "chats") ? "" : "none";

  clearHomeTabListeners();
  const content = el("home-content");

  if (tab === "chats") {
    content.innerHTML = `<div class="loading-text">Memuat chat…</div>`;

    let dmChats    = [];
    let groupChats = [];

    function renderChatList() {
      const allItems = [
        ...dmChats.map(d => ({ ...d, _type: "dm" })),
        ...groupChats.map(d => ({ ...d, _type: "group" })),
      ].sort((a, b) => {
        const ta = a.updatedAt?.toMillis?.() || 0;
        const tb = b.updatedAt?.toMillis?.() || 0;
        return tb - ta;
      });

      if (!allItems.length) {
        content.innerHTML = `<div class="empty">
          <div class="empty__icon">💬</div>
          <div class="empty__title">Belum ada chat</div>
          <div class="empty__desc">Tap ➕ untuk mulai percakapan baru.</div>
        </div>`;
        return;
      }

      content.innerHTML = allItems.map(c => {
        if (c._type === "group") {
          const photo = c.photoURL ? `<img src="${esc(c.photoURL)}" class="avatar-img" />` : `<div class="avatar-letter">${(c.name||"G")[0].toUpperCase()}</div>`;
          return `<div class="list-item" data-open-group="${esc(c._id)}">
            <div class="avatar avatar--group">${photo}</div>
            <div class="meta">
              <div class="top"><div class="name">${esc(c.name || "Grup")}</div><div class="time">${esc(fmtTime(c.updatedAt))}</div></div>
              <div class="preview">👥 ${esc(c.lastMessage || "Grup chat")}</div>
            </div>
          </div>`;
        }
        // DM
        const otherUid = (c.members || []).find(u => u !== currentUser.uid);
        const info = (c.memberInfo && c.memberInfo[otherUid]) || {};
        const name = info.displayName || info.username || "Pengguna";
        const photo = info.photoURL ? `<img src="${esc(info.photoURL)}" class="avatar-img" />` : `<div class="avatar-placeholder"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg></div>`;
        return `<div class="list-item" data-open-chat="${esc(otherUid)}"
                     data-username="${esc(info.username || "")}"
                     data-name="${esc(name)}">
          <div class="avatar">${photo}</div>
          <div class="meta">
            <div class="top"><div class="name">${esc(name)}</div><div class="time">${esc(fmtTime(c.updatedAt))}</div></div>
            <div class="preview">${esc(c.lastMessage || "")}</div>
          </div>
        </div>`;
      }).join("");

      content.querySelectorAll("[data-open-chat]").forEach(node => {
        node.addEventListener("click", () => openChatRoom({
          uid: node.dataset.openChat,
          username: node.dataset.username,
          displayName: node.dataset.name,
        }));
      });
      content.querySelectorAll("[data-open-group]").forEach(node => {
        node.addEventListener("click", () => openGroupRoom(node.dataset.openGroup));
      });
    }

    // DM chats
    const unsubDm = onSnapshot(
      query(collection(db, "chats"), where("members", "array-contains", currentUser.uid), orderBy("updatedAt", "desc")),
      (snap) => {
        dmChats = snap.docs
          .filter(d => !(d.data().hiddenFor || []).includes(currentUser.uid))
          .map(d => ({ _id: d.id, ...d.data() }));
        renderChatList();
      },
      (err) => { console.error("Chats listener error:", err); }
    );
    homeTabUnsubs.push(unsubDm);

    // Group chats — tanpa orderBy agar tidak butuh composite index Firestore.
    // Pengurutan sudah dilakukan di renderChatList() sisi client.
    const unsubGroup = onSnapshot(
      query(collection(db, "groups"), where("members", "array-contains", currentUser.uid)),
      (snap) => {
        groupChats = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
        renderChatList();
      },
      (err) => { console.error("Groups listener error:", err); }
    );
    homeTabUnsubs.push(unsubGroup);
  }

  else if (tab === "contacts") {
    content.innerHTML = `<div class="loading-text">Memuat kontak…</div>`;

    // FAB (+) pojok kanan bawah
    const existingFab = document.getElementById("contacts-fab-wrap");
    if (existingFab) existingFab.remove();
    const fabWrap = document.createElement("div");
    fabWrap.id = "contacts-fab-wrap";
    fabWrap.innerHTML = `
      <div id="contacts-fab-menu" class="contacts-fab-menu" style="display:none;">
        <button class="contacts-fab-option" id="fab-search-user">
          <span class="contacts-fab-option__icon">🔍</span>
          <span>Cari User</span>
        </button>
        <button class="contacts-fab-option" id="fab-create-group">
          <span class="contacts-fab-option__icon">👥</span>
          <span>Buat Grup</span>
        </button>
      </div>
      <button class="contacts-fab" id="contacts-fab-btn" title="Tambah">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
      </button>`;
    document.getElementById("panel-home").querySelector(".app-shell").appendChild(fabWrap);

    let fabOpen = false;
    document.getElementById("contacts-fab-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      fabOpen = !fabOpen;
      document.getElementById("contacts-fab-menu").style.display = fabOpen ? "flex" : "none";
      document.getElementById("contacts-fab-btn").classList.toggle("contacts-fab--open", fabOpen);
    });
    document.addEventListener("click", function closeFab() {
      fabOpen = false;
      const menu = document.getElementById("contacts-fab-menu");
      const btn  = document.getElementById("contacts-fab-btn");
      if (menu) menu.style.display = "none";
      if (btn)  btn.classList.remove("contacts-fab--open");
    });
    document.getElementById("fab-search-user").addEventListener("click", () => show("new-chat"));
    document.getElementById("fab-create-group").addEventListener("click", () => showCreateGroup());

    let contactsCache = null;

    function render() {
      if (contactsCache === null) return; // belum siap
      let html = "";

      if (incomingRequests.length) {
        html += `<div class="section-label">Permintaan Teman (${incomingRequests.length})</div>`;
        html += incomingRequests.map(r => `
          <div class="list-item req-item" style="cursor:default;">
            <div class="avatar">👤</div>
            <div class="meta">
              <div class="top"><div class="name">${esc(r.fromDisplayName || r.fromUsername)}</div></div>
              <div class="preview">@${esc(r.fromUsername)} ingin berteman</div>
            </div>
            <div class="req-actions">
              <button class="btn sm" data-accept-req="${esc(r.id)}" data-from="${esc(r.from)}"
                data-fromuser="${esc(r.fromUsername)}" data-fromname="${esc(r.fromDisplayName || r.fromUsername)}">✓</button>
              <button class="btn secondary sm" data-reject-req="${esc(r.id)}">✕</button>
            </div>
          </div>`).join("");
        html += `<div style="height:14px"></div>`;
      }

      html += `<div class="section-label">Kontak</div>`;
      if (!contactsCache.length) {
        html += `<div class="empty">
          <div class="empty__icon">👥</div>
          <div class="empty__title">Belum ada kontak</div>
          <div class="empty__desc">Tambah teman lewat tombol ➕.</div>
        </div>`;
      } else {
        html += contactsCache.map(c => {
            const contactPhoto = c.photoURL
              ? `<img src="${esc(c.photoURL)}" class="avatar-img" />`
              : `<div class="avatar-placeholder"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg></div>`;
            return `<div class="list-item" style="cursor:default;">
            <div class="avatar" style="cursor:pointer;" data-open-chat="${esc(c.uid)}"
              data-username="${esc(c.username)}" data-name="${esc(c.displayName || c.username)}">${contactPhoto}</div>
            <div class="meta" style="cursor:pointer;" data-open-chat="${esc(c.uid)}"
              data-username="${esc(c.username)}" data-name="${esc(c.displayName || c.username)}">
              <div class="top"><div class="name">${esc(c.displayName || c.username)}</div></div>
              <div class="preview">@${esc(c.username)}</div>
            </div>
            <div class="req-actions">
              <button class="btn btn--sm btn--secondary" data-unfriend="${esc(c.uid)}" data-uname="${esc(c.username)}" title="Batal Ikuti">👤✕</button>
              <button class="btn btn--sm btn--danger" data-block="${esc(c.uid)}" data-uname="${esc(c.username)}" title="Blokir">🚫</button>
            </div>
          </div>`;
          }).join("");
      }

      content.innerHTML = html;

      content.querySelectorAll("[data-open-chat]").forEach(node => {
        node.addEventListener("click", () => openChatRoom({
          uid: node.dataset.openChat,
          username: node.dataset.username,
          displayName: node.dataset.name,
        }));
      });
      content.querySelectorAll("[data-unfriend]").forEach(btn => {
        btn.addEventListener("click", async () => {
          const uname = btn.dataset.uname;
          if (!confirm(`Batal ikuti @${uname}?\nMereka masih bisa kirim permintaan teman lagi ke kamu.`)) return;
          btn.disabled = true; btn.textContent = "⏳";
          try {
            await unfriendUser(btn.dataset.unfriend);
            toast("✅ Sudah batal ikuti @" + uname + ".");
          } catch (e) { toast("❌ " + e.message); btn.disabled = false; btn.textContent = "👤✕"; }
        });
      });
      content.querySelectorAll("[data-block]").forEach(btn => {
        btn.addEventListener("click", async () => {
          const uname = btn.dataset.uname;
          if (!confirm(`Blokir @${uname}?\nMereka tidak akan bisa kirim permintaan teman lagi.`)) return;
          btn.disabled = true; btn.textContent = "⏳";
          try {
            await blockUser(btn.dataset.block);
            toast("✅ @" + uname + " diblokir.");
          } catch (e) { toast("❌ " + e.message); btn.disabled = false; btn.textContent = "🚫"; }
        });
      });
      content.querySelectorAll("[data-accept-req]").forEach(btn => {
        btn.addEventListener("click", async () => {
          btn.disabled = true; btn.textContent = "⏳";
          try {
            await acceptFriendRequest(btn.dataset.acceptReq, btn.dataset.from, btn.dataset.fromuser, btn.dataset.fromname);
            toast("✅ Pertemanan dengan " + btn.dataset.fromname + " diterima!");
          } catch (e) {
            console.error(e); toast("❌ Gagal menerima: " + e.message);
            btn.disabled = false; btn.textContent = "✓";
          }
        });
      });
      content.querySelectorAll("[data-reject-req]").forEach(btn => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try { await rejectFriendRequest(btn.dataset.rejectReq); toast("Permintaan ditolak."); }
          catch (e) { console.error(e); toast("❌ Gagal menolak: " + e.message); btn.disabled = false; }
        });
      });
    }

    onIncomingChange = render;
    render();

    const unsub = onSnapshot(
      collection(db, "contacts", currentUser.uid, "list"),
      (snap) => { contactsCache = snap.docs.map(d => d.data()); render(); },
      (err) => {
        console.error("Contacts listener error:", err);
        content.innerHTML = `<div class="empty">
          <div class="empty__icon">⚠️</div>
          <div class="empty__title">Gagal memuat kontak</div>
          <div class="empty__desc">${esc(err.message)}</div>
        </div>`;
      }
    );
    homeTabUnsubs.push(unsub);
  }

  else if (tab === "profile") {
    content.innerHTML = `<div class="loading-text">Memuat profil…</div>`;
    try {
      const snap = await getDoc(doc(db, "users", currentUser.uid));
      const uData = snap.exists() ? snap.data() : {};
      const photoURL = uData.photoURL || "";
      const bio = uData.bio || "";
      content.innerHTML = `
        <div class="profile-page">
          <div class="profile-page__hero">
            <div class="profile-page__avatar-wrap" id="pp-avatar-wrap">
              ${photoURL
                ? `<img src="${esc(photoURL)}" class="profile-page__avatar-img" alt="Foto profil" />`
                : `<div class="profile-page__avatar-placeholder"><svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg></div>`}
              <button class="profile-page__avatar-edit" id="btn-change-photo" title="Ganti foto profil">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <input type="file" id="input-profile-photo" accept="image/*" hidden />
            </div>
            <div class="profile-page__name">${esc(currentUser.displayName || "—")}</div>
            <div class="profile-page__username">@${esc(currentUser.displayName || "—")}</div>
          </div>

          <div class="profile-page__section">
            <div class="profile-page__section-label">Bio</div>
            <div class="profile-page__bio-wrap">
              <textarea id="pp-bio" class="profile-page__bio-input" placeholder="Tulis sesuatu tentang kamu…" maxlength="160">${esc(bio)}</textarea>
              <div class="profile-page__bio-counter"><span id="pp-bio-count">${bio.length}</span>/160</div>
              <button class="btn btn--primary btn--sm" id="btn-save-bio" type="button">Simpan Bio</button>
            </div>
          </div>

          <div class="profile-page__section">
            <button id="btn-go-settings-2" class="profile-page__link-btn" type="button">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              Ubah Username, Email & Password
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-left:auto"><path d="M9 18l6-6-6-6"/></svg>
            </button>
          </div>
        </div>`;

      el("pp-bio")?.addEventListener("input", () => {
        const len = el("pp-bio").value.length;
        el("pp-bio-count").textContent = len;
      });

      el("btn-save-bio")?.addEventListener("click", async () => {
        const btn = el("btn-save-bio");
        const bioVal = el("pp-bio").value.trim();
        btn.disabled = true; btn.textContent = "⏳";
        try {
          await updateDoc(doc(db, "users", currentUser.uid), { bio: bioVal });
          toast("✅ Bio disimpan!");
        } catch (e) { toast("❌ Gagal: " + e.message); }
        finally { btn.disabled = false; btn.textContent = "Simpan Bio"; }
      });

      el("btn-change-photo")?.addEventListener("click", () => el("input-profile-photo")?.click());
      el("input-profile-photo")?.addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        toast("📷 Mengupload foto profil…", 5000);
        try {
          let dataUrl = await compressImage(file, 400, 0.82);
          if (dataUrl.length > 300000) dataUrl = await compressImage(file, 260, 0.7);
          if (dataUrl.length > 300000) { toast("❌ Foto terlalu besar, coba foto lebih kecil."); return; }
          // 1) Simpan ke profil utama
          await updateDoc(doc(db, "users", currentUser.uid), { photoURL: dataUrl });
          // Simpan ke saved accounts lokal agar muncul di Settings
          updateSavedAccountMeta(currentUser.uid, { photoURL: dataUrl });

          // 2) Propagate ke semua chats memberInfo agar foto muncul di daftar chat
          try {
            const chatsSnap = await getDocs(
              query(collection(db, "chats"), where("members", "array-contains", currentUser.uid))
            );
            await Promise.allSettled(chatsSnap.docs.map(d =>
              setDoc(doc(db, "chats", d.id),
                { memberInfo: { [currentUser.uid]: { photoURL: dataUrl } } },
                { merge: true })
            ));
          } catch (e2) { console.warn("Propagate foto ke chats gagal (non-fatal):", e2); }

          // 3) Propagate ke semua contacts agar foto muncul di daftar kontak orang lain
          try {
            const myContactsSnap = await getDocs(collection(db, "contacts", currentUser.uid, "list"));
            const friendUids = myContactsSnap.docs.map(d => d.id);
            await Promise.allSettled(friendUids.map(fuid =>
              setDoc(doc(db, "contacts", fuid, "list", currentUser.uid),
                { photoURL: dataUrl },
                { merge: true })
            ));
          } catch (e3) { console.warn("Propagate foto ke contacts gagal (non-fatal):", e3); }

          toast("✅ Foto profil diperbarui!");
          setTab("profile");
        } catch (err) { toast("❌ Gagal upload: " + err.message); }
        e.target.value = "";
      });

      el("btn-go-settings-2")?.addEventListener("click", () => setTab("settings"));
    } catch (e) {
      content.innerHTML = `<div class="empty"><div class="empty__icon">⚠️</div><div class="empty__title">Gagal memuat profil</div><div class="empty__desc">${esc(e.message)}</div></div>`;
    }
  }

  else if (tab === "settings") {
    renderSettingsTab(content);
  }
}

// ─── Settings tab: tampilan, ubah username/email, multi-akun ──────

function renderSettingsTab(content) {
  const u = currentUser;

  content.innerHTML = `
    <!-- ── Tampilan ── -->
    <div class="settings-group">
      <div class="settings-group__header">Tampilan</div>
      <div class="settings-row" style="cursor:default;">
        <div class="settings-row__left">
          <div class="settings-row__icon settings-row__icon--purple">🎨</div>
          <div>
            <div class="settings-row__title">Tema</div>
            <div class="settings-row__sub">Pilih tampilan aplikasi</div>
          </div>
        </div>
        <div class="theme-toggle">
          <button id="btn-light" class="btn${currentTheme==="light"?" active":""}" type="button">☀️ Light</button>
          <button id="btn-dark"  class="btn${currentTheme==="dark" ?" active":""}" type="button">🌙 Dark</button>
        </div>
      </div>
    </div>

    <!-- ── Ubah Username ── -->
    <div class="settings-group" id="sg-username">
      <div class="settings-group__header">Akun</div>
      <div class="settings-row" id="row-username">
        <div class="settings-row__left">
          <div class="settings-row__icon settings-row__icon--blue">👤</div>
          <div>
            <div class="settings-row__title">Username</div>
            <div class="settings-row__sub">@${esc(u?.displayName || "—")}</div>
          </div>
        </div>
        <span class="settings-row__chevron">›</span>
      </div>
      <div class="edit-form" id="form-username" style="display:none;margin:0 12px 12px;">
        <div class="edit-form__title">Ubah Username</div>
        <div class="field">
          <label class="field__label" for="set-username">Username baru</label>
          <input id="set-username" class="field__input" type="text" value="${esc(u?.displayName || "")}" placeholder="username_baru" autocomplete="off" />
        </div>
        <div style="display:flex;gap:8px;">
          <button id="btn-save-username" class="btn btn--primary" type="button" style="flex:1;">Simpan</button>
          <button id="btn-cancel-username" class="btn btn--secondary" type="button">Batal</button>
        </div>
      </div>

      <div class="settings-row" id="row-email">
        <div class="settings-row__left">
          <div class="settings-row__icon settings-row__icon--green">✉️</div>
          <div>
            <div class="settings-row__title">Email</div>
            <div class="settings-row__sub">${esc(u?.email || "—")}</div>
          </div>
        </div>
        <span class="settings-row__chevron">›</span>
      </div>
      <div class="edit-form" id="form-email" style="display:none;margin:0 12px 12px;">
        <div class="edit-form__title">Ubah Email</div>
        <div class="field">
          <label class="field__label" for="set-email">Email baru</label>
          <input id="set-email" class="field__input" type="email" value="${esc(u?.email || "")}" placeholder="email@contoh.com" autocomplete="off" />
        </div>
        <div class="field">
          <label class="field__label" for="set-email-pass">Password saat ini</label>
          <input id="set-email-pass" class="field__input" type="password" placeholder="••••••••" autocomplete="off" />
        </div>
        <div style="display:flex;gap:8px;">
          <button id="btn-save-email" class="btn btn--primary" type="button" style="flex:1;">Simpan</button>
          <button id="btn-cancel-email" class="btn btn--secondary" type="button">Batal</button>
        </div>
      </div>

      <div class="settings-row" id="row-password">
        <div class="settings-row__left">
          <div class="settings-row__icon settings-row__icon--blue">🔑</div>
          <div>
            <div class="settings-row__title">Password</div>
            <div class="settings-row__sub">Ubah kata sandi akun</div>
          </div>
        </div>
        <span class="settings-row__chevron">›</span>
      </div>
      <div class="edit-form" id="form-password" style="display:none;margin:0 12px 12px;">
        <div class="edit-form__title">Ubah Password</div>
        <div class="field">
          <label class="field__label" for="set-pass-current">Password saat ini</label>
          <input id="set-pass-current" class="field__input" type="password" placeholder="••••••••" autocomplete="off" />
        </div>
        <div class="field">
          <label class="field__label" for="set-pass-new">Password baru</label>
          <input id="set-pass-new" class="field__input" type="password" placeholder="Min. 6 karakter" autocomplete="off" />
        </div>
        <div class="field">
          <label class="field__label" for="set-pass-confirm">Konfirmasi password baru</label>
          <input id="set-pass-confirm" class="field__input" type="password" placeholder="Ulangi password baru" autocomplete="off" />
        </div>
        <div style="display:flex;gap:8px;">
          <button id="btn-save-password" class="btn btn--primary" type="button" style="flex:1;">Simpan</button>
          <button id="btn-cancel-password" class="btn btn--secondary" type="button">Batal</button>
        </div>
      </div>
    </div>

    <!-- ── Akun Tersimpan ── -->
    <div class="settings-group">
      <div class="settings-group__header">Akun Tersimpan (maks. ${MAX_SAVED_ACCOUNTS})</div>
      <div id="saved-accounts-list" class="account-chips" style="padding:8px 12px;"></div>
      <div style="padding:0 12px 12px;">
        <button id="btn-add-account" class="btn btn--secondary" type="button" style="width:100%;">➕ Tambah / Masuk Akun Lain</button>
        <div id="add-account-box" style="display:none;margin-top:12px;">
          <div class="edit-form">
            <div class="edit-form__title">Tambah Akun</div>
            <div class="theme-toggle" style="margin-bottom:4px;">
              <button id="aa-tab-login"    class="btn active" type="button">Masuk</button>
              <button id="aa-tab-register" class="btn"        type="button">Daftar</button>
            </div>
            <form id="aa-form" autocomplete="off" novalidate style="display:flex;flex-direction:column;gap:10px;">
              <input type="hidden" id="aa-mode" value="login" />
              <div class="field">
                <label class="field__label" for="aa-email">Email</label>
                <input id="aa-email" class="field__input" type="email" placeholder="email@contoh.com" autocomplete="off" />
              </div>
              <div class="field">
                <label class="field__label" for="aa-pass">Password</label>
                <input id="aa-pass" class="field__input" type="password" placeholder="••••••••" autocomplete="off" />
              </div>
              <div class="field" id="aa-username-field" style="display:none;">
                <label class="field__label" for="aa-username">Username</label>
                <input id="aa-username" class="field__input" type="text" placeholder="Contoh: budi_123" autocomplete="off" />
              </div>
              <div style="display:flex;gap:8px;">
                <button id="aa-submit" class="btn btn--primary" type="submit" style="flex:1;">Masuk</button>
                <button id="aa-cancel" class="btn btn--secondary" type="button">Batal</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Logout ── -->
    <div class="settings-group">
      <div class="settings-row" id="btn-logout-2" style="color:var(--danger);">
        <div class="settings-row__left">
          <div class="settings-row__icon settings-row__icon--red">🚪</div>
          <div class="settings-row__title" style="color:var(--danger);">Logout</div>
        </div>
      </div>
    </div>
  `;

  // — Tampilan —
  el("btn-light")?.addEventListener("click", () => { setTheme("light"); setTab("settings"); });
  el("btn-dark")?.addEventListener("click",  () => { setTheme("dark");  setTab("settings"); });

  // — Toggle helper —
  function toggleForm(rowId, formId) {
    const allForms = ["form-username", "form-email", "form-password"];
    allForms.forEach(f => {
      if (f !== formId) el(f).style.display = "none";
    });
    const form = el(formId);
    form.style.display = form.style.display === "none" ? "block" : "none";
  }

  el("row-username")?.addEventListener("click", () => toggleForm("row-username", "form-username"));
  el("row-email")?.addEventListener("click",    () => toggleForm("row-email",    "form-email"));
  el("row-password")?.addEventListener("click", () => toggleForm("row-password", "form-password"));

  el("btn-cancel-username")?.addEventListener("click", () => { el("form-username").style.display = "none"; });
  el("btn-cancel-email")?.addEventListener("click",    () => { el("form-email").style.display    = "none"; });
  el("btn-cancel-password")?.addEventListener("click", () => { el("form-password").style.display = "none"; });

  // — Ubah username —
  el("btn-save-username")?.addEventListener("click", async () => {
    const btn = el("btn-save-username");
    const val = el("set-username").value.trim();
    btn.disabled = true; btn.textContent = "⏳ Menyimpan…";
    try {
      await changeUsername(val);
      toast("✅ Username berhasil diganti.");
      setTab("settings");
    } catch (err) {
      toast("❌ " + describeAuthError(err));
      btn.disabled = false; btn.textContent = "Simpan";
    }
  });

  // — Ubah email —
  el("btn-save-email")?.addEventListener("click", async () => {
    const btn  = el("btn-save-email");
    const val  = el("set-email").value.trim();
    const pass = el("set-email-pass").value;
    btn.disabled = true; btn.textContent = "⏳ Menyimpan…";
    try {
      await changeEmail(val, pass);
      toast("✅ Email berhasil diganti.");
      setTab("settings");
    } catch (err) {
      toast("❌ " + describeAuthError(err));
      btn.disabled = false; btn.textContent = "Simpan";
    }
  });

  // — Ubah password —
  el("btn-save-password")?.addEventListener("click", async () => {
    const btn     = el("btn-save-password");
    const current = el("set-pass-current").value;
    const newPw   = el("set-pass-new").value;
    const confirm = el("set-pass-confirm").value;
    if (newPw !== confirm) { toast("❌ Konfirmasi password tidak cocok."); return; }
    btn.disabled = true; btn.textContent = "⏳ Menyimpan…";
    try {
      await changePassword(current, newPw);
      toast("✅ Password berhasil diubah.");
      el("form-password").style.display = "none";
      el("set-pass-current").value = "";
      el("set-pass-new").value = "";
      el("set-pass-confirm").value = "";
    } catch (err) {
      toast("❌ " + describeAuthError(err));
    } finally {
      btn.disabled = false; btn.textContent = "Simpan";
    }
  });

  // — Multi-akun —
  renderSavedAccountsList();
  updateAddAccountButtonState();

  el("btn-add-account")?.addEventListener("click", () => {
    if (getSavedAccounts().length >= MAX_SAVED_ACCOUNTS) {
      toast(`❌ Maksimal ${MAX_SAVED_ACCOUNTS} akun. Hapus salah satu dulu.`);
      return;
    }
    const box = el("add-account-box");
    box.style.display = (box.style.display === "none") ? "block" : "none";
  });

  function switchAaMode(mode) {
    el("aa-mode").value = mode;
    const isReg = mode === "register";
    el("aa-submit").textContent = isReg ? "Daftar" : "Masuk";
    el("aa-username-field").style.display = isReg ? "flex" : "none";
    el("aa-tab-login")?.classList.toggle("active", !isReg);
    el("aa-tab-register")?.classList.toggle("active", isReg);
  }
  el("aa-tab-login")?.addEventListener("click",    () => switchAaMode("login"));
  el("aa-tab-register")?.addEventListener("click", () => switchAaMode("register"));
  el("aa-cancel")?.addEventListener("click", () => {
    el("add-account-box").style.display = "none";
    el("aa-form")?.reset();
    switchAaMode("login");
  });

  el("aa-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const mode  = el("aa-mode").value;
    const email = el("aa-email").value.trim();
    const pass  = el("aa-pass").value;
    const uname = el("aa-username").value.trim();

    if (!email) { toast("❌ Email wajib diisi."); return; }
    if (!pass)  { toast("❌ Password wajib diisi."); return; }
    if (mode === "register" && !uname) { toast("❌ Username wajib diisi."); return; }

    const submitBtn = el("aa-submit");
    submitBtn.disabled = true; submitBtn.textContent = "⏳ Loading…";
    try {
      if (mode === "register") {
        await performRegister(email, pass, uname);
        toast("✅ Akun baru dibuat & sekarang aktif!");
      } else {
        await performLogin(email, pass);
        toast("✅ Akun ditambahkan & sekarang aktif!");
      }
      show("home"); setTab("chats");
    } catch (err) {
      toast("❌ " + describeAuthError(err));
      submitBtn.disabled = false;
      submitBtn.textContent = mode === "register" ? "Daftar" : "Masuk";
    }
  });

  // — Logout —
  el("btn-logout-2")?.addEventListener("click", () => {
    if (!confirm("Yakin mau logout?")) return;
    doLogout();
  });
}

function renderSavedAccountsList() {
  const wrap = el("saved-accounts-list");
  if (!wrap) return;
  const list = getSavedAccounts();

  if (!list.length) {
    wrap.innerHTML = `<div class="empty" style="padding:20px 0;">
      <div class="empty__icon">🗂️</div>
      <div class="empty__title" style="font-size:14px;">Belum ada akun tersimpan</div>
      <div class="empty__desc">Akun yang kamu pakai login akan otomatis tersimpan di sini.</div>
    </div>`;
    return;
  }

  wrap.innerHTML = list.map(a => {
    const isActive = currentUser && a.uid === currentUser.uid;
    const avatarHtml = a.photoURL
      ? `<img src="${esc(a.photoURL)}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;" />`
      : `<div class="account-chip__avatar" style="display:flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:50%;background:var(--primary);color:#fff;font-size:16px;font-weight:700;">${(a.username||a.email||"?")[0].toUpperCase()}</div>`;
    return `<div class="account-chip">
      ${avatarHtml}
      <div class="account-chip__info">
        <div class="account-chip__name">${esc(a.username || a.email)}</div>
        <div class="account-chip__email">${esc(a.email)}</div>
      </div>
      ${isActive
        ? `<span class="account-chip__badge account-chip__badge--current">Aktif</span>`
        : `<button class="btn btn--sm btn--primary" data-switch-acc="${esc(a.uid)}">Ganti</button>`}
      <button class="btn btn--sm btn--secondary" data-remove-acc="${esc(a.uid)}" title="Hapus dari daftar">✕</button>
    </div>`;
  }).join("");

  wrap.querySelectorAll("[data-switch-acc]").forEach(btn => {
    btn.addEventListener("click", () => {
      const acc = getSavedAccounts().find(a => a.uid === btn.dataset.switchAcc);
      if (acc) switchToSavedAccount(acc);
    });
  });
  wrap.querySelectorAll("[data-remove-acc]").forEach(btn => {
    btn.addEventListener("click", () => {
      removeSavedAccount(btn.dataset.removeAcc);
      toast("Akun dihapus dari daftar tersimpan (akun aslinya tidak ikut terhapus).");
      renderSavedAccountsList();
      updateAddAccountButtonState();
    });
  });
}

function updateAddAccountButtonState() {
  const btn = el("btn-add-account");
  if (!btn) return;
  const full = getSavedAccounts().length >= MAX_SAVED_ACCOUNTS;
  btn.disabled = full;
  btn.title = full ? `Maksimal ${MAX_SAVED_ACCOUNTS} akun tersimpan. Hapus salah satu dulu.` : "";
}

// ─── Auth (form login/daftar utama) ────────────────────────────────
function initAuth() {
  const modeInput = el("auth-mode");
  const titleEl   = el("auth-title");
  const submitBtn = el("auth-submit");
  const userField = el("username-field");

  function switchMode(mode) {
    modeInput.value = mode;
    const isReg = mode === "register";
    titleEl.textContent     = isReg ? "Daftar Akun" : "Masuk";
    submitBtn.textContent   = isReg ? "Daftar" : "Masuk";
    userField.style.display = isReg ? "flex" : "none";
    el("btn-open-login")?.classList.toggle("active", !isReg);
    el("btn-open-register")?.classList.toggle("active", isReg);
  }

  el("btn-open-login")?.addEventListener("click",    () => switchMode("login"));
  el("btn-open-register")?.addEventListener("click", () => switchMode("register"));
  switchMode("login");

  el("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();

    const mode  = modeInput.value;
    const email = el("auth-email").value.trim();
    const pass  = el("auth-pass").value;
    const uname = el("auth-username").value.trim();

    if (!email) { toast("❌ Email wajib diisi."); return; }
    if (!pass)  { toast("❌ Password wajib diisi."); return; }
    if (mode === "register") {
      if (!uname) { toast("❌ Username wajib diisi."); return; }
      if (uname.length < 3) { toast("❌ Username minimal 3 karakter."); return; }
      if (!/^[a-zA-Z0-9_]+$/.test(uname)) {
        toast("❌ Username hanya boleh huruf, angka, dan underscore (_).");
        return;
      }
    }

    submitBtn.disabled    = true;
    submitBtn.textContent = "⏳ Loading…";

    try {
      if (mode === "register") {
        await performRegister(email, pass, uname);
        toast("✅ Registrasi berhasil! Selamat datang, " + uname + " 🎉");
      } else {
        await performLogin(email, pass);
        toast("✅ Login berhasil!");
      }
      show("home");
      setTab("chats");
    } catch (err) {
      console.error("Auth error:", err);
      toast("❌ " + describeAuthError(err));
    } finally {
      submitBtn.disabled    = false;
      submitBtn.textContent = mode === "register" ? "Daftar" : "Masuk";
    }
  });

}

// ─── New Chat (cari & tambah teman) ────────────────────────────────
let foundUserData = null;

function renderSearchResultButton(rel, found) {
  const wrap = el("user-found");
  if (!wrap || !rel || !found) return;

  if (rel.status === "blocking") {
    // Kita memblokir mereka — tampilkan opsi buka blokir
    wrap.innerHTML = `
      <div class="sr-btn-group">
        <button id="btn-unblock" class="btn btn--danger btn--full" type="button">🚫 Buka Blokir</button>
      </div>
      <p class="sr-hint">Kamu memblokir pengguna ini. Buka blokir agar bisa berinteraksi lagi.</p>`;
    el("btn-unblock").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = "⏳";
      try {
        await unblockUser(found.uid);
        toast("✅ Blokir dibuka. Kamu bisa kirim permintaan teman lagi.");
        const newRel = await getRelationship(found.uid);
        renderSearchResultButton(newRel, found);
      } catch (err) { toast("❌ " + err.message); btn.disabled = false; btn.textContent = "🚫 Buka Blokir"; }
    });
    return;
  }

  if (rel.status === "blocked_by") {
    wrap.innerHTML = `<p class="sr-hint" style="text-align:center;padding:12px 0;">Tidak dapat berinteraksi dengan pengguna ini.</p>`;
    return;
  }

  if (rel.status === "contact") {
    wrap.innerHTML = `
      <div class="sr-btn-group">
        <button id="btn-open-chat" class="btn btn--primary" type="button" style="flex:1;">💬 Buka Chat</button>
        <button id="btn-unfriend" class="btn btn--secondary" type="button">Batal Ikuti</button>
        <button id="btn-block" class="btn btn--danger" type="button">🚫 Blokir</button>
      </div>`;
    el("btn-open-chat").addEventListener("click", () => openChatRoom(found));
    el("btn-unfriend").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (!confirm(`Batal ikuti @${found.username}? Mereka masih bisa kirim permintaan teman lagi.`)) return;
      btn.disabled = true; btn.textContent = "⏳";
      try {
        await unfriendUser(found.uid);
        toast("✅ Sudah batal ikuti @" + found.username + ". Mereka masih bisa kirim permintaan teman lagi.");
        const newRel = await getRelationship(found.uid);
        renderSearchResultButton(newRel, found);
      } catch (err) { toast("❌ " + err.message); btn.disabled = false; btn.textContent = "Batal Ikuti"; }
    });
    el("btn-block").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (!confirm(`Blokir @${found.username}? Mereka tidak bisa kirim permintaan teman lagi.`)) return;
      btn.disabled = true; btn.textContent = "⏳";
      try {
        await blockUser(found.uid);
        toast("✅ @" + found.username + " diblokir.");
        const newRel = await getRelationship(found.uid);
        renderSearchResultButton(newRel, found);
      } catch (err) { toast("❌ " + err.message); btn.disabled = false; btn.textContent = "🚫 Blokir"; }
    });
    return;
  }

  if (rel.status === "sent") {
    wrap.innerHTML = `
      <div class="sr-btn-group">
        <button class="btn btn--secondary btn--full" type="button" disabled>✓ Permintaan Terkirim</button>
        <button id="btn-block-from-sent" class="btn btn--danger" type="button">🚫 Blokir</button>
      </div>`;
    el("btn-block-from-sent").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (!confirm(`Blokir @${found.username}?`)) return;
      btn.disabled = true; btn.textContent = "⏳";
      try {
        await blockUser(found.uid);
        toast("✅ @" + found.username + " diblokir.");
        const newRel = await getRelationship(found.uid);
        renderSearchResultButton(newRel, found);
      } catch (err) { toast("❌ " + err.message); btn.disabled = false; btn.textContent = "🚫 Blokir"; }
    });
    return;
  }

  if (rel.status === "received") {
    wrap.innerHTML = `
      <div class="sr-btn-group">
        <button id="btn-accept-friend" class="btn btn--primary" type="button" style="flex:1;">✅ Terima</button>
        <button id="btn-block-from-recv" class="btn btn--danger" type="button">🚫 Blokir</button>
      </div>`;
    el("btn-accept-friend").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = "⏳ Menerima…";
      try {
        await acceptFriendRequest(rel.req.id, rel.req.from, rel.req.fromUsername, rel.req.fromDisplayName);
        toast("✅ Sekarang kamu berteman dengan " + (found.displayName || found.username) + "!");
        show("home"); setTab("contacts");
      } catch (err) {
        console.error(err); toast("❌ Gagal: " + err.message);
        btn.disabled = false; btn.textContent = "✅ Terima";
      }
    });
    el("btn-block-from-recv").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (!confirm(`Blokir @${found.username}?`)) return;
      btn.disabled = true; btn.textContent = "⏳";
      try {
        await blockUser(found.uid);
        toast("✅ @" + found.username + " diblokir.");
        const newRel = await getRelationship(found.uid);
        renderSearchResultButton(newRel, found);
      } catch (err) { toast("❌ " + err.message); btn.disabled = false; btn.textContent = "🚫 Blokir"; }
    });
    return;
  }

  // status === "none"
  wrap.innerHTML = `
    <div class="sr-btn-group">
      <button id="btn-add-friend" class="btn btn--primary" type="button" style="flex:1;">➕ Tambah Teman</button>
      <button id="btn-block-none" class="btn btn--danger" type="button">🚫 Blokir</button>
    </div>`;
  el("btn-add-friend").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (!foundUserData) { toast("Cari user dulu."); return; }
    btn.disabled = true; btn.textContent = "⏳ Mengirim…";
    try {
      await sendFriendRequest(foundUserData);
      toast("✅ Permintaan teman terkirim ke " + (foundUserData.displayName || foundUserData.username) + ". Tunggu dia konfirmasi ya.");
      btn.textContent = "✓ Permintaan Terkirim";
      el("btn-block-none").style.display = "";
    } catch (err) {
      console.error(err); toast("❌ Gagal mengirim: " + err.message);
      btn.disabled = false; btn.textContent = "➕ Tambah Teman";
    }
  });
  el("btn-block-none").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (!confirm(`Blokir @${found.username}?`)) return;
    btn.disabled = true; btn.textContent = "⏳";
    try {
      await blockUser(found.uid);
      toast("✅ @" + found.username + " diblokir.");
      const newRel = await getRelationship(found.uid);
      renderSearchResultButton(newRel, found);
    } catch (err) { toast("❌ " + err.message); btn.disabled = false; btn.textContent = "🚫 Blokir"; }
  });
}

function initNewChat() {
  const input     = el("search-username");
  const resultBox = el("newchat-result");

  input.addEventListener("input", () => {
    resultBox.style.display = "none";
    foundUserData = null;
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") el("btn-search-user").click();
  });

  el("btn-search-user").addEventListener("click", async () => {
    const q = input.value.trim();
    if (!q) { toast("Masukkan username yang ingin dicari."); return; }

    const btn = el("btn-search-user");
    btn.disabled    = true;
    btn.textContent = "⏳";
    foundUserData   = null;
    resultBox.style.display = "none";

    try {
      const found = await findUserByUsername(q);
      resultBox.style.display = "block";

      if (!found) {
        el("user-found").style.display     = "none";
        el("user-not-found").style.display = "block";
        return;
      }

      if (found.uid === currentUser.uid) {
        el("user-found").style.display     = "none";
        el("user-not-found").style.display = "none";
        toast("⚠️ Itu akun kamu sendiri!");
        resultBox.style.display = "none";
        return;
      }

      foundUserData = found;
      el("newchat-result-title").textContent = found.displayName || found.username;
      el("newchat-result-bio").textContent   = "@" + found.username;
      el("user-not-found").style.display     = "none";
      el("user-found").style.display         = "block";

      const rel = await getRelationship(found.uid);
      renderSearchResultButton(rel, found);

    } catch (err) {
      console.error("Search error:", err);
      toast("❌ Gagal mencari: " + (err?.message || "Terjadi kesalahan tidak terduga (lihat console)."));
    } finally {
      btn.disabled    = false;
      btn.textContent = "Cari";
    }
  });
}

// Setelah hapus pesan, recalculate lastMessage dari pesan yang masih visible untuk user ini
async function refreshChatLastMessage(chatId, myUid) {
  try {
    const snap = await getDocs(
      query(collection(db, "chats", chatId, "messages"), orderBy("createdAt", "desc"), limit(50))
    );
    // Cari pesan terakhir yang masih bisa dilihat user ini
    let newPreview = "";
    for (const d of snap.docs) {
      const m = d.data();
      if (m.deletedForAll) continue;
      if (m.deletedFor && m.deletedFor.includes(myUid)) continue;
      // Pesan valid ditemukan
      if (m.type === "image") { newPreview = "📷 Foto"; }
      else if (m.type === "audio") { newPreview = "🎤 Voice note"; }
      else { newPreview = m.text || ""; }
      break;
    }
    await updateDoc(doc(db, "chats", chatId), { lastMessage: newPreview });
  } catch (e) {
    console.warn("refreshChatLastMessage gagal (non-fatal):", e);
  }
}

// ─── Context menu hapus pesan ──────────────────────────────────────

let activeDeleteMenu = null;

function closeDeleteMenu() {
  if (activeDeleteMenu) {
    activeDeleteMenu.remove();
    activeDeleteMenu = null;
  }
}

function showDeleteMenu(msgId, msgFrom, bubbleEl) {
  closeDeleteMenu();

  const isMine = msgFrom === currentUser.uid;
  const menu = document.createElement("div");
  menu.className = "delete-menu";

  // Posisi menu di dekat bubble
  const rect = bubbleEl.getBoundingClientRect();
  const logRect = el("chat-log").getBoundingClientRect();
  const topRel = rect.top - logRect.top + el("chat-log").scrollTop;

  menu.style.top  = topRel + "px";
  menu.style[isMine ? "right" : "left"] = "8px";

  menu.innerHTML = `
    <button class="delete-menu__item" data-action="delete-me">🗑️ Hapus untuk saya</button>
    ${isMine ? `<button class="delete-menu__item delete-menu__item--danger" data-action="delete-all">🗑️ Hapus untuk semua orang</button>` : ""}
    <button class="delete-menu__item delete-menu__item--cancel" data-action="cancel">Batal</button>
  `;

  el("chat-log").style.position = "relative";
  el("chat-log").appendChild(menu);
  activeDeleteMenu = menu;

  menu.querySelector("[data-action='cancel']")?.addEventListener("click", closeDeleteMenu);

  menu.querySelector("[data-action='delete-me']")?.addEventListener("click", async () => {
    closeDeleteMenu();
    try {
      await updateDoc(doc(db, "chats", currentChatId, "messages", msgId), {
        deletedFor: arrayUnion(currentUser.uid),
      });
      // Update preview chat kalau ini pesan terakhir
      await refreshChatLastMessage(currentChatId, currentUser.uid);
    } catch (err) {
      console.error("Hapus untuk saya error:", err);
      toast("❌ Gagal menghapus pesan: " + err.message);
    }
  });

  menu.querySelector("[data-action='delete-all']")?.addEventListener("click", async () => {
    if (!confirm("Hapus pesan untuk semua orang? Pesan tidak bisa dikembalikan.")) return;
    closeDeleteMenu();
    try {
      await updateDoc(doc(db, "chats", currentChatId, "messages", msgId), {
        deletedForAll: true,
        text: null,
        url: null,
      });
      // Update lastMessage di chat menjadi teks "dihapus" agar preview akurat
      await updateDoc(doc(db, "chats", currentChatId), {
        lastMessage: "🚫 Pesan dihapus",
      });
    } catch (err) {
      console.error("Hapus untuk semua error:", err);
      toast("❌ Gagal menghapus pesan: " + err.message);
    }
  });

  // Tutup menu kalau klik di luar
  setTimeout(() => {
    document.addEventListener("click", function handler(e) {
      if (!menu.contains(e.target)) {
        closeDeleteMenu();
        document.removeEventListener("click", handler);
      }
    });
  }, 100);
}

// ─── Chat Room (realtime, Firestore + Storage) ─────────────────────

function chatIdFor(uidA, uidB) { return [uidA, uidB].sort().join("_"); }

function bubbleHtml(m) {
  const mine = m.from === currentUser.uid;
  const time = fmtTime(m.createdAt);
  const msgId = m.id || "";

  // Pesan yang dihapus untuk semua orang
  if (m.deletedForAll) {
    return `<div class="bubble ${mine ? "bubble--me" : ""} bubble--deleted" data-msg-id="${esc(msgId)}">
      <div class="msg-text msg-text--deleted">🚫 Pesan ini telah dihapus</div>
      <div class="bubble__time">${esc(time)}</div>
    </div>`;
  }

  // Pesan yang dihapus untuk diri sendiri (hanya disembunyikan lokal via Firestore flag)
  if (m.deletedFor && m.deletedFor.includes(currentUser.uid)) {
    return ""; // Tidak tampil sama sekali untuk user ini
  }

  let body = "";
  let downloadBtn = "";
  if (m.type === "image") {
    body = `<img src="${esc(m.url)}" alt="foto" class="msg-media" />`;
    downloadBtn = `<button class="msg-download-btn" data-url="${esc(m.url)}" data-filename="foto.jpg" title="Download foto">⬇️</button>`;
  } else if (m.type === "audio") {
    body = `<audio src="${esc(m.url)}" controls class="msg-audio"></audio>`;
    downloadBtn = `<button class="msg-download-btn" data-url="${esc(m.url)}" data-filename="voice-note.webm" title="Download voice note">⬇️</button>`;
  } else {
    body = `<div class="msg-text">${esc(m.text || "")}</div>`;
  }

  return `<div class="bubble ${mine ? "bubble--me" : ""}" data-msg-id="${esc(msgId)}" data-msg-from="${esc(m.from)}">
    ${body}
    <div class="bubble__footer">
      ${downloadBtn}
      <div class="bubble__time">${esc(time)}</div>
    </div>
  </div>`;
}

function renderMessages(list) {
  const log = el("chat-log");

  // Filter: hapus pesan yang di-hide untuk user ini
  const visible = list.filter(m => {
    if (m.deletedForAll) return true;  // Tetap tampil sebagai "dihapus"
    if (m.deletedFor && m.deletedFor.includes(currentUser.uid)) return false;
    return true;
  });

  if (!visible.length) {
    log.innerHTML = `<div class="empty">
      <div class="empty__icon">👋</div>
      <div class="empty__title">Mulai obrolan</div>
      <div class="empty__desc">Kirim pesan, foto, video, atau voice note.</div>
    </div>`;
    // Kalau semua pesan dihapus untuk saya, update preview jadi kosong
    if (list.length > 0 && currentChatId) {
      updateDoc(doc(db, "chats", currentChatId), { lastMessage: "" }).catch(() => {});
    }
    return;
  }

  log.innerHTML = visible.map(bubbleHtml).filter(Boolean).join("");
  log.scrollTop = log.scrollHeight;

  // Sync lastMessage preview dengan pesan terakhir yang visible untuk saya
  // (jalankan sekali tiap load, non-blocking)
  if (currentChatId) {
    const last = [...visible].reverse().find(m => !m.deletedForAll);
    if (last) {
      let preview = "";
      if (last.type === "image") preview = "📷 Foto";
      else if (last.type === "audio") preview = "🎤 Voice note";
      else preview = last.text || "";
      // Hanya update kalau beda (avoid write loop) — cek dulu tidak perlu karena
      // Firestore deduplicate write yang sama, tapi kita throttle agar tidak spam
      if (!renderMessages._lastPreview || renderMessages._lastPreview !== preview) {
        renderMessages._lastPreview = preview;
        updateDoc(doc(db, "chats", currentChatId), { lastMessage: preview }).catch(() => {});
      }
    }
  }

  // Long-press context menu untuk hapus pesan
  log.querySelectorAll(".bubble[data-msg-id]").forEach(bubble => {
    let pressTimer = null;
    const showMenu = (e) => {
      e.preventDefault();
      const msgId   = bubble.dataset.msgId;
      const msgFrom = bubble.dataset.msgFrom;
      if (!msgId) return;
      showDeleteMenu(msgId, msgFrom, bubble);
    };
    // Touch long-press (500ms)
    bubble.addEventListener("touchstart", (e) => {
      pressTimer = setTimeout(() => showMenu(e), 500);
    }, { passive: true });
    bubble.addEventListener("touchend",   () => clearTimeout(pressTimer));
    bubble.addEventListener("touchmove",  () => clearTimeout(pressTimer));
    // Desktop right-click
    bubble.addEventListener("contextmenu", showMenu);
  });

  // Download button handler
  log.querySelectorAll(".msg-download-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const url      = btn.dataset.url;
      const filename = btn.dataset.filename || "file";
      if (!url) return;
      const a = document.createElement("a");
      a.href     = url;
      a.download = filename;
      a.target   = "_blank";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  });
}

async function openChatRoom(peer) {
  if (!peer || !peer.uid) return;

  // Cek blokir dulu
  const blockedByMe = await isBlocked(peer.uid).catch(() => false);
  if (blockedByMe) {
    toast("🚫 Kamu memblokir pengguna ini. Buka blokir dulu untuk bisa chat.");
    return;
  }
  const blockedByThem = await isBlockedBy(peer.uid).catch(() => false);
  if (blockedByThem) {
    toast("🚫 Kamu diblokir oleh pengguna ini.");
    return;
  }

  // Cek apakah masih kontak (batal ikuti = tidak bisa chat)
  const isContact = await isAlreadyContact(peer.uid).catch(() => false);
  if (!isContact) {
    toast("⚠️ Kamu perlu berteman dulu sebelum bisa chat.");
    return;
  }

  currentChatPeer       = peer;
  currentChatId         = chatIdFor(currentUser.uid, peer.uid);
  currentChatMembers    = [currentUser.uid, peer.uid];

  // Fetch my own photoURL from Firestore to include in memberInfo
  let myPhotoURL = "";
  try {
    const mySnap = await getDoc(doc(db, "users", currentUser.uid));
    myPhotoURL = mySnap.exists() ? (mySnap.data().photoURL || "") : "";
  } catch {}

  // Also fetch peer's latest photoURL
  let peerPhotoURL = peer.photoURL || "";
  if (!peerPhotoURL) {
    try {
      const peerSnap = await getDoc(doc(db, "users", peer.uid));
      peerPhotoURL = peerSnap.exists() ? (peerSnap.data().photoURL || "") : "";
    } catch {}
  }

  currentChatMemberInfo = {
    [currentUser.uid]: { username: currentUser.displayName, displayName: currentUser.displayName, photoURL: myPhotoURL },
    [peer.uid]:        { username: peer.username, displayName: peer.displayName || peer.username, photoURL: peerPhotoURL },
  };

  el("chatroom-username").textContent = peer.displayName || peer.username;
  el("chatroom-status").innerHTML = `<span class="status-dot"></span>@${esc(peer.username)}`;

  // Show peer avatar in chat header
  const peerAvatarEl = el("chatroom-peer-avatar");
  if (peerAvatarEl) {
    peerAvatarEl.innerHTML = peerPhotoURL
      ? `<img src="${esc(peerPhotoURL)}" class="chat-peer__avatar-img" />`
      : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;
  }

  el("chat-input").value = "";

  show("chat-room");
  el("chat-log").innerHTML = `<div class="loading-text">Memuat pesan…</div>`;

  if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
  messagesUnsub = onSnapshot(
    query(collection(db, "chats", currentChatId, "messages"), orderBy("createdAt"), limit(300)),
    (snap) => renderMessages(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    (err) => {
      console.error("Messages listener error:", err);
      el("chat-log").innerHTML = `<div class="empty">
        <div class="empty__icon">⚠️</div>
        <div class="empty__title">Gagal memuat pesan</div>
        <div class="empty__desc">${esc(err.message)}</div>
      </div>`;
    }
  );
}

function previewForType(type, text) {
  if (type === "image") return "📷 Foto";
  if (type === "audio") return "🎤 Voice note";
  return text || "";
}

async function sendChatMessage(type, payload) {
  if (!currentChatId || !currentChatPeer) return;

  // Cek blokir real-time sebelum kirim
  const blockedByMe   = await isBlocked(currentChatPeer.uid).catch(() => false);
  const blockedByThem = await isBlockedBy(currentChatPeer.uid).catch(() => false);
  if (blockedByMe) { toast("🚫 Kamu memblokir pengguna ini."); return; }
  if (blockedByThem) { toast("🚫 Kamu diblokir oleh pengguna ini. Pesan tidak terkirim."); return; }

  // Cek masih kontak
  const contact = await isAlreadyContact(currentChatPeer.uid).catch(() => false);
  if (!contact) { toast("⚠️ Kamu sudah tidak berteman dengan pengguna ini."); return; }

  const msg = { from: currentUser.uid, type, createdAt: serverTimestamp() };
  if (type === "text") msg.text = payload; else msg.url = payload;

  await addDoc(collection(db, "chats", currentChatId, "messages"), msg);
  await setDoc(doc(db, "chats", currentChatId), {
    members:     currentChatMembers,
    memberInfo:  currentChatMemberInfo,
    lastMessage: previewForType(type, payload),
    lastFrom:    currentUser.uid,
    updatedAt:   serverTimestamp(),
    // Pastikan tidak tersembunyi lagi ketika chat aktif dikirim
    hiddenFor:   [],
  }, { merge: true });
}

// ── Media tanpa Firebase Storage: simpan sebagai base64 langsung di Firestore ──
// Limit aman per dokumen Firestore adalah 1MB; kita jaga di bawah itu.
const MAX_BASE64_CHARS = 700_000; // ±700KB, aman untuk dokumen Firestore

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Kompres & resize foto lewat canvas supaya base64-nya kecil
function compressImage(file, maxDim = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width  = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

async function handleAttachedFile(file) {
  if (!file || !currentChatId) return;
  const isImage = file.type.startsWith("image/");
  if (!isImage) { toast("❌ Saat ini hanya bisa kirim foto (video butuh penyimpanan berbayar)."); return; }

  toast("📷 Mengirim foto…", 6000);
  try {
    let dataUrl = await compressImage(file, 1280, 0.72);
    if (dataUrl.length > MAX_BASE64_CHARS) {
      dataUrl = await compressImage(file, 800, 0.55); // kompres lebih agresif kalau masih kebesaran
    }
    if (dataUrl.length > MAX_BASE64_CHARS) {
      toast("❌ Foto masih terlalu besar setelah dikompres, coba foto lain.");
      return;
    }
    await sendChatMessage("image", dataUrl);
  } catch (err) {
    console.error("Compress/send image error:", err);
    toast("❌ Gagal mengirim foto: " + err.message);
  }
}

// ── Voice note ──
function pickAudioMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

async function startRecording() {
  if (isRecording) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("❌ Perangkat tidak mendukung rekam suara."); return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickAudioMime();
    mediaRecorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime }) : new MediaRecorder(mediaStream);
    recordedChunks = [];
    mediaRecorder.addEventListener("dataavailable", (e) => { if (e.data.size > 0) recordedChunks.push(e.data); });
    mediaRecorder.start();
    isRecording = true;
    el("btn-mic")?.classList.add("recording");
    toast("🎙️ Merekam… lepas tombol untuk kirim (maks ±30 detik)", 60000);

    // auto-stop biar ukuran file gak kebesaran buat disimpan di Firestore
    clearTimeout(recordingAutoStopTimer);
    recordingAutoStopTimer = setTimeout(() => { if (isRecording) stopRecording(); }, 30000);
  } catch (err) {
    console.error("getUserMedia error:", err);
    toast("❌ Tidak bisa mengakses mikrofon: " + err.message);
  }
}

function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  clearTimeout(recordingAutoStopTimer);
  isRecording = false;
  el("btn-mic")?.classList.remove("recording");

  mediaRecorder.addEventListener("stop", async () => {
    mediaStream?.getTracks().forEach(t => t.stop());
    mediaStream = null;

    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "audio/webm" });
    recordedChunks = [];

    if (blob.size < 800) { toast("Rekaman terlalu pendek, dibatalkan."); return; }

    toast("🎤 Mengirim voice note…", 6000);
    try {
      const dataUrl = await fileToDataUrl(blob);
      if (dataUrl.length > MAX_BASE64_CHARS) {
        toast("❌ Voice note terlalu panjang/besar, coba rekam lebih singkat.");
        return;
      }
      await sendChatMessage("audio", dataUrl);
    } catch (err) {
      console.error("Voice note send error:", err);
      toast("❌ Gagal mengirim voice note: " + err.message);
    }
  }, { once: true });

  mediaRecorder.stop();
}

function initChatRoom() {
  function sendTextMsg() {
    const input = el("chat-input");
    const msg = input.value.trim();
    if (!msg) return;
    input.value = "";
    input.focus();
    sendChatMessage("text", msg).catch(err => {
      console.error(err);
      toast("❌ Gagal mengirim pesan: " + err.message);
    });
  }

  el("send-message")?.addEventListener("click", sendTextMsg);
  el("chat-input")?.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTextMsg(); }
  });

  el("btn-attach")?.addEventListener("click", () => el("chat-attach")?.click());
  el("chat-attach")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    handleAttachedFile(file);
    e.target.value = "";
  });

  const micBtn = el("btn-mic");
  if (micBtn) {
    micBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); startRecording(); });
    micBtn.addEventListener("pointerup",   () => stopRecording());
    micBtn.addEventListener("pointerleave",() => { if (isRecording) stopRecording(); });
    micBtn.addEventListener("pointercancel",() => { if (isRecording) stopRecording(); });
  }
}

// ─── Nav ───────────────────────────────────────────────────────────
// ─── View User Profile (panel) ────────────────────────────────────

async function showUserProfile(uid) {
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (!snap.exists()) { toast("Profil tidak ditemukan."); return; }
    const u = snap.data();
    el("vp-photo").innerHTML = u.photoURL
      ? `<img src="${esc(u.photoURL)}" class="vp-photo-img" alt="Foto profil" />`
      : `<div class="vp-photo-placeholder"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg></div>`;
    el("vp-name").textContent = u.displayName || u.username || "—";
    el("vp-username").textContent = "@" + (u.username || "—");
    el("vp-bio").textContent = u.bio || "Belum ada bio.";
    show("view-profile");
  } catch (e) { toast("❌ Gagal memuat profil: " + e.message); }
}

// ─── Group Chat ───────────────────────────────────────────────────

let currentGroupId   = null;
let currentGroupData = null;
let groupMsgUnsub    = null;

function chatIdForGroup(groupId) { return "group_" + groupId; }

async function showCreateGroup() {
  // Load contacts to pick members
  try {
    const snap = await getDocs(collection(db, "contacts", currentUser.uid, "list"));
    const contacts = snap.docs.map(d => d.data());

    // Fetch photoURL for each contact from users collection
    const contactsWithPhoto = await Promise.all(contacts.map(async c => {
      if (c.photoURL) return c;
      try {
        const uSnap = await getDoc(doc(db, "users", c.uid));
        return uSnap.exists() ? { ...c, photoURL: uSnap.data().photoURL || "" } : c;
      } catch { return c; }
    }));

    el("cg-members-list").innerHTML = contactsWithPhoto.length === 0
      ? `<div class="empty" style="padding:20px 0"><div class="empty__icon">👥</div><div class="empty__desc">Belum ada kontak untuk ditambahkan.</div></div>`
      : contactsWithPhoto.map(c => {
          const avatarHtml = c.photoURL
            ? `<img src="${esc(c.photoURL)}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;" />`
            : `<div class="cg-member-avatar">${(c.displayName||c.username||"?")[0].toUpperCase()}</div>`;
          return `
          <label class="cg-member-item">
            <input type="checkbox" class="cg-member-cb" value="${esc(c.uid)}" data-name="${esc(c.displayName || c.username)}" data-username="${esc(c.username)}" />
            ${avatarHtml}
            <div class="cg-member-info">
              <div class="cg-member-name">${esc(c.displayName || c.username)}</div>
              <div class="cg-member-user">@${esc(c.username)}</div>
            </div>
          </label>`;
        }).join("");

    el("cg-name").value = "";
    el("cg-photo-preview").innerHTML = `<span style="font-size:28px">📷</span>`;
    el("cg-selected-count").textContent = "0 dipilih";
    show("create-group");
  } catch (e) { toast("❌ Gagal memuat kontak: " + e.message); }
}

async function openGroupRoom(groupId) {
  try {
    const snap = await getDoc(doc(db, "groups", groupId));
    if (!snap.exists()) { toast("Grup tidak ditemukan."); return; }
    currentGroupId   = groupId;
    currentGroupData = { id: groupId, ...snap.data() };

    el("gr-name").textContent = currentGroupData.name || "Grup";
    const photo = currentGroupData.photoURL || "";
    el("gr-avatar").innerHTML = photo
      ? `<img src="${esc(photo)}" class="gr-avatar-img" />`
      : `<div class="gr-avatar-letter">${(currentGroupData.name||"G")[0].toUpperCase()}</div>`;
    el("gr-member-count").textContent = (currentGroupData.members?.length || 0) + " anggota";
    el("gr-chat-input").value = "";
    show("group-room");
    el("gr-log").innerHTML = `<div class="loading-text">Memuat pesan…</div>`;

    if (groupMsgUnsub) { groupMsgUnsub(); groupMsgUnsub = null; }
    groupMsgUnsub = onSnapshot(
      query(collection(db, "groups", groupId, "messages"), orderBy("createdAt"), limit(300)),
      (snap) => renderGroupMessages(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      (err) => { el("gr-log").innerHTML = `<div class="empty"><div class="empty__icon">⚠️</div><div class="empty__desc">${esc(err.message)}</div></div>`; }
    );
  } catch (e) { toast("❌ " + e.message); }
}

function renderGroupMessages(list) {
  const log = el("gr-log");
  const visible = list.filter(m => {
    if (m.deletedForAll) return true;
    if (m.deletedFor && m.deletedFor.includes(currentUser.uid)) return false;
    return true;
  });

  if (!visible.length) {
    log.innerHTML = `<div class="empty"><div class="empty__icon">👋</div><div class="empty__title">Mulai obrolan grup</div><div class="empty__desc">Kirim pesan pertama!</div></div>`;
    return;
  }
  log.innerHTML = visible.map(m => {
    if (m.deletedForAll) return `<div class="bubble bubble--deleted"><div class="msg-text msg-text--deleted">🚫 Pesan ini telah dihapus</div></div>`;
    const mine = m.from === currentUser.uid;
    const time = fmtTime(m.createdAt);
    let body = "";
    if (m.type === "image") body = `<img src="${esc(m.url)}" class="msg-media" alt="foto" />`;
    else if (m.type === "audio") body = `<audio src="${esc(m.url)}" controls class="msg-audio"></audio>`;
    else body = `<div class="msg-text">${esc(m.text || "")}</div>`;
    const sender = !mine ? `<div class="bubble__sender">${esc(m.fromName || "?")}</div>` : "";
    return `<div class="bubble ${mine ? "bubble--me" : ""}" data-msg-id="${esc(m.id)}" data-msg-from="${esc(m.from)}">
      ${sender}${body}
      <div class="bubble__footer"><div class="bubble__time">${esc(time)}</div></div>
    </div>`;
  }).filter(Boolean).join("");
  log.scrollTop = log.scrollHeight;

  // Long-press delete on group messages (only for own messages or admin)
  log.querySelectorAll(".bubble[data-msg-id]").forEach(bubble => {
    let timer = null;
    const tryMenu = (e) => {
      e.preventDefault();
      const from = bubble.dataset.msgFrom;
      if (from !== currentUser.uid) return; // only own msgs
      const msgId = bubble.dataset.msgId;
      showGroupDeleteMenu(msgId, bubble);
    };
    bubble.addEventListener("touchstart", () => { timer = setTimeout(() => tryMenu(event), 500); }, { passive: true });
    bubble.addEventListener("touchend", () => clearTimeout(timer));
    bubble.addEventListener("touchmove", () => clearTimeout(timer));
    bubble.addEventListener("contextmenu", tryMenu);
  });
}

function showGroupDeleteMenu(msgId, bubbleEl) {
  const old = document.getElementById("gr-delete-menu");
  if (old) old.remove();
  const menu = document.createElement("div");
  menu.id = "gr-delete-menu";
  menu.className = "delete-menu";
  const rect = bubbleEl.getBoundingClientRect();
  const logRect = el("gr-log").getBoundingClientRect();
  menu.style.top   = (rect.top - logRect.top + el("gr-log").scrollTop) + "px";
  menu.style.right = "8px";
  menu.innerHTML = `
    <button class="delete-menu__item" data-a="me">🗑️ Hapus untuk saya</button>
    <button class="delete-menu__item delete-menu__item--danger" data-a="all">🗑️ Hapus untuk semua</button>
    <button class="delete-menu__item delete-menu__item--cancel" data-a="cancel">Batal</button>`;
  el("gr-log").style.position = "relative";
  el("gr-log").appendChild(menu);

  menu.querySelector("[data-a='cancel']").addEventListener("click", () => menu.remove());
  menu.querySelector("[data-a='me']").addEventListener("click", async () => {
    menu.remove();
    await updateDoc(doc(db, "groups", currentGroupId, "messages", msgId), { deletedFor: arrayUnion(currentUser.uid) }).catch(e => toast("❌ " + e.message));
  });
  menu.querySelector("[data-a='all']").addEventListener("click", async () => {
    if (!confirm("Hapus untuk semua?")) return;
    menu.remove();
    await updateDoc(doc(db, "groups", currentGroupId, "messages", msgId), { deletedForAll: true, text: null, url: null }).catch(e => toast("❌ " + e.message));
  });
  setTimeout(() => {
    document.addEventListener("click", function h(e) { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("click", h); } });
  }, 100);
}

async function sendGroupMessage(type, payload) {
  if (!currentGroupId) return;
  const msg = {
    from:     currentUser.uid,
    fromName: currentUser.displayName || "?",
    type,
    createdAt: serverTimestamp(),
  };
  if (type === "text") msg.text = payload; else msg.url = payload;
  await addDoc(collection(db, "groups", currentGroupId, "messages"), msg);
  await updateDoc(doc(db, "groups", currentGroupId), {
    lastMessage: type === "image" ? "📷 Foto" : type === "audio" ? "🎤 Voice note" : payload,
    lastFrom: currentUser.uid,
    updatedAt: serverTimestamp(),
  });
}

async function showGroupInfo() {
  if (!currentGroupId || !currentGroupData) return;
  try {
    // Re-fetch fresh data
    const snap = await getDoc(doc(db, "groups", currentGroupId));
    currentGroupData = { id: currentGroupId, ...snap.data() };
    renderGroupInfoPanel();
    show("group-info");
  } catch (e) { toast("❌ " + e.message); }
}

async function renderGroupInfoPanel() {
  const g = currentGroupData;
  const isAdmin = (g.admins || []).includes(currentUser.uid);
  const photo = g.photoURL || "";

  el("gi-photo").innerHTML = photo
    ? `<img src="${esc(photo)}" class="gi-photo-img" />`
    : `<div class="gi-photo-placeholder">${(g.name||"G")[0].toUpperCase()}</div>`;

  el("gi-name").textContent  = g.name || "Grup";
  el("gi-count").textContent = (g.members?.length || 0) + " anggota";

  // Change group photo (admin only)
  const editPhotoBtn = el("gi-edit-photo");
  if (editPhotoBtn) editPhotoBtn.style.display = isAdmin ? "flex" : "none";

  // Members list
  const memberSnaps = await Promise.all((g.members || []).map(uid => getDoc(doc(db, "users", uid)).catch(() => null)));
  const memberDatas = memberSnaps.map((s, i) => s?.exists() ? s.data() : { uid: g.members[i], displayName: "?", username: "?" });

  el("gi-members").innerHTML = memberDatas.map(u => {
    const isAdm = (g.admins || []).includes(u.uid);
    const isMe  = u.uid === currentUser.uid;
    return `<div class="gi-member">
      <div class="gi-member-avatar">${(u.displayName||u.username||"?")[0].toUpperCase()}</div>
      <div class="gi-member-info">
        <div class="gi-member-name">${esc(u.displayName || u.username)}</div>
        <div class="gi-member-role">${isAdm ? "👑 Admin" : "Anggota"}${isMe ? " · Kamu" : ""}</div>
      </div>
      ${isAdmin && !isMe ? `
        <div class="gi-member-actions">
          ${!isAdm ? `<button class="btn btn--sm btn--secondary" data-make-admin="${esc(u.uid)}" title="Jadikan Admin">👑</button>` : ""}
          <button class="btn btn--sm btn--danger" data-kick="${esc(u.uid)}" data-kname="${esc(u.displayName||u.username)}" title="Keluarkan">✕</button>
        </div>` : ""}
    </div>`;
  }).join("");

  el("gi-members").querySelectorAll("[data-kick]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const uid = btn.dataset.kick;
      const name = btn.dataset.kname;
      if (!confirm(`Keluarkan ${name} dari grup?`)) return;
      btn.disabled = true;
      try {
        const newMembers = (currentGroupData.members || []).filter(u => u !== uid);
        const newAdmins  = (currentGroupData.admins  || []).filter(u => u !== uid);
        await updateDoc(doc(db, "groups", currentGroupId), { members: newMembers, admins: newAdmins });
        const fresh = await getDoc(doc(db, "groups", currentGroupId));
        currentGroupData = { id: currentGroupId, ...fresh.data() };
        renderGroupInfoPanel();
        toast("✅ " + name + " dikeluarkan.");
        // Update header member count
        el("gr-member-count").textContent = newMembers.length + " anggota";
      } catch (e) { toast("❌ " + e.message); btn.disabled = false; }
    });
  });

  el("gi-members").querySelectorAll("[data-make-admin]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const uid = btn.dataset.makeAdmin;
      btn.disabled = true;
      try {
        await updateDoc(doc(db, "groups", currentGroupId), { admins: arrayUnion(uid) });
        const fresh = await getDoc(doc(db, "groups", currentGroupId));
        currentGroupData = { id: currentGroupId, ...fresh.data() };
        renderGroupInfoPanel();
        toast("✅ Admin baru ditambahkan.");
      } catch (e) { toast("❌ " + e.message); btn.disabled = false; }
    });
  });
}

function initNav() {
  document.querySelectorAll(".bottom-nav button[data-tab]").forEach(btn =>
    btn.addEventListener("click", () => setTab(btn.dataset.tab))
  );
  el("btn-new-chat")?.addEventListener("click",  () => show("new-chat"));
  el("new-chat-back")?.addEventListener("click", () => show("home"));
  el("chatroom-back")?.addEventListener("click", () => {
    if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
    if (isRecording) stopRecording();
    show("home");
  });

  // Chat room three-dot menu → view peer profile
  el("chatroom-more")?.addEventListener("click", () => {
    if (currentChatPeer?.uid) showUserProfile(currentChatPeer.uid);
  });

  // View profile back
  el("vp-back")?.addEventListener("click", () => show("chat-room"));

  // Group room back
  el("gr-back")?.addEventListener("click", () => {
    if (groupMsgUnsub) { groupMsgUnsub(); groupMsgUnsub = null; }
    currentGroupId = null; currentGroupData = null;
    show("home");
  });

  // Group info button
  el("gr-info-btn")?.addEventListener("click", () => showGroupInfo());
  el("gi-back")?.addEventListener("click", () => show("group-room"));

  // Group info: change photo
  el("gi-change-photo-btn")?.addEventListener("click", () => el("gi-photo-input")?.click());
  el("gi-photo-input")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    toast("📷 Mengupload foto grup…", 5000);
    try {
      let dataUrl = await compressImage(file, 400, 0.82);
      if (dataUrl.length > 300000) dataUrl = await compressImage(file, 260, 0.7);
      if (dataUrl.length > 300000) { toast("❌ Foto terlalu besar."); return; }
      await updateDoc(doc(db, "groups", currentGroupId), { photoURL: dataUrl });
      const fresh = await getDoc(doc(db, "groups", currentGroupId));
      currentGroupData = { id: currentGroupId, ...fresh.data() };
      renderGroupInfoPanel();
      // Also update header
      el("gr-avatar").innerHTML = `<img src="${esc(dataUrl)}" class="gr-avatar-img" />`;
      toast("✅ Foto grup diperbarui!");
    } catch (err) { toast("❌ " + err.message); }
    e.target.value = "";
  });

  // Create group back
  el("cg-back")?.addEventListener("click", () => show("home"));

  // Create group: photo picker
  el("cg-photo-btn")?.addEventListener("click", () => el("cg-photo-input")?.click());
  el("cg-photo-input")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      let dataUrl = await compressImage(file, 400, 0.82);
      if (dataUrl.length > 300000) dataUrl = await compressImage(file, 260, 0.7);
      el("cg-photo-preview").innerHTML = `<img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`;
      el("cg-photo-input").dataset.dataUrl = dataUrl;
    } catch { toast("❌ Gagal memuat foto."); }
    e.target.value = "";
  });

  // Member checkbox count
  el("cg-members-list")?.addEventListener("change", () => {
    const count = el("cg-members-list").querySelectorAll(".cg-member-cb:checked").length;
    el("cg-selected-count").textContent = count + " dipilih";
  });

  // Create group submit
  el("cg-submit")?.addEventListener("click", async () => {
    const name = el("cg-name").value.trim();
    if (!name) { toast("❌ Nama grup wajib diisi."); return; }
    const checked = [...el("cg-members-list").querySelectorAll(".cg-member-cb:checked")];
    if (!checked.length) { toast("❌ Pilih minimal 1 anggota."); return; }

    const memberUids = [currentUser.uid, ...checked.map(c => c.value)];
    const memberNames = {
      [currentUser.uid]: currentUser.displayName || "—",
      ...Object.fromEntries(checked.map(c => [c.value, c.dataset.name])),
    };

    const btn = el("cg-submit");
    btn.disabled = true; btn.textContent = "⏳ Membuat…";
    try {
      const photoDataUrl = el("cg-photo-input").dataset.dataUrl || "";
      const groupRef = await addDoc(collection(db, "groups"), {
        name,
        photoURL:    photoDataUrl,
        members:     memberUids,
        memberNames,
        admins:      [currentUser.uid],
        createdBy:   currentUser.uid,
        createdAt:   serverTimestamp(),
        updatedAt:   serverTimestamp(),
        lastMessage: "",
        type:        "group",
      });
      toast("✅ Grup \"" + name + "\" berhasil dibuat!");
      show("home");
      setTab("chats");
      openGroupRoom(groupRef.id);
    } catch (e) {
      toast("❌ Gagal buat grup: " + e.message);
      btn.disabled = false; btn.textContent = "Buat Grup";
    }
  });

  // Group room send message
  el("gr-send")?.addEventListener("click", () => {
    const input = el("gr-chat-input");
    const msg = input.value.trim();
    if (!msg) return;
    input.value = "";
    sendGroupMessage("text", msg).catch(err => toast("❌ " + err.message));
  });
  el("gr-chat-input")?.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); el("gr-send").click(); }
  });
  el("gr-attach-btn")?.addEventListener("click", () => el("gr-attach-input")?.click());
  el("gr-attach-input")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    toast("📷 Mengirim foto…", 5000);
    try {
      let dataUrl = await compressImage(file, 1280, 0.72);
      if (dataUrl.length > 700000) dataUrl = await compressImage(file, 800, 0.55);
      if (dataUrl.length > 700000) { toast("❌ Foto terlalu besar."); return; }
      await sendGroupMessage("image", dataUrl);
    } catch (err) { toast("❌ " + err.message); }
    e.target.value = "";
  });
}

// ─── Boot ───────────────────────────────────────────────────────────
function main() {
  setTheme(currentTheme);

  initNav();
  initAuth();
  initNewChat();
  initChatRoom();

  let splashDone   = false;
  let resolvedUser = undefined;

  onAuthStateChanged(auth, (user) => {
    resolvedUser = user;
    if (authTransitionInProgress) return; // performLogin/performRegister sedang menangani manual

    const newUid     = user?.uid || null;
    const uidChanged = newUid !== lastUid;
    currentUser = user;

    if (uidChanged) {
      // Akun berubah (logout, atau ganti akun langsung tanpa lewat performLogin/Register)
      // → pastikan listener akun lama bersih sebelum lanjut.
      stopIncomingRequestsListener();
      clearHomeTabListeners();
      if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
    }
    lastUid = newUid;

    if (user) startIncomingRequestsListener();

    if (splashDone) {
      if (user) { show("home"); setTab("chats"); }
      else        show("auth");
    }
  });

  // Tampilkan splash "XGRAM" dulu selama 3 detik, baru pindah ke auth/home
  // sesuai status login yang sudah didapat dari Firebase di waktu itu.
  show("splash");
  setTimeout(() => {
    splashDone = true;
    if (resolvedUser) { show("home"); setTab("chats"); }
    else                show("auth");
  }, 3000);
}

main();