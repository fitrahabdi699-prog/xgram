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
//     match /users/{uid} {
//       allow read: if request.auth != null;
//       // Pemilik akun selalu boleh menulis akunnya sendiri. Akun
//       // @ADMINXGRAMREAL juga boleh menulis ke akun siapa pun — dibutuhkan
//       // untuk fitur admin !block / !unblock (field `blocked`).
//       allow write: if request.auth.uid == uid ||
//         get(/databases/$(database)/documents/users/$(request.auth.uid)).data.usernameLower == "adminxgramreal";
//     }
//     match /usernames/{name}    { allow read: if request.auth != null; allow write: if request.auth != null; }
//
//     // Pemberitahuan admin (!pemberitahuan) & notifikasi unblock otomatis.
//     // Pemiliknya boleh baca & update (untuk menutup/dismiss notifikasi);
//     // akun @ADMINXGRAMREAL boleh create notice baru DAN update (dismiss) notice
//     // milik user lain — dibutuhkan saat !unblock untuk dismiss notice block.
//     match /notices/{uid}/items/{itemId} {
//       allow read, update: if request.auth.uid == uid;
//       allow create, update: if request.auth != null &&
//         get(/databases/$(database)/documents/users/$(request.auth.uid)).data.usernameLower == "adminxgramreal";
//     }
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
//
//     // WebRTC signaling (1-1 calls)
//     match /calls/{callId} { allow read, write: if request.auth != null; }
//     match /calls/{callId}/callerCandidates/{id} { allow read, write: if request.auth != null; }
//     match /calls/{callId}/calleeCandidates/{id} { allow read, write: if request.auth != null; }
//   }
// }
//

// ─── Helpers ─────────────────────────────────────────────────────
const el  = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");

// ─── Verified Badge ──────────────────────────────────────────────
// Hanya akun @ADMINXGRAMREAL yang mendapat centang hijau resmi.
const VERIFIED_USERNAMES = ["adminxgramreal"]; // HANYA akun resmi @ADMINXGRAMREAL

function isVerified(username) {
  // Cek baik username maupun displayName (keduanya bisa di-pass)
  const val = String(username || "").toLowerCase().replace(/^@/, "").trim();
  return VERIFIED_USERNAMES.includes(val);
}

// Kembalikan HTML badge SVG centang hijau (inline, bisa dipakai di innerHTML).
// Klik badge akan memunculkan tooltip "Real Admin & Official".
function verifiedBadge(username) {
  if (!isVerified(username)) return "";
  return `<span class="verified-badge" title="Real Admin &amp; Official Xgram" role="img" aria-label="Akun Terverifikasi" onclick="event.stopPropagation();document.dispatchEvent(new CustomEvent('show-verified-tip'))">` +
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">` +
    `<circle cx="12" cy="12" r="12" fill="#10b981"/>` +
    `<path d="M6.5 12.5l3.5 3.5 7.5-7.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg></span>`;
}

// Pasang listener global untuk tooltip popup verified
(function initVerifiedTooltip() {
  let tip = null;
  document.addEventListener("show-verified-tip", () => {
    if (tip) { tip.remove(); tip = null; return; }
    tip = document.createElement("div");
    tip.className = "verified-tooltip";
    tip.innerHTML =
      `<div class="vt-inner">` +
        `<div class="vt-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill="#10b981"/><path d="M6.5 12.5l3.5 3.5 7.5-7.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>` +
        `<div class="vt-text">` +
          `<div class="vt-title">Real Admin &amp; Official</div>` +
          `<div class="vt-desc">Akun ini adalah admin resmi dan satu-satunya akun official Xgram yang terverifikasi.</div>` +
        `</div>` +
      `</div>`;
    document.body.appendChild(tip);
    requestAnimationFrame(() => tip && tip.classList.add("vt-show"));
    const close = (e) => {
      if (tip && !tip.contains(e.target)) { tip.classList.remove("vt-show"); setTimeout(() => { tip && tip.remove(); tip = null; }, 220); document.removeEventListener("click", close, true); }
    };
    setTimeout(() => document.addEventListener("click", close, true), 10);
  });
})();


// ─── Admin Bot Commands (khusus akun @ADMINXGRAMREAL) ──────────────
// Catatan: hanya akun dengan displayName/username "adminxgramreal" yang
// bisa menjalankan perintah-perintah ini. Perintah dikirim sebagai pesan
// teks biasa yang diawali tanda "!" di dalam ruang chat manapun.
const ADMIN_USERNAME = "adminxgramreal";

// ─── CHATBOTXGRAM — kontak virtual khusus admin ──────────────────────
// Hanya muncul di riwayat chat akun @ADMINXGRAMREAL.
// Tidak bisa di-block/unblock/pemberitahuan. Centang hijau "Official Bot".
const CHATBOT_ID       = "__CHATBOTXGRAM__"; // ID virtual (bukan UID Firestore)
const CHATBOT_USERNAME = "CHATBOTXGRAM";
const CHATBOT_NAME     = "CHATBOTXGRAM";

function isChatbotPeer(peer) {
  return peer && (peer.uid === CHATBOT_ID || peer.username === CHATBOT_USERNAME);
}

// Badge centang hijau khusus CHATBOTXGRAM — label "Official Bot Khusus Admin"
function chatbotBadge() {
  return `<span class="verified-badge chatbot-badge" title="Official Bot · Hanya tersedia di akun Admin Xgram" role="img" aria-label="Official Bot Admin" onclick="event.stopPropagation();document.dispatchEvent(new CustomEvent('show-chatbot-tip'))">` +
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">` +
    `<circle cx="12" cy="12" r="12" fill="#10b981"/>` +
    `<path d="M6.5 12.5l3.5 3.5 7.5-7.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg></span>`;
}

// Tooltip khusus CHATBOTXGRAM
(function initChatbotTooltip() {
  let tip = null;
  document.addEventListener("show-chatbot-tip", () => {
    if (tip) { tip.remove(); tip = null; return; }
    tip = document.createElement("div");
    tip.className = "verified-tooltip";
    tip.innerHTML =
      `<div class="vt-inner">` +
        `<div class="vt-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill="#10b981"/><path d="M6.5 12.5l3.5 3.5 7.5-7.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>` +
        `<div class="vt-text">` +
          `<div class="vt-title">Official Bot · Khusus Admin</div>` +
          `<div class="vt-desc">CHATBOTXGRAM adalah bot resmi yang hanya tersedia di akun @ADMINXGRAMREAL. User lain tidak dapat menemukan atau mengakses bot ini.</div>` +
        `</div>` +
      `</div>`;
    document.body.appendChild(tip);
    requestAnimationFrame(() => tip && tip.classList.add("vt-show"));
    const close = (e) => {
      if (tip && !tip.contains(e.target)) { tip.classList.remove("vt-show"); setTimeout(() => { tip && tip.remove(); tip = null; }, 220); document.removeEventListener("click", close, true); }
    };
    setTimeout(() => document.addEventListener("click", close, true), 10);
  });
})();

// Render chat room CHATBOTXGRAM (lokal, tidak ada Firestore)
let chatbotMessages = []; // pesan sesi chatbot (hanya selama sesi berlangsung)
let isChatbotRoom   = false;

