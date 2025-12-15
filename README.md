# Couple Calendar Check-In — EASY SETUP (no code editing)

This folder is **everything** for the website. Upload it to GitHub and you can replace the whole folder any time.

## What you do (simple)
1) Create Firebase project (free tier)
2) Enable: Anonymous Auth + Firestore + Storage
3) Open your website’s **setup page** and paste:
   - Firebase config (copy/paste)
   - Room ID (a “secret key”)
4) Copy/paste the provided Firebase rules (no coding)

---

# A) Upload website to GitHub Pages
1. Create a GitHub repo
2. Upload ALL files from this folder
3. Repo Settings → Pages → Deploy from branch → `main` / root
4. Open:
   - `.../setup.html` (first time)
   - then `.../index.html` (the app)

---

# B) Create Firebase
Firebase Console:
1. Create a project
2. Authentication → Sign-in method → enable **Anonymous**
3. Firestore Database → Create database → **Production mode**
4. Storage → Get started

---

# C) Setup page (no code editing)
Open:
`https://YOURNAME.github.io/YOURREPO/setup.html`

In Firebase Console → Project settings → Your apps → Web app:
- Copy the config object (apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId)
- Paste it into the setup page and click **Save settings**
- Put the SAME Room ID as your rules below

### Suggested Room ID (use this)
couple-2369c22e01fd

---

# D) Paste Rules into Firebase

## Firestore rules
Firestore → Rules → paste:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {

      function okRoom() {
        return request.auth != null && roomId == "couple-2369c22e01fd";
      }

      match /days/{dayId} {
        allow read, write: if okRoom();
      }
    }
  }
}
```

## Storage rules
Storage → Rules → paste:

```txt
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /rooms/{roomId}/{role}/{dayId}/{fileName} {
      allow read, write: if request.auth != null
        && roomId == "couple-2369c22e01fd"
        && (role == "husband" || role == "wife");
    }
  }
}
```

---

# Use it
1) Open `index.html` on both phones  
2) Select Husband/Wife  
3) Tap a date → take a photo  
4) You’ll both see each other’s photos

If you see “permission issue”, it’s almost always because the Room ID in rules doesn’t match the Room ID in setup.
