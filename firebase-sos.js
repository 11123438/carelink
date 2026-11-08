/* ============================================================
 * Carelink · 双设备 SOS 云端同步（Firebase compat SDK）
 * ------------------------------------------------------------
 * 老人端：匿名登录 → 写 sos_events → 调 sendGuardianPush
 * 监护人端：匿名登录 → 把 FCM token 写进 users/{uid}.fcmToken
 *
 * 设计原则：全部失败静默。断网 / 未配置 / SDK 加载失败时，
 * 本地 SOS 流程（倒计时、拨号、播报、循环）照常运行。
 * ============================================================ */
(function (global) {
  'use strict';

  // 来自 android/app/google-services.json（公开信息，不是密钥）
  var CONFIG = {
    apiKey: 'AIzaSyC1VOq0GAnfjrfK1wtwfOA6S9OrDN3yQdY',
    authDomain: 'carelink-8b9a9.firebaseapp.com',
    projectId: 'carelink-8b9a9',
    storageBucket: 'carelink-8b9a9.firebasestorage.app',
    messagingSenderId: '72895598193',
    appId: '1:72895598193:android:5da49d105db04f6a6815d0'
  };

  var app = null, auth = null, db = null, fns = null;
  var uid = null;
  var initPromise = null;

  // 部署 Worker 后把地址填在这里，例如：
  // https://carelink-sos-push.your-name.workers.dev
  var WORKER_URL = 'https://carelink-sos-push.carelink-gba.workers.dev';

  function sdkReady() {
    return !!(global.firebase && global.firebase.initializeApp);
  }

  function init() {
    if (initPromise) return initPromise;
    initPromise = new Promise(function (resolve) {
      if (!sdkReady()) { resolve(false); return; }
      try {
        app = global.firebase.apps && global.firebase.apps.length
          ? global.firebase.app()
          : global.firebase.initializeApp(CONFIG);
        auth = global.firebase.auth();
        db = global.firebase.firestore();
        fns = global.firebase.functions('asia-east2');

        auth.signInAnonymously()
          .then(function (cred) { uid = cred.user.uid; resolve(true); })
          .catch(function (err) {
            console.warn('[CarelinkCloud] 匿名登录失败', err && err.message);
            resolve(false);
          });
      } catch (e) {
        console.warn('[CarelinkCloud] 初始化失败', e && e.message);
        resolve(false);
      }
    });
    return initPromise;
  }

  /** 触发监护人推送：优先 Cloudflare Worker，未配置地址时回退 Cloud Functions */
  function notifyGuardians(eventId) {
    if (WORKER_URL) {
      return auth.currentUser.getIdToken().then(function (idToken) {
        var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
        return fetch(WORKER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: eventId, idToken: idToken }),
          signal: ctrl ? ctrl.signal : undefined
        }).then(function (r) { return r.json(); })
          .then(function (res) {
            console.log('[CarelinkCloud] Worker 推送结果', res);
            return res;
          })
          .finally(function () { if (timer) clearTimeout(timer); });
      });
    }
    var call = fns.httpsCallable('sendGuardianPush');
    return call({ eventId: eventId }).then(function (res) { return res.data; });
  }

  /** 老人端：写一条 SOS 事件并触发推送 */
  function reportSOS(info) {
    return init().then(function (ok) {
      if (!ok) return null;
      var doc = {
        elderUid: uid,
        timestamp: global.firebase.firestore.FieldValue.serverTimestamp(),
        lat: info.lat,
        lng: info.lng,
        address: info.address || '',
        status: 'active'
      };
      return db.collection('sos_events').add(doc).then(function (ref) {
        console.log('[CarelinkCloud] SOS 已写入', ref.id);
        notifyGuardians(ref.id).catch(function (err) {
          console.warn('[CarelinkCloud] 推送失败', err && err.message);
        });
        return ref.id;
      });
    }).catch(function (err) {
      console.warn('[CarelinkCloud] 写入失败', err && err.message);
      return null;
    });
  }

  /** 监护人端：登记 FCM token */
  function saveGuardianToken(token, role, linkedElderUid) {
    return init().then(function (ok) {
      if (!ok || !token) return false;
      return db.collection('users').doc(uid).set({
        uid: uid,
        role: role || 'guardian',
        linkedElderUid: linkedElderUid || null,
        fcmToken: token,
        updatedAt: global.firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).then(function () {
        console.log('[CarelinkCloud] token 已登记');
        return true;
      });
    }).catch(function (err) {
      console.warn('[CarelinkCloud] token 登记失败', err && err.message);
      return false;
    });
  }

  /** 定位回填后更新事件坐标 */
  function updateSOS(eventId, info) {
    if (!eventId) return Promise.resolve(false);
    return init().then(function (ok) {
      if (!ok) return false;
      return db.collection('sos_events').doc(eventId).update({
        lat: info.lat,
        lng: info.lng,
        address: info.address || ''
      }).then(function () { return true; });
    }).catch(function () { return false; });
  }

  /** 监护人端：登记极光 registrationId */
  function saveGuardianPushId(registrationId, role, linkedElderUid) {
    return init().then(function (ok) {
      if (!ok || !registrationId) return false;
      return db.collection('users').doc(uid).set({
        uid: uid,
        role: role || 'guardian',
        linkedElderUid: linkedElderUid || null,
        jpushId: registrationId,
        updatedAt: global.firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).then(function () {
        console.log('[CarelinkCloud] 极光 registrationId 已登记');
        return true;
      });
    }).catch(function (err) {
      console.warn('[CarelinkCloud] registrationId 登记失败', err && err.message);
      return false;
    });
  }

  /** 老人端：生成 6 位配对码（10 分钟有效） */
  function createPairCode() {
    return init().then(function (ok) {
      if (!ok) return null;
      var code = String(Math.floor(100000 + Math.random() * 900000));
      return db.collection('pair_codes').doc(code).set({
        elderUid: uid,
        createdAt: global.firebase.firestore.FieldValue.serverTimestamp(),
        expiresAt: Date.now() + 10 * 60 * 1000
      }).then(function () { return code; });
    }).catch(function (err) {
      console.warn('[CarelinkCloud] 生成配对码失败', err && err.message);
      return null;
    });
  }

  /** 监护人端：输入配对码，绑定到对应老人 */
  function linkByPairCode(code) {
    return init().then(function (ok) {
      if (!ok) return { ok: false, reason: 'init' };
      return db.collection('pair_codes').doc(String(code)).get().then(function (snap) {
        if (!snap.exists) return { ok: false, reason: 'code_not_found' };
        var d = snap.data();
        if (d.expiresAt && Date.now() > d.expiresAt) return { ok: false, reason: 'expired' };
        if (d.elderUid === uid) return { ok: false, reason: 'self' };
        return db.collection('users').doc(uid).set({
          uid: uid,
          role: 'guardian',
          linkedElderUid: d.elderUid,
          updatedAt: global.firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true }).then(function () {
          return { ok: true, elderUid: d.elderUid };
        });
      });
    }).catch(function (err) {
      return { ok: false, reason: String(err && err.message) };
    });
  }

  global.CarelinkCloud = {
    ready: function () { return init().then(function (ok) { return ok; }); },
    uid: function () { return uid; },
    reportSOS: reportSOS,
    updateSOS: updateSOS,
    saveGuardianToken: saveGuardianToken,
    saveGuardianPushId: saveGuardianPushId,
    createPairCode: createPairCode,
    linkByPairCode: linkByPairCode
  };
})(window);