function openChatbotRoom() {
  if (!isAdminUser()) return;
  isChatbotRoom = true;
  currentChatPeer = { uid: CHATBOT_ID, username: CHATBOT_USERNAME, displayName: CHATBOT_NAME };
  currentChatId   = null; // tidak ada chatId Firestore

  el("chatroom-username").innerHTML = esc(CHATBOT_NAME) + chatbotBadge();
  el("chatroom-status").innerHTML   = `<span class="status-dot status-dot--green"></span>Official Bot · Admin Only`;

  const peerAvatarEl = el("chatroom-peer-avatar");
  if (peerAvatarEl) {
    peerAvatarEl.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><circle cx="12" cy="8" r="3"/><path d="M6 20v-1a6 6 0 0 1 12 0v1"/><circle cx="12" cy="12" r="10" stroke="#10b981" stroke-width="1.5" fill="none"/></svg>`;
  }

  el("chat-input").value = "";
  if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
  show("chat-room");
  renderChatbotMessages();

  // Sambutan awal hanya sekali per sesi
  if (!chatbotMessages.length) {
    addChatbotMessage("bot",
      `👋 Halo Admin! Saya CHATBOTXGRAM, bot resmi khusus akun @ADMINXGRAMREAL.\n\n` +
      `Kamu bisa langsung ketik perintah tanpa perlu !menu dulu:\n\n` +
      `• !block <username> — Blokir akun\n` +
      `• !unblock <username> — Buka blokir akun\n` +
      `• !pemberitahuan <username> <pesan> — Kirim pemberitahuan\n` +
      `• !menu — Tampilkan semua perintah`
    );
  }
}

function addChatbotMessage(side, text) {
  chatbotMessages.push({ side, text, time: new Date() });
  renderChatbotMessages();
}

function renderChatbotMessages() {
  const log = el("chat-log");
  if (!log || !isChatbotRoom) return;

  if (!chatbotMessages.length) {
    log.innerHTML = `<div class="empty"><div class="empty__icon">🤖</div><div class="empty__title">CHATBOTXGRAM siap</div><div class="empty__desc">Ketik perintah admin untuk memulai.</div></div>`;
    return;
  }

  log.innerHTML = chatbotMessages.map(m => {
    const timeStr = m.time.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
    if (m.side === "bot") {
      return `<div class="msg-row--bot">
        <div class="msg-bubble--bot">
          <div class="msg-bubble__bot-label">🤖 CHATBOTXGRAM</div>
          <div class="msg-text">${esc(m.text).replace(/\n/g, "<br>")}</div>
          <div class="bubble__time">${esc(timeStr)}</div>
        </div>
      </div>`;
    } else {
      return `<div class="bubble bubble--me">
        <div class="msg-text">${esc(m.text)}</div>
        <div class="bubble__footer"><div class="bubble__time">${esc(timeStr)}</div></div>
      </div>`;
    }
  }).join("");
  log.scrollTop = log.scrollHeight;
}

// Handle pesan di chatbot room — intercept sebelum sendChatMessage biasa
async function handleChatbotInput(rawText) {
  if (!isChatbotRoom) return false;
  const text = String(rawText || "").trim();
  if (!text) return true; // tetap consume input

  // Tampilkan pesan admin sebagai bubble kanan
  addChatbotMessage("me", text);

  if (text.startsWith("!")) {
    // Jalankan perintah admin
    const firstSpace = text.indexOf(" ");
    const cmd  = (firstSpace === -1 ? text : text.slice(0, firstSpace)).toLowerCase();
    const rest = (firstSpace === -1 ? "" : text.slice(firstSpace + 1)).trim();

    try {
      if (cmd === "!menu") {
        addChatbotMessage("bot", ADMIN_MENU_TEXT);
      } else if (cmd === "!block") {
        addChatbotMessage("bot", await adminBlockUser(rest));
      } else if (cmd === "!unblock") {
        addChatbotMessage("bot", await adminUnblockUser(rest));
      } else if (cmd === "!pemberitahuan") {
        const sp = rest.indexOf(" ");
        if (sp === -1) throw new Error("Format salah. Gunakan: !pemberitahuan <username> <pesan>");
        addChatbotMessage("bot", await adminSendPemberitahuan(rest.slice(0, sp), rest.slice(sp + 1).trim()));
      } else {
        addChatbotMessage("bot", "❓ Perintah tidak dikenal. Ketik !menu untuk melihat daftar perintah.");
      }
    } catch (err) {
      addChatbotMessage("bot", "❌ " + (err?.message || "Terjadi kesalahan."));
    }
  } else {
    addChatbotMessage("bot",
      "ℹ️ Saya hanya memahami perintah admin yang diawali \"!\"\n" +
      "Contoh: !block namauser\n\nKetik !menu untuk daftar lengkap perintah.");
  }
  return true;
}


function isAdminUser() {
  return !!currentUser && String(currentUser.displayName || "").toLowerCase() === ADMIN_USERNAME;
}

const ADMIN_MENU_TEXT =
`📋 MENU ADMIN XGRAM

1️⃣ !block <username>
   Memblokir & men-suspend akun pengguna. Akun yang terkena
   block tidak bisa lagi memakai Xgram sampai di-unblock.

2️⃣ !unblock <username>
   Membuka blokir akun yang sebelumnya di-block.

3️⃣ !pemberitahuan <username> <pesan>
   Mengirim pemberitahuan resmi ke akun pengguna tertentu.

Ketik salah satu perintah di atas untuk menjalankannya.`;

// Tampilkan balasan "bot" di dalam jendela chat yang sedang dibuka admin.
// Catatan: ini hanya tampilan lokal/sementara (tidak disimpan ke Firestore)
// supaya terasa seperti chat bot membalas, dan akan hilang saat pesan asli
// di-render ulang oleh listener — itu wajar dan tidak masalah.
function botReply(text) {
  const log = el("chat-log") || el("gr-chat-log");
  if (!log) { toast(text); return; }
  const div = document.createElement("div");
  div.className = "msg-row--bot";
  div.innerHTML =
    `<div class="msg-bubble--bot">` +
      `<div class="msg-bubble__bot-label">🤖 Xgram Bot</div>` +
      `<div class="msg-text">${esc(text).replace(/\n/g, "<br>")}</div>` +
    `</div>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// Tulis 1 dokumen pemberitahuan ke notices/{uid}/items/{auto}
async function addNotice(uid, kind, text) {
  return await addDoc(collection(db, "notices", uid, "items"), {
    kind, text, createdAt: serverTimestamp(), dismissed: false,
  });
}

function stripAt(usernameRaw) {
  return String(usernameRaw || "").replace(/^@/, "").trim();
}

async function adminBlockUser(usernameRaw) {
  const uname = stripAt(usernameRaw);
  if (!uname) throw new Error("Format salah. Gunakan: !block <username>");
  if (uname.toLowerCase() === ADMIN_USERNAME) throw new Error("Tidak bisa memblokir akun admin sendiri.");
  if (uname.toLowerCase() === CHATBOT_USERNAME.toLowerCase()) throw new Error("CHATBOTXGRAM adalah bot resmi dan tidak bisa diblokir.");
  const user = await findUserByUsername(uname);
  if (!user || !user.uid) throw new Error(`Pengguna @${uname} tidak ditemukan.`);
  if (user.blocked) throw new Error(`Akun @${uname} sudah dalam status di-block.`);

  // Kirim notice block dan simpan ID-nya di dokumen user
  // supaya saat unblock bisa dismiss langsung tanpa perlu baca koleksi notices
  const noticeRef = await addNotice(user.uid, "block",
    "🚫 Akun Anda telah disuspend oleh Admin Xgram karena melanggar ketentuan layanan. " +
    "Jika Anda merasa ini kesalahan, hubungi @ADMINXGRAMREAL.");

  await setDoc(doc(db, "users", user.uid), {
    blocked: true,
    blockedAt: serverTimestamp(),
    blockNoticeId: noticeRef.id,   // simpan ID notice supaya unblock bisa dismiss langsung
  }, { merge: true });

  return `🚫 Akun @${uname} berhasil di-BLOCK. Pemberitahuan telah dikirim ke akun tersebut.`;
}

async function adminUnblockUser(usernameRaw) {
  const uname = stripAt(usernameRaw);
  if (!uname) throw new Error("Format salah. Gunakan: !unblock <username>");
  if (uname.toLowerCase() === CHATBOT_USERNAME.toLowerCase()) throw new Error("CHATBOTXGRAM adalah bot resmi dan tidak perlu di-unblock.");
  const user = await findUserByUsername(uname);
  if (!user || !user.uid) throw new Error(`Pengguna @${uname} tidak ditemukan.`);
  if (!user.blocked) throw new Error(`Akun @${uname} belum di-block, tidak bisa di-unblock.`);

  // Dismiss notice block pakai ID yang disimpan saat block — tidak perlu baca
  // koleksi notices milik user lain (Firestore rules tidak mengizinkan admin baca itu).
  if (user.blockNoticeId) {
    try {
      await setDoc(
        doc(db, "notices", user.uid, "items", user.blockNoticeId),
        { dismissed: true }, { merge: true }
      );
    } catch (e) { console.warn("Gagal dismiss block notice:", e); }
  }

  await setDoc(doc(db, "users", user.uid), {
    blocked: false,
    unblockedAt: serverTimestamp(),
    blockNoticeId: null,   // hapus referensi notice lama
  }, { merge: true });

  await addNotice(user.uid, "unblock", "🔓 Akun Anda telah ter-unsuspend. Anda dapat menggunakan Xgram secara normal kembali.");
  return `✅ Akun @${uname} berhasil di-UNBLOCK.`;
}

async function adminSendPemberitahuan(usernameRaw, text) {
  const uname = stripAt(usernameRaw);
  if (!uname || !text) throw new Error("Format salah. Gunakan: !pemberitahuan <username> <pesan>");
  if (uname.toLowerCase() === CHATBOT_USERNAME.toLowerCase()) throw new Error("CHATBOTXGRAM adalah bot resmi dan tidak bisa menerima pemberitahuan.");
  const user = await findUserByUsername(uname);
  if (!user || !user.uid) throw new Error(`Pengguna @${uname} tidak ditemukan.`);
  await addNotice(user.uid, "broadcast", text);
  return `✅ Pemberitahuan terkirim ke @${uname}.`;
}

// Parser utama. Mengembalikan true kalau teks yang dikirim adalah perintah
// admin (sehingga TIDAK dikirim sebagai pesan chat biasa).
async function tryAdminCommand(rawText) {
  const text = String(rawText || "").trim();
  if (!text.startsWith("!")) return false;
  if (!isAdminUser()) return false; // bukan admin → biarkan terkirim sebagai pesan biasa

  const firstSpace = text.indexOf(" ");
  const cmd  = (firstSpace === -1 ? text : text.slice(0, firstSpace)).toLowerCase();
  const rest = (firstSpace === -1 ? "" : text.slice(firstSpace + 1)).trim();

  try {
    if (cmd === "!menu") {
      botReply(ADMIN_MENU_TEXT);
    } else if (cmd === "!block") {
      botReply(await adminBlockUser(rest));
    } else if (cmd === "!unblock") {
      botReply(await adminUnblockUser(rest));
    } else if (cmd === "!pemberitahuan") {
      const sp = rest.indexOf(" ");
      if (sp === -1) throw new Error("Format salah. Gunakan: !pemberitahuan <username> <pesan>");
      const uname = rest.slice(0, sp);
      const msgText = rest.slice(sp + 1).trim();
      botReply(await adminSendPemberitahuan(uname, msgText));
    } else {
      botReply("❓ Perintah tidak dikenal. Ketik !menu untuk melihat daftar perintah admin.");
    }
  } catch (err) {
    botReply("❌ " + (err?.message || "Terjadi kesalahan."));
  }
  return true;
}

// ─── Notices: realtime listener pemberitahuan & status unblock ─────
let noticesUnsub = null;
const NOTICE_TTL_MS = 24 * 60 * 60 * 1000; // 24 jam — berlaku untuk SEMUA jenis notice

function startNoticesListener() {
  if (noticesUnsub || !currentUser) return;
  // PENTING: tidak pakai where() sama sekali supaya tidak butuh Firestore index.
  // Filter dismissed dan TTL 24 jam dilakukan di JS (renderNoticeBanners).
  // Query pakai where("dismissed","==",false) sebelumnya butuh composite index
  // yang belum dibuat → snapshot gagal diam-diam → notice tidak pernah muncul.
  noticesUnsub = onSnapshot(
    query(collection(db, "notices", currentUser.uid, "items"), limit(50)),
    (snap) => renderNoticeBanners(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    (err) => console.warn("Notices listener error:", err)
  );
}
function stopNoticesListener() {
  if (noticesUnsub) { noticesUnsub(); noticesUnsub = null; }
  const c = el("notice-banners");
  if (c) { c.innerHTML = ""; c.style.display = "none"; }
}

function renderNoticeBanners(list) {
  const container = el("notice-banners");
  if (!container) return;
  const now = Date.now();

  const visible = list
    .filter((n) => {
      // Sudah di-dismiss → skip
      if (n.dismissed === true) return false;
      // Notice block → tampil permanen (tidak ada TTL, tidak bisa di-X)
      if (n.kind === "block") return true;
      // Notice unblock & broadcast → berlaku maks 24 jam
      const ts = n.createdAt?.toMillis ? n.createdAt.toMillis() : null;
      if (ts == null) return true; // serverTimestamp belum sync → tampil dulu
      if (now - ts > NOTICE_TTL_MS) {
        // Sudah lewat 24 jam → auto-dismiss di Firestore
        setDoc(doc(db, "notices", currentUser.uid, "items", n.id), { dismissed: true }, { merge: true })
          .catch(() => {});
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
      const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
      return tb - ta;
    });

  if (!visible.length) { container.innerHTML = ""; container.style.display = "none"; return; }

  container.style.display = "flex";
  container.innerHTML = visible.map((n) => {
    const kind = n.kind === "unblock" ? "unblock" : n.kind === "block" ? "block" : "broadcast";
    const icon = n.kind === "unblock" ? "🔓" : n.kind === "block" ? "🚫" : "📢";
    // Notice block TIDAK ada tombol X (permanen sampai di-unblock oleh admin)
    const closeBtn = n.kind === "block"
      ? ""
      : `<button class="notice-banner__close" data-id="${esc(n.id)}" title="Tutup" type="button">✕</button>`;
    return `
    <div class="notice-banner notice-banner--${esc(kind)}" data-id="${esc(n.id)}">
      <div class="notice-banner__icon">${icon}</div>
      <div class="notice-banner__text">${esc(n.text)}</div>
      ${closeBtn}
    </div>`;
  }).join("");

  container.querySelectorAll(".notice-banner__close").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      try {
        await setDoc(doc(db, "notices", currentUser.uid, "items", id), { dismissed: true }, { merge: true });
      } catch (e) { console.error("Gagal menutup pemberitahuan:", e); }
    });
  });
}

