/* ============================================================
 * Carelink · Capacitor 原生桥接
 * ------------------------------------------------------------
 * 浏览器 / GitHub Pages 里：Capacitor 不存在 → 全部降级为 no-op，
 * 页面行为与纯 PWA 完全一致，不会报错、不会阻塞 SOS 流程。
 * 打包进 Android 后：调用 CustomNativePlugin 的 4 个原生方法。
 *
 * 用法：
 *   await CarelinkNative.makeEmergencyCall('120')
 *   await CarelinkNative.speakPatientInfo('李建国，78 岁，O 型血')
 *   await CarelinkNative.startMaxVolumeLoop('请帮帮我…', 6000)
 *   await CarelinkNative.stopMaxVolumeLoop()
 * ============================================================ */
(function (global) {
  'use strict';

  var PLUGIN_NAME = 'CustomNativePlugin';

  /* ---------------- 环境判断 ---------------- */

  function plugin() {
    var cap = global.Capacitor;
    return (cap && cap.Plugins && cap.Plugins[PLUGIN_NAME]) || null;
  }

  function isNative() {
    var cap = global.Capacitor;
    return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  }

  function skipped(method) {
    console.info('[CarelinkNative] 浏览器环境，跳过 ' + method + '()');
    return { mode: 'noop', method: method, reason: 'browser' };
  }

  /* ---------------- 四个原生方法 ---------------- */

  var CarelinkNative = {

    /** 当前是否运行在 Capacitor 原生容器里 */
    available: function () {
      return isNative() && !!plugin();
    },

    /** 直接拨打急救电话；无 CALL_PHONE 权限时原生侧自动降级为拨号盘 */
    makeEmergencyCall: function (phoneNumber) {
      var p = plugin();
      if (!p) return Promise.resolve(skipped('makeEmergencyCall'));
      return Promise.resolve(p.makeEmergencyCall({ phoneNumber: String(phoneNumber || '') }));
    },

    /** 用系统 TTS 播报老人信息 */
    speakPatientInfo: function (text) {
      var p = plugin();
      if (!p) return Promise.resolve(skipped('speakPatientInfo'));
      return Promise.resolve(p.speakPatientInfo({ text: String(text || '') }));
    },

    /** 拉满闹钟音量 + 保持唤醒 + 循环播报求助语音 */
    startMaxVolumeLoop: function (text, intervalMs) {
      var p = plugin();
      if (!p) return Promise.resolve(skipped('startMaxVolumeLoop'));
      return Promise.resolve(p.startMaxVolumeLoop({
        text: String(text || ''),
        intervalMs: intervalMs || 6000
      }));
    },

    /** 停止循环、恢复原音量、释放唤醒锁 */
    stopMaxVolumeLoop: function () {
      var p = plugin();
      if (!p) return Promise.resolve(skipped('stopMaxVolumeLoop'));
      return Promise.resolve(p.stopMaxVolumeLoop());
    },

    /** 启动 SOS 前台服务：常驻通知 + 唤醒锁，后台保活 */
    startSOSForegroundService: function () {
      var p = plugin();
      if (!p) return Promise.resolve(skipped('startSOSForegroundService'));
      return Promise.resolve(p.startSOSForegroundService());
    },

    /** 停止 SOS 前台服务 */
    stopSOSForegroundService: function () {
      var p = plugin();
      if (!p) return Promise.resolve(skipped('stopSOSForegroundService'));
      return Promise.resolve(p.stopSOSForegroundService());
    }
  };

  global.CarelinkNative = CarelinkNative;

  /* ---------------- 与 SOS 流程对接 ---------------- */

  function appState() {
    return global.__carelinkState || null;
  }

  function profile() {
    try {
      var s = appState();
      return (s && typeof s.profile === 'function' && s.profile()) || {};
    } catch (e) {
      return {};
    }
  }

  function locationAddr() {
    try {
      var s = appState();
      var sos = s && typeof s.sos === 'function' ? s.sos() : null;
      return (sos && sos.loc && sos.loc.addr) || '当前位置';
    } catch (e) {
      return '当前位置';
    }
  }

  function emergencyPhone(p) {
    return p.emergencyPhone || '120';
  }

  /** 按需求模板拼播报文本：患者{姓名}，{年龄}岁，血型{血型}，过敏史{过敏史}，基础病{基础病}。当前位置：{地址}。请立即前往救援。 */
  function speechText(p) {
    var name = p.name || '老人';
    var age = p.age ? p.age : '未知';
    var blood = (p.blood && p.blood !== '未知') ? p.blood : '未知';
    var allergyParts = [];
    if (p.drugAllergy && p.drugAllergy !== '无') allergyParts.push('药物 ' + p.drugAllergy);
    if (p.foodAllergy && p.foodAllergy !== '无') allergyParts.push('食物 ' + p.foodAllergy);
    var allergy = allergyParts.length ? allergyParts.join('；') : '无';
    var history = (Array.isArray(p.history) && p.history.length &&
                   !(p.history.length === 1 && p.history[0] === '无'))
      ? p.history.join('、') : '无';
    return '患者' + name + '，' + age + '岁，血型' + blood +
           '，过敏史' + allergy + '，基础病' + history +
           '。当前位置：' + locationAddr() + '。请立即前往救援。';
  }

  function loopText(p) {
    return '请帮帮我，我叫' + (p.name || '老人') + '，在' + locationAddr() +
           '，请拨打 ' + emergencyPhone(p) + '。';
  }

  /**
   * SOS 阶段进入回调（由 index.html 的 tickSOS 调用）
   * idx: 1=通知监护人 2=拨打急救电话 3=播报老人信息 4=循环播放
   *
   * 流程：2 拨号 → 3 播报 + 同时开始循环（需求：接通后播报并同时循环）
   */
  global.onSOSPhaseEnter = function (idx) {
    if (!CarelinkNative.available()) return;
    var p = profile();
    var T = global.__carelinkText || null;

    if (idx === 1) {
      // 短信通知监护人：不需要配对，只要老人端填了手机号
      var phone = p.guardianPhone || p.contactPhone || '';
      if (phone) {
        var smsBody = T && T.sms ? T.sms() : sosSmsText(p);
        CarelinkNative.sendSosSms(phone, smsBody).then(function (r) {
          if (r && r.sent && global.showToast) global.showToast('已发送求助短信给 ' + phone);
        }).catch(function (err) {
          console.warn('[SMS] 发送失败', err);
          if (global.showToast) global.showToast('短信发送失败：' + (err && err.message ? err.message : err));
        });
      } else if (global.showToast) {
        global.showToast('未填写监护人手机号，短信未发送');
      }
    } else if (idx === 2) {
      var dialNumber = emergencyPhone(p);
      if (!dialNumber) {
        if (global.showToast) global.showToast('未填写急救电话');
        return;
      }
      CarelinkNative.makeEmergencyCall(dialNumber).then(function (r) {
        if (global.showToast) {
          global.showToast('正在拨打 ' + (r && r.number ? r.number : dialNumber));
        }
      }).catch(function (err) {
        if (global.showToast) {
          global.showToast('拨号失败：' + (err && err.message ? err.message : err));
        }
      });
    } else if (idx === 3) {
      var speakBody = (T && T.speech) ? T.speech() : speechText(p);
      var loopBody = (T && T.loop) ? T.loop() : loopText(p);
      var lang = (global.__carelinkText && global.__carelinkText.lang) ? global.__carelinkText.lang() : 'zh';
      CarelinkNative.speakPatientInfo(speakBody, lang);
      CarelinkNative.startMaxVolumeLoop(loopBody, 6000);
    }
  };

  /** 短信内容：谁、在哪、什么病、地图链接 */
  function sosSmsText(p) {
    var loc = null;
    try {
      var s = appState();
      loc = s && typeof s.sos === 'function' ? s.sos() : null;
    } catch (e) { }
    var addr = (loc && loc.loc && loc.loc.addr) || '位置获取中';
    var lat = loc && loc.loc ? loc.loc.lat : '';
    var lng = loc && loc.loc ? loc.loc.lng : '';
    var map = (lat && lng) ? ' https://maps.google.com/?q=' + lat + ',' + lng : '';

    var lines = [
      '【Carelink 紧急求助】',
      (p.name || '老人') + (p.age ? '，' + p.age + '岁' : '') + ' 发起 SOS。',
      '位置：' + addr + map,
      '血型：' + ((p.blood && p.blood !== '未知') ? p.blood : '未知'),
      '过敏：' + (p.drugAllergy || '无'),
      '基础病：' + ((Array.isArray(p.history) && p.history.length) ? p.history.join('、') : '无')
    ];
    return lines.join('\n');
  }

  /** 反向地理编码（原生 Geocoder），浏览器里返回坐标文本 */
  CarelinkNative.reverseGeocode = function (lat, lng) {
    var p = plugin();
    if (!p) {
      return Promise.resolve({
        address: Number(lat).toFixed(5) + ', ' + Number(lng).toFixed(5),
        resolved: false,
        lat: lat, lng: lng
      });
    }
    return Promise.resolve(p.reverseGeocode({ lat: lat, lng: lng }));
  };

  /** 取 FCM token（仅原生有效） */
  CarelinkNative.getFcmToken = function () {
    var p = plugin();
    if (!p) return Promise.resolve({ mode: 'noop', method: 'getFcmToken' });
    return Promise.resolve(p.getFcmToken());
  };

  /** 取极光 registrationId（仅原生有效） */
  CarelinkNative.getPushToken = function () {
    var p = plugin();
    if (!p) return Promise.resolve({ mode: 'noop', method: 'getPushToken' });
    return Promise.resolve(p.getPushToken());
  };

  /** 发短信给监护人（仅原生有效，浏览器里 no-op） */
  CarelinkNative.sendSosSms = function (phoneNumber, text) {
    var p = plugin();
    if (!p) return Promise.resolve(skipped('sendSosSms'));
    return Promise.resolve(p.sendSosSms({ phoneNumber: String(phoneNumber || ''), text: String(text || '') }));
  };

  /** 一次性申请电话/短信/定位/通知权限（系统会连续弹 4 次） */
  CarelinkNative.requestAllPermissions = function () {
    var p = plugin();
    if (!p) return Promise.resolve({ mode: 'noop' });
    return Promise.resolve(p.requestAllPermissions());
  };

  /** 查询四个权限的当前状态 */
  CarelinkNative.checkPermissions = function () {
    var p = plugin();
    if (!p) return Promise.resolve({ mode: 'noop' });
    return Promise.resolve(p.checkPermissions());
  };

  /** 只申请仍然缺失的权限 */
  CarelinkNative.requestMissingPermissions = function () {
    var p = plugin();
    if (!p) return Promise.resolve({ mode: 'noop', allGranted: true });
    return Promise.resolve(p.requestMissingPermissions());
  };

  /** 跳到本应用系统设置页 */
  CarelinkNative.openAppSettings = function () {
    var p = plugin();
    if (!p) return Promise.resolve({ mode: 'noop' });
    return Promise.resolve(p.openAppSettings());
  };

  /**
   * SOS 启动回调（由 index.html 的 openSOS / restoreSOS 调用）
   * 立刻拉起前台服务，保证退到后台后进程和唤醒锁还在。
   */
  global.onSOSStart = function () {
    if (!CarelinkNative.available()) return;
    CarelinkNative.startSOSForegroundService().catch(function (err) {
      console.warn('[CarelinkNative] 启动前台服务失败', err);
    });
  };

  /** SOS 结束回调（取消 / 停止循环时由 endSOS 调用） */
  global.onSOSEnd = function () {
    if (!CarelinkNative.available()) return;
    CarelinkNative.stopMaxVolumeLoop();
    CarelinkNative.stopSOSForegroundService();
  };

})(window);
