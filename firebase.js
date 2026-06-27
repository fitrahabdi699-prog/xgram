import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js";
import { getAuth }       from "https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js";
import { getFirestore }  from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { getStorage }    from "https://www.gstatic.com/firebasejs/10.14.0/firebase-storage.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);

export const auth    = getAuth(app);
export const db      = getFirestore(app);
export const storage = getStorage(app);