// ─── Account status: deteksi blocked secara realtime ────────────────
let accountStatusUnsub = null;

function startAccountStatusListener() {
  if (accountStatusUnsub || !currentUser) return;
  accountStatusUnsub = onSnapshot(
    doc(db, "users", currentUser.uid),
    (snap) => {
      const data = snap.exists() ? snap.data() : null;
      if (data?.blocked) showBlockedOverlay(); else hideBlockedOverlay();
    },
    (err) => console.warn("Account status listener error:", err)
  );
}
function stopAccountStatusListener() {
  if (accountStatusUnsub) { accountStatusUnsub(); accountStatusUnsub = null; }
}
function showBlockedOverlay() {
  const ov = el("account-blocked-overlay");
  if (ov) ov.style.display = "flex";
}
function hideBlockedOverlay() {
  const ov = el("account-blocked-overlay");
  if (ov) ov.style.display = "none";
}

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
    hideBlockedOverlay();
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
let recordingTarget = "chat"; // "chat" | "group" — menentukan tombol mic mana yang aktif & tujuan kirim

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
  stopIncomingCallListener();
  stopNoticesListener();
  stopAccountStatusListener();
  clearHomeTabListeners();
  if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
}

// ─── Firestore helpers: users & username index ────────────────────

// UID ADMINXGRAMREAL di-cache saat pertama kali ditemukan supaya bypass
// cek kontak bisa pakai UID (lebih reliable daripada username string match).
let cachedAdminUid = null;

// Otomatis tambah ADMINXGRAMREAL ke kontak user (satu arah).
// Dipanggil saat register dan login. Skip untuk akun ADMINXGRAMREAL sendiri.
// Di sisi admin TIDAK ditambahkan — kontak admin hanya berisi user yang
// memang berteman secara manual (terima friend request dari admin).
async function autoAddAdminContact(user) {
  if (!user || !user.uid) return;
  if (String(user.displayName || "").toLowerCase() === ADMIN_USERNAME) return;

  try {
    const adminData = await findUserByUsername(ADMIN_USERNAME);
    if (!adminData || !adminData.uid) return;

    // Cache UID admin untuk dipakai di cek kontak bypass
    cachedAdminUid = adminData.uid;

    // Sudah ada di kontak → skip
    const existing = await getDoc(doc(db, "contacts", user.uid, "list", adminData.uid));
    if (existing.exists()) return;

    // Tambah admin ke kontak user (satu arah saja)
    await setDoc(doc(db, "contacts", user.uid, "list", adminData.uid), {
      uid:         adminData.uid,
      username:    adminData.username || "ADMINXGRAMREAL",
      displayName: adminData.displayName || "ADMINXGRAMREAL",
      photoURL:    adminData.photoURL || "",
      addedAt:     serverTimestamp(),
    });

    // Buat/unhide chat supaya langsung bisa chat
    const chatId = chatIdFor(user.uid, adminData.uid);
    await setDoc(doc(db, "chats", chatId), {
      members:    [user.uid, adminData.uid],
      memberInfo: {
        [user.uid]:      { username: user.displayName || "", displayName: user.displayName || "", photoURL: "" },
        [adminData.uid]: { username: adminData.username || "ADMINXGRAMREAL", displayName: adminData.displayName || "ADMINXGRAMREAL", photoURL: adminData.photoURL || "" },
      },
      hiddenFor:   [],
      lastMessage: "",
      updatedAt:   serverTimestamp(),
    }, { merge: true });

  } catch (e) {
    console.warn("autoAddAdminContact gagal (non-fatal):", e);
  }
}

// Cek apakah peer adalah ADMINXGRAMREAL — pakai UID (lebih reliable) atau username fallback
function peerIsAdmin(peer) {
  if (!peer) return false;
  if (cachedAdminUid && peer.uid === cachedAdminUid) return true;
  return String(peer.username || "").toLowerCase() === ADMIN_USERNAME;
}

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
  // Cegah user biasa blokir admin
  if (peerIsAdmin({ uid: targetUid })) {
    toast("❌ Kamu tidak bisa memblokir admin.");
    return;
  }
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
    // PENTING: sertakan "members" — kalau dokumen chat belum pernah dibuat
    // (kontak ditambah tapi belum pernah chat), setDoc(merge:true) dianggap
    // Firestore sebagai operasi CREATE, dan rule create butuh field "members".
    // Tanpa ini, operasi gagal silent (ditangkap allSettled) lalu bikin status
    // block/unfriend tidak sinkron.
    setDoc(doc(db, "chats", chatIdFor(currentUser.uid, targetUid)),
      { members: [currentUser.uid, targetUid], hiddenFor: arrayUnion(currentUser.uid, targetUid) }, { merge: true }),
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
  // Cegah user biasa unfriend admin
  if (peerIsAdmin({ uid: targetUid })) {
    toast("❌ Kamu tidak bisa batal ikuti admin.");
    return;
  }
  // Hapus kontak di kedua sisi; TIDAK memblokir — masih bisa minta teman lagi
  // Sembunyikan chat dari daftar kedua sisi
  const results = await Promise.allSettled([
    deleteDoc(doc(db, "contacts", currentUser.uid, "list", targetUid)),
    deleteDoc(doc(db, "contacts", targetUid, "list", currentUser.uid)),
    // PENTING: sertakan "members" — kalau dokumen chat belum pernah dibuat,
    // setDoc(merge:true) dianggap operasi CREATE oleh Firestore, dan rule
    // create butuh field "members" di data yang dikirim. Tanpa ini operasi
    // gagal silent → status pertemanan jadi tidak sinkron antar user.
    setDoc(doc(db, "chats", chatIdFor(currentUser.uid, targetUid)),
      { members: [currentUser.uid, targetUid], hiddenFor: arrayUnion(currentUser.uid) }, { merge: true }),
  ]);
  const failed = results.find(r => r.status === "rejected");
  if (failed) {
    // Jangan biarkan gagal diam-diam — kalau salah satu sisi gagal terhapus,
    // status pertemanan jadi tidak sinkron antara kedua user (sumber bug
    // "cannot read properties of undefined" saat user lain mencari/lihat profil).
    console.error("unfriendUser: salah satu operasi gagal:", failed.reason);
    throw new Error(
      "Batal ikuti tidak sepenuhnya berhasil. Cek konsol untuk detail."
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
    startIncomingCallListener();
    startAccountStatusListener();
    startNoticesListener();
    autoAddAdminContact(cred.user); // ← otomatis tambah ADMINXGRAMREAL ke kontak
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
    startIncomingCallListener();
    startAccountStatusListener();
    startNoticesListener();
    // Cache UID admin & otomatis tambah ke kontak (non-blocking)
    findUserByUsername(ADMIN_USERNAME).then(a => { if (a?.uid) cachedAdminUid = a.uid; }).catch(() => {});
    autoAddAdminContact(cred.user);
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
  // Validasi semua field wajib ada — Firestore tidak boleh menerima nilai undefined
  if (!targetUser || !targetUser.uid) throw new Error("Data user tujuan tidak valid.");
  if (!currentUser || !currentUser.uid) throw new Error("Kamu belum login.");

  const fromUid         = currentUser.uid;
  const toUid           = targetUser.uid;
  const fromUsername    = currentUser.displayName || "";
  const fromDisplayName = currentUser.displayName || "";
  const toUsername      = targetUser.username || "";
  const toDisplayName   = targetUser.displayName || targetUser.username || "";

  if (!fromUid || !toUid) throw new Error("UID pengirim atau penerima tidak ditemukan.");

  await setDoc(doc(db, "friendRequests", reqId(fromUid, toUid)), {
    from:            fromUid,
    to:              toUid,
    fromUsername:    fromUsername,
    fromDisplayName: fromDisplayName,
    toUsername:      toUsername,
    toDisplayName:   toDisplayName,
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

      // Inject CHATBOTXGRAM di bagian paling atas khusus admin
      const showChatbot = isAdminUser();

      if (!allItems.length && !showChatbot) {
        content.innerHTML = `<div class="empty">
          <div class="empty__icon">💬</div>
          <div class="empty__title">Belum ada chat</div>
          <div class="empty__desc">Tap ➕ untuk mulai percakapan baru.</div>
        </div>`;
        return;
      }

      const chatbotHtml = showChatbot ? `
        <div class="list-item chatbot-list-item" id="chatbot-list-entry">
          <div class="avatar chatbot-avatar">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="1.8"><circle cx="12" cy="8" r="3"/><path d="M6 20v-1a6 6 0 0 1 12 0v1"/><circle cx="12" cy="12" r="10" stroke="#10b981" stroke-width="1.5" fill="none"/></svg>
          </div>
          <div class="meta">
            <div class="top">
              <div class="name">${esc(CHATBOT_NAME)}${chatbotBadge()}</div>
              <div class="time" style="color:#10b981;font-size:11px;">Official</div>
            </div>
            <div class="preview" style="color:#10b981;">🤖 Ketik !block, !unblock, !pemberitahuan</div>
          </div>
        </div>` : "";

      if (!allItems.length) {
        content.innerHTML = chatbotHtml + `<div class="empty">
          <div class="empty__icon">💬</div>
          <div class="empty__title">Belum ada chat</div>
          <div class="empty__desc">Tap ➕ untuk mulai percakapan baru.</div>
        </div>`;
        if (showChatbot) {
          content.querySelector("#chatbot-list-entry")?.addEventListener("click", () => openChatbotRoom());
        }
        return;
      }

      content.innerHTML = chatbotHtml + allItems.map(c => {
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
        const nameBadge1 = verifiedBadge(info.username);
        const photo = info.photoURL ? `<img src="${esc(info.photoURL)}" class="avatar-img" />` : `<div class="avatar-placeholder"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg></div>`;
        return `<div class="list-item" data-open-chat="${esc(otherUid)}"
                     data-username="${esc(info.username || "")}"
                     data-name="${esc(name)}">
          <div class="avatar">${photo}</div>
          <div class="meta">
            <div class="top"><div class="name">${esc(name)}${nameBadge1}</div><div class="time">${esc(fmtTime(c.updatedAt))}</div></div>
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
      // Chatbot entry listener
      if (showChatbot) {
        content.querySelector("#chatbot-list-entry")?.addEventListener("click", () => openChatbotRoom());
      }
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
              <div class="top"><div class="name">${esc(c.displayName || c.username)}${verifiedBadge(c.username)}</div></div>
              <div class="preview">@${esc(c.username)}</div>
            </div>
            <div class="req-actions">
              ${peerIsAdmin(c) ? "" : `<button class="btn btn--sm btn--secondary" data-unfriend="${esc(c.uid)}" data-uname="${esc(c.username)}" title="Batal Ikuti">👤✕</button>`}
              ${peerIsAdmin(c) ? "" : `<button class="btn btn--sm btn--danger" data-block="${esc(c.uid)}" data-uname="${esc(c.username)}" title="Blokir">🚫</button>`}
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
      async (snap) => {
        const rawContacts = snap.docs.map(d => d.data());
        // Dokumen kontak tidak menyimpan photoURL saat ditambahkan (acceptFriendRequest),
        // jadi ambil foto profil terbaru langsung dari koleksi users untuk tiap kontak.
        try {
          contactsCache = await Promise.all(rawContacts.map(async c => {
            try {
              const uSnap = await getDoc(doc(db, "users", c.uid));
              return uSnap.exists() ? { ...c, photoURL: uSnap.data().photoURL || "" } : c;
            } catch { return c; }
          }));
        } catch {
          contactsCache = rawContacts; // fallback kalau enrich gagal total
        }
        render();
      },
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
            <div class="profile-page__name">${esc(currentUser.displayName || "—")}${verifiedBadge(currentUser.displayName)}</div>
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
            <div class="settings-row__sub">@${esc(u?.displayName || "—")}${verifiedBadge(u?.displayName)}</div>
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

  // Selalu sync ke foundUserData supaya semua closure & re-render
  // berikutnya punya referensi valid dan tidak stale.
  foundUserData = found;

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
    const isFoundAdmin = peerIsAdmin(found);
    wrap.innerHTML = `
      <div class="sr-btn-group">
        <button id="btn-open-chat" class="btn btn--primary" type="button" style="flex:1;">💬 Buka Chat</button>
        ${isFoundAdmin ? "" : `<button id="btn-unfriend" class="btn btn--secondary" type="button">Batal Ikuti</button>`}
        ${isFoundAdmin ? "" : `<button id="btn-block" class="btn btn--danger" type="button">🚫 Blokir</button>`}
      </div>`;
    el("btn-open-chat").addEventListener("click", () => openChatRoom(found));
    if (!isFoundAdmin) {
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
    }
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
    // Pakai foundUserData yang selalu di-sync di atas fungsi ini
    const target = foundUserData || found;
    if (!target || !target.uid) { toast("Cari user dulu."); return; }
    btn.disabled = true; btn.textContent = "⏳ Mengirim…";
    try {
      await sendFriendRequest(target);
      toast("✅ Permintaan teman terkirim ke " + (target.displayName || target.username) + ". Tunggu dia konfirmasi ya.");
      // Re-render tombol sesuai status terbaru dari Firestore
      const newRel = await getRelationship(target.uid);
      renderSearchResultButton(newRel, target);
    } catch (err) {
      console.error(err); toast("❌ Gagal mengirim: " + err.message);
      btn.disabled = false; btn.textContent = "➕ Tambah Teman";
    }
  });
  el("btn-block-none").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const target = foundUserData || found;
    if (!target || !target.uid) { toast("Cari user dulu."); return; }
    if (!confirm(`Blokir @${target.username}?`)) return;
    btn.disabled = true; btn.textContent = "⏳";
    try {
      await blockUser(target.uid);
      toast("✅ @" + target.username + " diblokir.");
      const newRel = await getRelationship(target.uid);
      renderSearchResultButton(newRel, target);
    } catch (err) { toast("❌ " + err.message); btn.disabled = false; btn.textContent = "🚫 Blokir"; }
  });
}

function initNewChat() {
  const input     = el("search-username");
  const resultBox = el("newchat-result");

  input.addEventListener("input", () => {
    resultBox.style.display = "none";
    foundUserData = null;
    const urcAvatar = el("urc-avatar");
    if (urcAvatar) urcAvatar.innerHTML = "👤";
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
        const urcAvatar = el("urc-avatar");
        if (urcAvatar) urcAvatar.innerHTML = "👤";
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
      el("newchat-result-title").innerHTML = esc(found.displayName || found.username) + verifiedBadge(found.username);
      el("newchat-result-bio").textContent   = "@" + found.username;
      const urcAvatar = el("urc-avatar");
      if (urcAvatar) {
        urcAvatar.innerHTML = found.photoURL
          ? `<img src="${esc(found.photoURL)}" style="width:100%;height:100%;object-fit:cover;" alt="Foto profil" />`
          : `👤`;
      }
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
      if (m.deletedFor && m.deletedFor.includes(myUid)) continue;
      // Pesan yang dihapus untuk semua orang tetap dianggap "pesan terakhir"
      // (tampil sebagai indikator dihapus), bukan dilewati ke pesan yang lebih lama.
      if (m.deletedForAll) { newPreview = "🚫 Pesan dihapus"; break; }
      // Pesan valid ditemukan
      if (m.type === "image") { newPreview = "📷 Foto"; }
      else if (m.type === "audio") { newPreview = "🎤 Voice note"; }
      else if (m.type === "document") { newPreview = "📄 " + (m.fileName || "Dokumen"); }
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
  } else if (m.type === "document") {
    const fname = m.fileName || "Dokumen";
    const fsize = formatFileSize(m.fileSize);
    body = `<a href="${esc(m.url)}" download="${esc(fname)}" target="_blank" class="msg-document">
      <div class="msg-document__icon">📄</div>
      <div class="msg-document__meta">
        <div class="msg-document__name">${esc(fname)}</div>
        ${fsize ? `<div class="msg-document__size">${esc(fsize)}</div>` : ""}
      </div>
    </a>`;
    downloadBtn = `<button class="msg-download-btn" data-url="${esc(m.url)}" data-filename="${esc(fname)}" title="Download dokumen">⬇️</button>`;
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
      <div class="empty__desc">Kirim pesan, foto, dokumen, atau voice note.</div>
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
    const last = visible[visible.length - 1]; // sudah difilter deletedFor, deletedForAll tetap ikut
    if (last) {
      let preview = "";
      if (last.deletedForAll) preview = "🚫 Pesan dihapus";
      else if (last.type === "image") preview = "📷 Foto";
      else if (last.type === "audio") preview = "🎤 Voice note";
      else if (last.type === "document") preview = "📄 " + (last.fileName || "Dokumen");
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

  // Kalau admin buka CHATBOTXGRAM
  if (isChatbotPeer(peer)) {
    isChatbotRoom = false; // akan di-set true di openChatbotRoom
    openChatbotRoom();
    return;
  }

  isChatbotRoom = false; // Pastikan reset saat buka chat biasa

  // Cek status suspend/block dari admin dulu
  try {
    const peerUserSnap = await getDoc(doc(db, "users", peer.uid));
    if (peerUserSnap.exists() && peerUserSnap.data().blocked) {
      toast("🚫 Akun ini telah disuspend dan tidak dapat dihubungi.");
      return;
    }
  } catch {}

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
  // Pengecualian 1: ADMINXGRAMREAL selalu bisa dichat oleh siapapun
  // Pengecualian 2: Admin yang sedang login bisa buka chat ke siapapun
  const currentUserIsAdmin = peerIsAdmin({ uid: currentUser.uid, username: currentUser.displayName });
  const isContact = currentUserIsAdmin || peerIsAdmin(peer) || await isAlreadyContact(peer.uid).catch(() => false);
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

  el("chatroom-username").innerHTML = esc(peer.displayName || peer.username) + verifiedBadge(peer.username);
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

function previewForType(type, textOrName) {
  if (type === "image") return "📷 Foto";
  if (type === "audio") return "🎤 Voice note";
  if (type === "document") return "📄 " + (textOrName || "Dokumen");
  return textOrName || "";
}

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

async function sendChatMessage(type, payload, extra = {}) {
  if (!currentChatId || !currentChatPeer) return;

  // Cek status suspend/block dari admin
  try {
    const peerUserSnap = await getDoc(doc(db, "users", currentChatPeer.uid));
    if (peerUserSnap.exists() && peerUserSnap.data().blocked) {
      toast("🚫 Akun ini telah disuspend. Pesan tidak terkirim.");
      return;
    }
  } catch {}

  // Cek blokir real-time sebelum kirim
  const blockedByMe   = await isBlocked(currentChatPeer.uid).catch(() => false);
  const blockedByThem = await isBlockedBy(currentChatPeer.uid).catch(() => false);
  if (blockedByMe) { toast("🚫 Kamu memblokir pengguna ini."); return; }
  if (blockedByThem) { toast("🚫 Kamu diblokir oleh pengguna ini. Pesan tidak terkirim."); return; }

  // Cek masih kontak (pengecualian: ADMINXGRAMREAL selalu bisa dichat)
  const senderIsAdmin = peerIsAdmin({ uid: currentUser.uid, username: currentUser.displayName });
  const contact = senderIsAdmin || peerIsAdmin(currentChatPeer) || await isAlreadyContact(currentChatPeer.uid).catch(() => false);
  if (!contact) { toast("⚠️ Kamu sudah tidak berteman dengan pengguna ini."); return; }

  const msg = { from: currentUser.uid, type, createdAt: serverTimestamp() };
  if (type === "text") {
    msg.text = payload;
  } else {
    msg.url = payload;
    if (extra.fileName) msg.fileName = extra.fileName;
    if (extra.fileSize) msg.fileSize = extra.fileSize;
  }

  await addDoc(collection(db, "chats", currentChatId, "messages"), msg);
  await setDoc(doc(db, "chats", currentChatId), {
    members:     currentChatMembers,
    memberInfo:  currentChatMemberInfo,
    lastMessage: previewForType(type, extra.fileName || payload),
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

// ── Dokumen (file apapun selain foto/video) tanpa Firebase Storage ──
async function handleAttachedDocument(file) {
  if (!file || !currentChatId) return;
  if (file.size > MAX_BASE64_CHARS) {
    toast("❌ Dokumen terlalu besar (maks ±500KB), coba file lain.");
    return;
  }

  toast("📄 Mengirim dokumen…", 6000);
  try {
    const dataUrl = await fileToDataUrl(file);
    if (dataUrl.length > MAX_BASE64_CHARS) {
      toast("❌ Dokumen terlalu besar setelah dikonversi, coba file lain.");
      return;
    }
    await sendChatMessage("document", dataUrl, { fileName: file.name, fileSize: file.size });
  } catch (err) {
    console.error("Send document error:", err);
    toast("❌ Gagal mengirim dokumen: " + err.message);
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

async function startRecording(target = "chat") {
  if (isRecording) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("❌ Perangkat tidak mendukung rekam suara."); return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickAudioMime();
    mediaRecorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime }) : new MediaRecorder(mediaStream);
    recordedChunks = [];
    recordingTarget = target;
    mediaRecorder.addEventListener("dataavailable", (e) => { if (e.data.size > 0) recordedChunks.push(e.data); });
    mediaRecorder.start();
    isRecording = true;
    const micBtnId = target === "group" ? "gr-mic" : "btn-mic";
    el(micBtnId)?.classList.add("recording");
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
  const target = recordingTarget || "chat";
  const micBtnId = target === "group" ? "gr-mic" : "btn-mic";
  el(micBtnId)?.classList.remove("recording");

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
      if (target === "group") {
        await sendGroupMessage("audio", dataUrl);
      } else {
        await sendChatMessage("audio", dataUrl);
      }
    } catch (err) {
      console.error("Voice note send error:", err);
      toast("❌ Gagal mengirim voice note: " + err.message);
    }
  }, { once: true });

  mediaRecorder.stop();
}

// ── Menu pilihan lampiran (Foto / Dokumen) — dipakai di chat 1-1 & grup ──
function closeAttachMenu() {
  document.getElementById("attach-menu")?.remove();
}

function showAttachMenu(triggerBtn, options) {
  closeAttachMenu();
  if (!triggerBtn) return;
  const menu = document.createElement("div");
  menu.id = "attach-menu";
  menu.className = "attach-menu";
  menu.innerHTML = options.map((o, i) =>
    `<button class="attach-menu__item" type="button" data-idx="${i}">${o.icon} ${esc(o.label)}</button>`
  ).join("");
  document.body.appendChild(menu);

  const rect = triggerBtn.getBoundingClientRect();
  menu.style.left   = Math.max(8, rect.left) + "px";
  menu.style.bottom = (window.innerHeight - rect.top + 8) + "px";

  menu.querySelectorAll(".attach-menu__item").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = +btn.dataset.idx;
      closeAttachMenu();
      options[idx].onClick();
    });
  });

  setTimeout(() => {
    document.addEventListener("click", function h(e) {
      if (!menu.contains(e.target) && e.target !== triggerBtn) {
        closeAttachMenu();
        document.removeEventListener("click", h);
      }
    });
  }, 0);
}

function initChatRoom() {
  function sendTextMsg() {
    const input = el("chat-input");
    const msg = input.value.trim();
    if (!msg) return;
    input.value = "";
    input.focus();

    // Kalau sedang di chatbot room, handle langsung tanpa kirim ke Firestore
    if (isChatbotRoom) {
      handleChatbotInput(msg);
      return;
    }

    // Perintah khusus admin (!menu, !block, !unblock, !pemberitahuan) tidak
    // dikirim sebagai pesan chat biasa — dijalankan sebagai aksi admin.
    tryAdminCommand(msg).then((handled) => {
      if (handled) return;
      sendChatMessage("text", msg).catch(err => {
        console.error(err);
        toast("❌ Gagal mengirim pesan: " + err.message);
      });
    });
  }

  el("send-message")?.addEventListener("click", sendTextMsg);
  el("chat-input")?.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTextMsg(); }
  });

  el("btn-attach")?.addEventListener("click", () => {
    showAttachMenu(el("btn-attach"), [
      { icon: "📷", label: "Foto",    onClick: () => el("chat-attach")?.click() },
      { icon: "📄", label: "Dokumen", onClick: () => el("chat-attach-doc")?.click() },
    ]);
  });
  el("chat-attach")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    handleAttachedFile(file);
    e.target.value = "";
  });
  el("chat-attach-doc")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    handleAttachedDocument(file);
    e.target.value = "";
  });

  const micBtn = el("btn-mic");
  if (micBtn) {
    micBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); startRecording("chat"); });
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
    el("vp-name").innerHTML = esc(u.displayName || u.username || "—") + verifiedBadge(u.username);
    el("vp-username").textContent = "@" + (u.username || "—");
    el("vp-bio").textContent = u.bio || "Belum ada bio.";
    show("view-profile");
  } catch (e) { toast("❌ Gagal memuat profil: " + e.message); }
}

// ─── Group Chat ───────────────────────────────────────────────────

let currentGroupId   = null;
let currentGroupData = null;
let groupMsgUnsub    = null;

let incomingCallUnsub = null;

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
              <div class="cg-member-name">${esc(c.displayName || c.username)}${verifiedBadge(c.username)}</div>
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
    else if (m.type === "document") {
      const fname = m.fileName || "Dokumen";
      const fsize = formatFileSize(m.fileSize);
      body = `<a href="${esc(m.url)}" download="${esc(fname)}" target="_blank" class="msg-document">
        <div class="msg-document__icon">📄</div>
        <div class="msg-document__meta">
          <div class="msg-document__name">${esc(fname)}</div>
          ${fsize ? `<div class="msg-document__size">${esc(fsize)}</div>` : ""}
        </div>
      </a>`;
    }
    else body = `<div class="msg-text">${esc(m.text || "")}</div>`;
    const sender = !mine ? `<div class="bubble__sender">${esc(m.fromName || "?")}</div>` : "";
    return `<div class="bubble ${mine ? "bubble--me" : ""}" data-msg-id="${esc(m.id)}" data-msg-from="${esc(m.from)}">
      ${sender}${body}
      <div class="bubble__footer"><div class="bubble__time">${esc(time)}</div></div>
    </div>`;
  }).filter(Boolean).join("");
  log.scrollTop = log.scrollHeight;

  // Sync lastMessage grup dengan pesan terakhir secara aktual (termasuk status "dihapus")
  if (currentGroupId && list.length) {
    const lastRaw = list[list.length - 1]; // pesan terakhir tanpa filter deletedFor, biar konsisten utk semua anggota
    let preview = "";
    if (lastRaw.deletedForAll) preview = "🚫 Pesan dihapus";
    else if (lastRaw.type === "image") preview = "📷 Foto";
    else if (lastRaw.type === "audio") preview = "🎤 Voice note";
    else if (lastRaw.type === "document") preview = "📄 " + (lastRaw.fileName || "Dokumen");
    else preview = lastRaw.text || "";
    if (!renderGroupMessages._lastPreview || renderGroupMessages._lastPreview !== preview) {
      renderGroupMessages._lastPreview = preview;
      updateDoc(doc(db, "groups", currentGroupId), { lastMessage: preview }).catch(() => {});
    }
  }

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

// Setelah hapus pesan grup, recalculate lastMessage grup dari pesan terakhir
// (field lastMessage di grup bersifat global/shared untuk semua anggota)
async function refreshGroupLastMessage(groupId) {
  try {
    const snap = await getDocs(
      query(collection(db, "groups", groupId, "messages"), orderBy("createdAt", "desc"), limit(1))
    );
    let newPreview = "";
    if (!snap.empty) {
      const m = snap.docs[0].data();
      if (m.deletedForAll) newPreview = "🚫 Pesan dihapus";
      else if (m.type === "image") newPreview = "📷 Foto";
      else if (m.type === "audio") newPreview = "🎤 Voice note";
      else if (m.type === "document") newPreview = "📄 " + (m.fileName || "Dokumen");
      else newPreview = m.text || "";
    }
    await updateDoc(doc(db, "groups", groupId), { lastMessage: newPreview });
  } catch (e) {
    console.warn("refreshGroupLastMessage gagal (non-fatal):", e);
  }
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
    await refreshGroupLastMessage(currentGroupId);
  });
  menu.querySelector("[data-a='all']").addEventListener("click", async () => {
    if (!confirm("Hapus untuk semua?")) return;
    menu.remove();
    await updateDoc(doc(db, "groups", currentGroupId, "messages", msgId), { deletedForAll: true, text: null, url: null }).catch(e => toast("❌ " + e.message));
    await refreshGroupLastMessage(currentGroupId);
  });
  setTimeout(() => {
    document.addEventListener("click", function h(e) { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("click", h); } });
  }, 100);
}

async function sendGroupMessage(type, payload, extra = {}) {
  if (!currentGroupId) return;
  const msg = {
    from:     currentUser.uid,
    fromName: currentUser.displayName || "?",
    type,
    createdAt: serverTimestamp(),
  };
  if (type === "text") {
    msg.text = payload;
  } else {
    msg.url = payload;
    if (extra.fileName) msg.fileName = extra.fileName;
    if (extra.fileSize) msg.fileSize = extra.fileSize;
  }
  await addDoc(collection(db, "groups", currentGroupId, "messages"), msg);
  await updateDoc(doc(db, "groups", currentGroupId), {
    lastMessage: type === "image" ? "📷 Foto"
      : type === "audio" ? "🎤 Voice note"
      : type === "document" ? "📄 " + (extra.fileName || "Dokumen")
      : payload,
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

// Dipasang SEKALI saat boot (lihat initNav). Semua aksi di panel "Info Grup"
// ditangani di sini supaya listener tidak numpuk setiap renderGroupInfoPanel()
// dipanggil ulang — sebelumnya itu menyebabkan satu klik memicu aksi (mis. keluar
// grup / kick / jadi-admin) berkali-kali sekaligus dan muncul error permission
// palsu walau aksi pertamanya sendiri sukses.
function initGroupInfoHandlers() {
  // — Aksi member: kick / jadikan admin / turunkan admin (event delegation) —
  el("gi-members")?.addEventListener("click", async (e) => {
    const kickBtn   = e.target.closest("[data-kick]");
    const makeBtn   = e.target.closest("[data-make-admin]");
    const removeBtn = e.target.closest("[data-remove-admin]");
    if (!kickBtn && !makeBtn && !removeBtn) return;
    if (!currentGroupId || !currentGroupData) return;

    if (kickBtn) {
      if (kickBtn.disabled) return;
      const uid = kickBtn.dataset.kick;
      const name = kickBtn.dataset.kname;
      if (!confirm(`Keluarkan ${name} dari grup?`)) return;
      kickBtn.disabled = true;
      try {
        const newMembers = (currentGroupData.members || []).filter(u => u !== uid);
        const newAdmins  = (currentGroupData.admins  || []).filter(u => u !== uid);
        if (!newMembers.length) {
          await deleteDoc(doc(db, "groups", currentGroupId));
          toast("✅ " + name + " dikeluarkan. Grup dihapus karena kosong.");
          currentGroupId = null; currentGroupData = null;
          show("home"); setTab("chats"); return;
        }
        await updateDoc(doc(db, "groups", currentGroupId), { members: newMembers, admins: newAdmins });
        const fresh = await getDoc(doc(db, "groups", currentGroupId));
        currentGroupData = { id: currentGroupId, ...fresh.data() };
        renderGroupInfoPanel();
        toast("✅ " + name + " dikeluarkan.");
        el("gr-member-count").textContent = newMembers.length + " anggota";
      } catch (e2) { toast("❌ " + e2.message); kickBtn.disabled = false; }
      return;
    }

    if (makeBtn) {
      if (makeBtn.disabled) return;
      const uid = makeBtn.dataset.makeAdmin;
      makeBtn.disabled = true;
      try {
        await updateDoc(doc(db, "groups", currentGroupId), { admins: arrayUnion(uid) });
        const fresh = await getDoc(doc(db, "groups", currentGroupId));
        currentGroupData = { id: currentGroupId, ...fresh.data() };
        renderGroupInfoPanel();
        toast("✅ Admin baru ditambahkan.");
      } catch (e2) { toast("❌ " + e2.message); makeBtn.disabled = false; }
      return;
    }

    if (removeBtn) {
      if (removeBtn.disabled) return;
      const uid = removeBtn.dataset.removeAdmin;
      if (!confirm("Turunkan member ini dari Admin?")) return;
      removeBtn.disabled = true;
      try {
        const newAdmins = (currentGroupData.admins || []).filter(a => String(a) !== String(uid));
        await updateDoc(doc(db, "groups", currentGroupId), { admins: newAdmins });
        const fresh = await getDoc(doc(db, "groups", currentGroupId));
        currentGroupData = { id: currentGroupId, ...fresh.data() };
        renderGroupInfoPanel();
        toast("✅ Status admin dicabut.");
      } catch (e2) { toast("❌ " + e2.message); removeBtn.disabled = false; }
      return;
    }
  });

  // — Edit nama grup —
  el("gi-edit-name-btn")?.addEventListener("click", () => {
    el("gi-name-form").style.display = "block";
    el("gi-name-input").value = currentGroupData?.name || "";
    el("gi-name-input").focus();
  });
  el("gi-name-cancel")?.addEventListener("click", () => { el("gi-name-form").style.display = "none"; });
  el("gi-name-save")?.addEventListener("click", async () => {
    const newName = el("gi-name-input").value.trim();
    if (!newName) { toast("❌ Nama grup tidak boleh kosong."); return; }
    const btn = el("gi-name-save");
    if (btn.disabled) return;
    btn.disabled = true; btn.textContent = "⏳";
    try {
      await updateDoc(doc(db, "groups", currentGroupId), { name: newName });
      const fresh = await getDoc(doc(db, "groups", currentGroupId));
      currentGroupData = { id: currentGroupId, ...fresh.data() };
      el("gi-name-form").style.display = "none";
      renderGroupInfoPanel();
      el("gr-name").textContent = newName;
      toast("✅ Nama grup diperbarui.");
    } catch (e) { toast("❌ " + e.message); }
    finally { btn.disabled = false; btn.textContent = "Simpan"; }
  });

  // — Tambah anggota (admin only) —
  el("gi-add-member-btn")?.addEventListener("click", async () => {
    const form = el("gi-add-member-form");
    if (form.style.display === "block") { form.style.display = "none"; return; }
    form.style.display = "block";
    el("gi-add-member-list").innerHTML = `<div class="loading-text" style="font-size:13px;">Memuat kontak…</div>`;
    try {
      const snap = await getDocs(collection(db, "contacts", currentUser.uid, "list"));
      const contacts = snap.docs.map(d => d.data());
      const currentMembers = currentGroupData.members || [];
      const eligible = contacts.filter(c => !currentMembers.includes(c.uid));
      if (!eligible.length) {
        el("gi-add-member-list").innerHTML = `<div style="font-size:13px;color:var(--tx2);padding:8px 0;">Semua kontak sudah jadi anggota.</div>`;
        return;
      }
      el("gi-add-member-list").innerHTML = eligible.map(c => {
        const avatarHtml = c.photoURL
          ? `<img src="${esc(c.photoURL)}" style="width:34px;height:34px;border-radius:50%;object-fit:cover;flex-shrink:0;" />`
          : `<div style="width:34px;height:34px;border-radius:50%;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0;">${(c.displayName||c.username||"?")[0].toUpperCase()}</div>`;
        return `<label style="display:flex;align-items:center;gap:10px;padding:6px 0;cursor:pointer;">
          <input type="checkbox" class="gi-add-cb" value="${esc(c.uid)}" data-name="${esc(c.displayName||c.username)}" />
          ${avatarHtml}
          <div>
            <div style="font-size:14px;font-weight:600;">${esc(c.displayName||c.username)}${verifiedBadge(c.username)}</div>
            <div style="font-size:12px;color:var(--tx2);">@${esc(c.username)}</div>
          </div>
        </label>`;
      }).join("");
    } catch (e) { el("gi-add-member-list").innerHTML = `<div style="color:var(--danger);font-size:13px;">${esc(e.message)}</div>`; }
  });

  el("gi-add-member-cancel")?.addEventListener("click", () => { el("gi-add-member-form").style.display = "none"; });

  el("gi-add-member-submit")?.addEventListener("click", async () => {
    const checked = [...el("gi-add-member-list").querySelectorAll(".gi-add-cb:checked")];
    if (!checked.length) { toast("❌ Pilih minimal 1 kontak."); return; }
    const btn = el("gi-add-member-submit");
    if (btn.disabled) return;
    btn.disabled = true; btn.textContent = "⏳";
    try {
      const newUids = checked.map(c => c.value);
      const newNames = Object.fromEntries(checked.map(c => [c.value, c.dataset.name]));
      const updatedMembers = [...new Set([...(currentGroupData.members||[]), ...newUids])];
      const updatedNames = { ...(currentGroupData.memberNames||{}), ...newNames };
      await updateDoc(doc(db, "groups", currentGroupId), {
        members: updatedMembers,
        memberNames: updatedNames,
        updatedAt: serverTimestamp(),
      });
      const fresh = await getDoc(doc(db, "groups", currentGroupId));
      currentGroupData = { id: currentGroupId, ...fresh.data() };
      el("gi-add-member-form").style.display = "none";
      renderGroupInfoPanel();
      el("gr-member-count").textContent = updatedMembers.length + " anggota";
      toast("✅ " + newUids.length + " anggota ditambahkan.");
    } catch (e) { toast("❌ " + e.message); }
    finally { btn.disabled = false; btn.textContent = "Tambahkan"; }
  });

  // — Keluar grup —
  el("gi-leave-btn")?.addEventListener("click", async () => {
    if (!currentGroupId || !currentGroupData) return;
    const leaveBtn = el("gi-leave-btn");
    if (leaveBtn.disabled) return; // cegah klik dobel/listener dobel memicu deleteDoc 2x

    const isOnlyAdmin = (currentGroupData.admins || []).length === 1 && (currentGroupData.admins || []).includes(currentUser.uid);
    const otherMembers = (currentGroupData.members || []).filter(u => u !== currentUser.uid);

    if (!confirm("Keluar dari grup ini?")) return;
    leaveBtn.disabled = true; leaveBtn.textContent = "⏳";
    try {
      if (otherMembers.length === 0) {
        // Sisa hanya kita — hapus grup total
        await deleteDoc(doc(db, "groups", currentGroupId));
        toast("Kamu keluar. Grup dihapus karena sudah kosong.");
        currentGroupId = null; currentGroupData = null;
        if (groupMsgUnsub) { groupMsgUnsub(); groupMsgUnsub = null; }
        show("home"); setTab("chats"); return;
      }

      let newAdmins = (currentGroupData.admins || []).filter(u => u !== currentUser.uid);
      if (isOnlyAdmin && newAdmins.length === 0) {
        // Transfer admin ke member pertama yang tersisa
        newAdmins = [otherMembers[0]];
        toast("Admin dialihkan ke " + (currentGroupData.memberNames?.[otherMembers[0]] || "anggota lain") + ".");
      }

      await updateDoc(doc(db, "groups", currentGroupId), {
        members: otherMembers,
        admins:  newAdmins,
        updatedAt: serverTimestamp(),
      });
      toast("✅ Kamu sudah keluar dari grup.");
      currentGroupId = null; currentGroupData = null;
      if (groupMsgUnsub) { groupMsgUnsub(); groupMsgUnsub = null; }
      show("home"); setTab("chats");
    } catch (e) {
      toast("❌ " + e.message);
      leaveBtn.disabled = false; leaveBtn.textContent = "🚪 Keluar dari Grup";
    }
  });
}

async function renderGroupInfoPanel() {
  const g = currentGroupData;
  const admins = (g.admins || []).map(String);
  const isAdmin = admins.includes(String(currentUser.uid));
  const photo = g.photoURL || "";

  el("gi-photo").innerHTML = photo
    ? `<img src="${esc(photo)}" class="gi-photo-img" />`
    : `<div class="gi-photo-placeholder">${(g.name||"G")[0].toUpperCase()}</div>`;

  el("gi-name").textContent  = g.name || "Grup";
  el("gi-count").textContent = (g.members?.length || 0) + " anggota";

  // Tombol edit foto & nama grup — hanya admin
  const editPhotoBtn = el("gi-edit-photo");
  if (editPhotoBtn) editPhotoBtn.style.display = isAdmin ? "flex" : "none";
  const editNameBtn = el("gi-edit-name-btn");
  if (editNameBtn) editNameBtn.style.display = isAdmin ? "inline-flex" : "none";

  // Tambah anggota — hanya admin
  const addSection = el("gi-add-member-section");
  if (addSection) addSection.style.display = isAdmin ? "block" : "none";

  // Members list
  const memberSnaps = await Promise.all((g.members || []).map(uid => getDoc(doc(db, "users", uid)).catch(() => null)));
  // PENTING: jangan pakai field "uid" dari dokumen /users/{uid} sebagai sumber kebenaran —
  // sebagian akun (lama/seed, mis. AdminXGRAM) tidak menyimpan field itu, sehingga jadi
  // undefined dan bikin pencocokan admin/"isMe" gagal untuk SEMUA member, termasuk diri sendiri.
  // Sumber kebenaran uid yang benar adalah array g.members (urutannya match dengan memberSnaps).
  const memberDatas = memberSnaps.map((s, i) => {
    const uid = g.members[i];
    const data = s?.exists() ? s.data() : { displayName: "?", username: "?", photoURL: "" };
    return { ...data, uid };
  });

  el("gi-members").innerHTML = memberDatas.map(u => {
    const isAdm = admins.includes(String(u.uid));
    const isMe  = String(u.uid) === String(currentUser.uid);
    const avatarHtml = u.photoURL
      ? `<img src="${esc(u.photoURL)}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0;" />`
      : `<div class="gi-member-avatar">${(u.displayName||u.username||"?")[0].toUpperCase()}</div>`;
    // Admin bisa kelola semua member kecuali diri sendiri
    const canManage = isAdmin && !isMe;
    return `<div class="gi-member">
      ${avatarHtml}
      <div class="gi-member-info">
        <div class="gi-member-name">${esc(u.displayName || u.username)}${verifiedBadge(u.username)}</div>
        <div class="gi-member-role">${isAdm ? "👑 Admin" : "Anggota"}${isMe ? " · Kamu" : ""}</div>
      </div>
      ${canManage ? `
        <div class="gi-member-actions">
          ${!isAdm
            ? `<button class="btn btn--sm btn--secondary" data-make-admin="${esc(u.uid)}" title="Jadikan Admin">👑</button>`
            : `<button class="btn btn--sm btn--secondary" data-remove-admin="${esc(u.uid)}" title="Turunkan dari Admin">🚫👑</button>`}
          <button class="btn btn--sm btn--danger" data-kick="${esc(u.uid)}" data-kname="${esc(u.displayName||u.username)}" title="Keluarkan">✕</button>
        </div>` : ""}
    </div>`;
  }).join("");

  // — Aksi member (kick / jadikan admin / turunkan admin) —
  // PENTING: listener berikut dipasang SEKALI SAJA via event delegation di initNav
  // (lihat initGroupInfoHandlers), bukan di sini. Kalau dipasang di sini, setiap kali
  // renderGroupInfoPanel() dipanggil ulang (tiap ada perubahan member/admin), listener
  // lama akan numpuk dan satu klik bisa memicu aksi yang sama berkali-kali sekaligus —
  // itulah penyebab error "Missing or insufficient permissions" yang muncul setelah
  // operasi (mis. keluar grup) padahal operasinya sendiri sudah berhasil.
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
  initGroupInfoHandlers();

  // Group info: change photo (admin only)
  el("gi-edit-photo")?.addEventListener("click", () => el("gi-photo-input")?.click());
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
  el("gr-attach-btn")?.addEventListener("click", () => {
    showAttachMenu(el("gr-attach-btn"), [
      { icon: "📷", label: "Foto",    onClick: () => el("gr-attach-input")?.click() },
      { icon: "📄", label: "Dokumen", onClick: () => el("gr-attach-doc-input")?.click() },
    ]);
  });
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
  el("gr-attach-doc-input")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_BASE64_CHARS) { toast("❌ Dokumen terlalu besar (maks ±500KB)."); e.target.value = ""; return; }
    toast("📄 Mengirim dokumen…", 5000);
    try {
      const dataUrl = await fileToDataUrl(file);
      if (dataUrl.length > MAX_BASE64_CHARS) { toast("❌ Dokumen terlalu besar setelah dikonversi."); return; }
      await sendGroupMessage("document", dataUrl, { fileName: file.name, fileSize: file.size });
    } catch (err) { toast("❌ " + err.message); }
    e.target.value = "";
  });

  const grMicBtn = el("gr-mic");
  if (grMicBtn) {
    grMicBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); startRecording("group"); });
    grMicBtn.addEventListener("pointerup",   () => stopRecording());
    grMicBtn.addEventListener("pointerleave",() => { if (isRecording) stopRecording(); });
    grMicBtn.addEventListener("pointercancel",() => { if (isRecording) stopRecording(); });
  }
}

// ════════════════════════════════════════════════════════════════════
// WebRTC CALL SYSTEM — 1-1 voice & video via Firestore signaling
// Firestore collections needed:
//   calls/{callId}          → offer, answer, type, callerUid, calleeUid, status
//   calls/{callId}/callerCandidates/{id}
//   calls/{callId}/calleeCandidates/{id}
//
// Firestore rules to add:
//   match /calls/{callId} { allow read, write: if request.auth != null; }
//   match /calls/{callId}/callerCandidates/{id} { allow read, write: if request.auth != null; }
//   match /calls/{callId}/calleeCandidates/{id} { allow read, write: if request.auth != null; }
// ════════════════════════════════════════════════════════════════════

const STUN_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
};

// ─── Call state ──────────────────────────────────────────────────────
let callState = {
  active:        false,
  type:          "voice",   // "voice" | "video"
  callId:        null,
  role:          null,      // "caller" | "callee"
  peerUid:       null,
  peerName:      null,
  peerPhotoURL:  null,
  pc:            null,      // RTCPeerConnection
  localStream:   null,
  remoteStream:  null,
  callDocUnsub:  null,
  timerInterval: null,
  timerSec:      0,
  muted:         false,
  speakerOff:    false,
  camOff:        false,
};

// ─── Helpers ─────────────────────────────────────────────────────────
function callId(uidA, uidB) {
  // Deterministic ID so both sides reference same doc
  return [uidA, uidB].sort().join("_call_");
}

function renderCallAvatar(wrapId, photoURL, name) {
  const wrap = el(wrapId);
  if (!wrap) return;
  if (photoURL) {
    wrap.innerHTML = `<img src="${esc(photoURL)}" alt="${esc(name)}" />`;
  } else {
    wrap.textContent = (name || "?")[0].toUpperCase();
  }
}

function startCallTimer() {
  callState.timerSec = 0;
  const timerEl = el("call-timer");
  callState.timerInterval = setInterval(() => {
    callState.timerSec++;
    const m = String(Math.floor(callState.timerSec / 60)).padStart(2, "0");
    const s = String(callState.timerSec % 60).padStart(2, "0");
    if (timerEl) timerEl.textContent = `${m}:${s}`;
  }, 1000);
}

function stopCallTimer() {
  clearInterval(callState.timerInterval);
  callState.timerInterval = null;
}

// ─── Show overlay states ─────────────────────────────────────────────
function showCallOverlay(state) {
  // state: "connecting" | "incoming" | "active"
  const overlay = el("call-overlay");
  overlay.style.display = "flex";
  el("call-state-connecting").style.display = state === "connecting" ? "flex" : "none";
  el("call-state-incoming").style.display   = state === "incoming"   ? "flex" : "none";
  el("call-state-active").style.display     = state === "active"     ? "flex" : "none";

  if (callState.type === "video") {
    overlay.classList.add("call-overlay--video");
    el("btn-call-cam").style.display = "flex";
  } else {
    overlay.classList.remove("call-overlay--video");
    el("btn-call-cam").style.display = "none";
  }
}

function hideCallOverlay() {
  const overlay = el("call-overlay");
  if (overlay) {
    overlay.style.display = "none";
    overlay.classList.remove("call-overlay--video");
  }
}

// ─── Cleanup call ────────────────────────────────────────────────────
async function endCall(notify = true) {
  stopCallTimer();
  stopRingtone();

  // Stop tracks
  callState.localStream?.getTracks().forEach(t => t.stop());
  callState.remoteStream?.getTracks().forEach(t => t.stop());

  // Close peer connection
  if (callState.pc) {
    callState.pc.onicecandidate = null;
    callState.pc.ontrack = null;
    callState.pc.close();
  }

  // Clear video elements
  const remVid = el("call-remote-video");
  const locVid = el("call-local-video");
  if (remVid) remVid.srcObject = null;
  if (locVid) locVid.srcObject = null;

  // Unsubscribe Firestore listener
  if (callState.callDocUnsub) { callState.callDocUnsub(); callState.callDocUnsub = null; }

  // Update Firestore status to ended
  if (notify && callState.callId) {
    try {
      await updateDoc(doc(db, "calls", callState.callId), { status: "ended" });
    } catch {}
  }

  hideCallOverlay();

  // Reset state
  callState = {
    active: false, type: "voice", callId: null, role: null,
    peerUid: null, peerName: null, peerPhotoURL: null,
    pc: null, localStream: null, remoteStream: null,
    callDocUnsub: null, timerInterval: null, timerSec: 0,
    muted: false, speakerOff: false, camOff: false,
  };
}

// ─── Setup RTCPeerConnection ─────────────────────────────────────────
async function createPeerConnection(cId, role) {
  const pc = new RTCPeerConnection(STUN_SERVERS);
  callState.pc = pc;

  const localCandCol  = role === "caller" ? "callerCandidates" : "calleeCandidates";
  const remoteCandCol = role === "caller" ? "calleeCandidates" : "callerCandidates";

  // Send local ICE candidates to Firestore
  pc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    try {
      await addDoc(collection(db, "calls", cId, localCandCol), e.candidate.toJSON());
    } catch {}
  };

  // Receive remote stream
  const remoteStream = new MediaStream();
  callState.remoteStream = remoteStream;
  const remVid = el("call-remote-video");
  if (remVid) remVid.srcObject = remoteStream;

  pc.ontrack = (e) => {
    e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
  };

  // Watch for remote ICE candidates
  const candUnsub = onSnapshot(
    collection(db, "calls", cId, remoteCandCol),
    (snap) => {
      snap.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
          } catch {}
        }
      });
    }
  );
  // Store unsub alongside the call doc unsub
  const origUnsub = callState.callDocUnsub;
  callState.callDocUnsub = () => { origUnsub?.(); candUnsub(); };

  return pc;
}

// ─── Get media stream ─────────────────────────────────────────────────
async function getLocalStream(type) {
  const constraints = type === "video"
    ? { audio: true, video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } }
    : { audio: true, video: false };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  callState.localStream = stream;
  if (type === "video") {
    const locVid = el("call-local-video");
    if (locVid) locVid.srcObject = stream;
  }
  return stream;
}

// ─── Initiate call (caller side) ─────────────────────────────────────
async function startCall(type) {
  if (!currentChatPeer?.uid) return;
  if (callState.active) { toast("Sedang dalam panggilan lain."); return; }

  const cId    = callId(currentUser.uid, currentChatPeer.uid);
  const pName  = currentChatPeer.displayName || currentChatPeer.username || "Pengguna";
  const pPhoto = currentChatPeer.photoURL || "";

  callState.active       = true;
  callState.type         = type;
  callState.callId       = cId;
  callState.role         = "caller";
  callState.peerUid      = currentChatPeer.uid;
  callState.peerName     = pName;
  callState.peerPhotoURL = pPhoto;

  // Show connecting UI
  renderCallAvatar("call-peer-avatar", pPhoto, pName);
  el("call-peer-name").innerHTML      = esc(pName) + verifiedBadge(currentChatPeer?.username);
  el("call-status-label").textContent = type === "video" ? "Memanggil (Video)…" : "Memanggil…";
  showCallOverlay("connecting");

  try {
    const stream = await getLocalStream(type);
    const pc     = await createPeerConnection(cId, "caller");

    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    // Create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Write to Firestore
    await setDoc(doc(db, "calls", cId), {
      offer:      { type: offer.type, sdp: offer.sdp },
      callerUid:  currentUser.uid,
      calleeUid:  currentChatPeer.uid,
      type,
      status:     "calling",
      createdAt:  serverTimestamp(),
    });

    // Listen for answer / hangup
    const docUnsub = onSnapshot(doc(db, "calls", cId), async (snap) => {
      const data = snap.data();
      if (!data) return;

      if (data.answer && !pc.currentRemoteDescription) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          // Call connected
          el("call-active-name").innerHTML = esc(pName) + verifiedBadge(currentChatPeer?.username);
          renderCallAvatar("call-active-avatar", pPhoto, pName);
          showCallOverlay("active");
          startCallTimer();
        } catch {}
      }

      if (data.status === "ended" || data.status === "rejected") {
        const msg = data.status === "rejected" ? "Panggilan ditolak." : "Panggilan berakhir.";
        await endCall(false);
        toast(msg);
      }
    });

    // Prepend to existing unsub chain
    const prevUnsub = callState.callDocUnsub;
    callState.callDocUnsub = () => { prevUnsub?.(); docUnsub(); };

  } catch (err) {
    await endCall(false);
    if (err.name === "NotAllowedError") {
      toast("❌ Izin mikrofon/kamera ditolak. Buka pengaturan browser.");
    } else {
      toast("❌ Gagal memulai panggilan: " + err.message);
    }
  }
}

// ─── Ringtone (Web Audio API) ────────────────────────────────────────
let ringtoneInterval = null;
let ringtoneAudioCtx = null;

function startRingtone() {
  stopRingtone();
  function playBeep() {
    try {
      const ctx  = new (window.AudioContext || window.webkitAudioContext)();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(660, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.45);
      osc.onended = () => ctx.close();
    } catch {}
  }
  playBeep();
  ringtoneInterval = setInterval(playBeep, 1200);
}

function stopRingtone() {
  if (ringtoneInterval) { clearInterval(ringtoneInterval); ringtoneInterval = null; }
}

// ─── Incoming call (callee side) ─────────────────────────────────────
function startIncomingCallListener() {
  if (!currentUser) return;
  if (incomingCallUnsub) { incomingCallUnsub(); incomingCallUnsub = null; }

  // Listen for any call doc where calleeUid = me and status = "calling"
  const q = query(
    collection(db, "calls"),
    where("calleeUid", "==", currentUser.uid),
    where("status", "==", "calling")
  );

  incomingCallUnsub = onSnapshot(q, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added" && !callState.active) {
        const data   = change.doc.data();
        const cId    = change.doc.id;
        handleIncomingCall(cId, data);
      }
    });
  });
}

function stopIncomingCallListener() {
  if (incomingCallUnsub) { incomingCallUnsub(); incomingCallUnsub = null; }
}

async function handleIncomingCall(cId, data) {
  // Fetch caller info
  let callerName  = "Seseorang";
  let callerPhoto = "";
  try {
    const callerSnap = await getDoc(doc(db, "users", data.callerUid));
    if (callerSnap.exists()) {
      const d  = callerSnap.data();
      callerName  = d.displayName || d.username || callerName;
      el("call-incoming-name").innerHTML = esc(callerName) + verifiedBadge(d.username);
      callerPhoto = d.photoURL || "";
    }
  } catch {}

  callState.active       = true;
  callState.type         = data.type || "voice";
  callState.callId       = cId;
  callState.role         = "callee";
  callState.peerUid      = data.callerUid;
  callState.peerName     = callerName;
  callState.peerPhotoURL = callerPhoto;

  renderCallAvatar("call-incoming-avatar", callerPhoto, callerName);
  el("call-incoming-name").innerHTML         = esc(callerName) + verifiedBadge(callerName);
  el("call-incoming-type-label").textContent =
    data.type === "video" ? "Panggilan Video Masuk" : "Panggilan Suara Masuk";
  showCallOverlay("incoming");

  // Play ringtone
  startRingtone();

  // Monitor if caller hangs up before we answer
  const docUnsub = onSnapshot(doc(db, "calls", cId), async (snap) => {
    const d = snap.data();
    if (d?.status === "ended" || d?.status === "rejected") {
      stopRingtone();
      await endCall(false);
      toast("Panggilan dibatalkan.");
    }
  });
  callState.callDocUnsub = docUnsub;
}

async function acceptCall() {
  const cId  = callState.callId;
  const type = callState.type;

  stopRingtone();

  // Unsubscribe the "cancelled?" listener first
  if (callState.callDocUnsub) { callState.callDocUnsub(); callState.callDocUnsub = null; }

  try {
    const stream = await getLocalStream(type);
    const pc     = await createPeerConnection(cId, "callee");
    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    // Get offer from Firestore
    const callSnap = await getDoc(doc(db, "calls", cId));
    const offerData = callSnap.data()?.offer;
    if (!offerData) throw new Error("Offer tidak ditemukan.");

    await pc.setRemoteDescription(new RTCSessionDescription(offerData));

    // Create & set answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await updateDoc(doc(db, "calls", cId), {
      answer: { type: answer.type, sdp: answer.sdp },
      status: "active",
    });

    // Show active call UI
    el("call-active-name").innerHTML   = esc(callState.peerName) + verifiedBadge(callState.peerName);
    renderCallAvatar("call-active-avatar", callState.peerPhotoURL, callState.peerName);
    showCallOverlay("active");
    startCallTimer();

    // Listen for hangup from caller
    const docUnsub = onSnapshot(doc(db, "calls", cId), async (snap) => {
      const d = snap.data();
      if (d?.status === "ended") {
        await endCall(false);
        toast("Panggilan berakhir.");
      }
    });
    const prevUnsub = callState.callDocUnsub;
    callState.callDocUnsub = () => { prevUnsub?.(); docUnsub(); };

  } catch (err) {
    await endCall(false);
    toast("❌ Gagal menerima panggilan: " + err.message);
  }
}

async function rejectCall() {
  const cId = callState.callId;
  stopRingtone();
  try {
    if (cId) await updateDoc(doc(db, "calls", cId), { status: "rejected" });
  } catch {}
  await endCall(false);
}

// ─── Mute / Speaker / Camera toggles ─────────────────────────────────
function toggleMute() {
  if (!callState.localStream) return;
  callState.muted = !callState.muted;
  callState.localStream.getAudioTracks().forEach(t => { t.enabled = !callState.muted; });
  const btn = el("btn-call-mute");
  if (btn) btn.classList.toggle("active", callState.muted);
}

function toggleSpeaker() {
  // Web doesn't expose speaker routing directly; toggle button state for UX
  callState.speakerOff = !callState.speakerOff;
  const btn = el("btn-call-speaker");
  if (btn) btn.classList.toggle("active", callState.speakerOff);
  toast(callState.speakerOff ? "Speaker dimatikan." : "Speaker dihidupkan.");
}

function toggleCam() {
  if (!callState.localStream) return;
  callState.camOff = !callState.camOff;
  callState.localStream.getVideoTracks().forEach(t => { t.enabled = !callState.camOff; });
  const btn = el("btn-call-cam");
  if (btn) btn.classList.toggle("active", callState.camOff);
}

// ─── Coming soon modal (group call buttons) ───────────────────────────
function showComingSoon(type) {
  const desc = type === "video"
    ? "Video call grup sedang dalam pengembangan menggunakan WebRTC dan akan segera hadir!"
    : "Telepon grup sedang dalam pengembangan menggunakan WebRTC dan akan segera hadir!";
  el("modal-coming-desc").textContent = desc;
  el("modal-coming-soon").style.display = "flex";
}

// ─── Init call UI handlers ────────────────────────────────────────────
function initCallHandlers() {
  // 1-1 chat: voice call button
  el("btn-voice-call")?.addEventListener("click", () => startCall("voice"));

  // 1-1 chat: video call button
  el("btn-video-call")?.addEventListener("click", () => startCall("video"));

  // Group: coming soon buttons
  el("gr-btn-voice-call")?.addEventListener("click", () => showComingSoon("voice"));
  el("gr-btn-video-call")?.addEventListener("click", () => showComingSoon("video"));

  // Coming soon modal close
  el("modal-coming-close")?.addEventListener("click", () => {
    el("modal-coming-soon").style.display = "none";
  });
  el("modal-coming-soon")?.addEventListener("click", (e) => {
    if (e.target === el("modal-coming-soon")) el("modal-coming-soon").style.display = "none";
  });

  // Connecting state: end call
  el("btn-call-end")?.addEventListener("click", () => endCall(true));

  // Incoming: reject / accept
  el("btn-call-reject")?.addEventListener("click", () => rejectCall());
  el("btn-call-accept")?.addEventListener("click", () => acceptCall());

  // Active state: controls
  el("btn-call-mute")?.addEventListener("click", () => toggleMute());
  el("btn-call-speaker")?.addEventListener("click", () => toggleSpeaker());
  el("btn-call-cam")?.addEventListener("click", () => toggleCam());
  el("btn-call-end-active")?.addEventListener("click", () => endCall(true));
}

// ─── Boot ───────────────────────────────────────────────────────────
function main() {
  setTheme(currentTheme);

  initNav();
  initAuth();
  initNewChat();
  initChatRoom();
  initCallHandlers();          // ← WebRTC call UI
  el("btn-blocked-logout")?.addEventListener("click", doLogout);

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
      stopIncomingCallListener();          // ← bersihkan call listener akun lama
      clearHomeTabListeners();
      if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
      if (callState.active) endCall(false); // ← akhiri call aktif jika ganti akun
    }
    lastUid = newUid;

    if (user) {
      startIncomingRequestsListener();
      startIncomingCallListener();         // ← mulai dengar panggilan masuk
      startAccountStatusListener();        // ← deteksi blocked secara realtime
      startNoticesListener();              // ← dengar pemberitahuan admin
    }

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