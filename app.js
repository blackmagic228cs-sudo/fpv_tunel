'use strict';

/* ============================================================
   FPV-камера — трансляция с телефона на ПК/второй телефон.
   Видео: WebRTC (напрямую между устройствами).
   Сигнализация: публичный PeerJS Cloud.
   Никакого управления моторами и прошивок — только видео.
   ============================================================ */

const APP_PREFIX = 'fpvcar-v1';
const ROOM_LEN = 5;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const QUALITIES = {
  '360p20': { w: 640, h: 360, fps: 20, bitrate: 700000 },
  '480p24': { w: 640, h: 480, fps: 24, bitrate: 1200000 },
  '720p24': { w: 1280, h: 720, fps: 24, bitrate: 2000000 },
  '720p30': { w: 1280, h: 720, fps: 30, bitrate: 2600000 },
};

const PEER_OPTIONS = {
  debug: 0,
  config: {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:global.stun.twilio.com:3478' },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp',
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ],
  },
};

const $ = (id) => document.getElementById(id);

const state = {
  view: 'landing',
  role: null,
  room: '',
  peer: null,
  conn: null,
  call: null,
  stream: null,
  cam: {
    starting: false,
    peerOpen: false,
    idAttempts: 0,
    statsTimer: null,
    reconnectTimer: null,
    lastStats: null,
    wakeLock: null,
  },
  viewer: {
    peerOpen: false,
    connecting: false,
    reconnectTimer: null,
    statsTimer: null,
    lastStats: null,
    videoPlaying: false,
  },
};

/* ---------- Утилиты ---------- */

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function normalizeRoom(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_LEN);
}

function randomRoom() {
  const bytes = new Uint8Array(ROOM_LEN);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  return out;
}

function roomFromUrl() {
  return normalizeRoom(new URLSearchParams(location.search).get('room'));
}

function camPeerId(room) {
  return `${APP_PREFIX}-${room.toLowerCase()}-cam`;
}

function setUrl(mode, room) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  if (mode) {
    url.searchParams.set('mode', mode);
    if (room) url.searchParams.set('room', room);
  }
  history.replaceState(null, '', url.pathname + url.search);
}

const store = {
  get(key, fallback = '') {
    try {
      const value = localStorage.getItem('fpv.' + key);
      return value === null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('fpv.' + key, value);
    } catch (_) {
      /* приватный режим */
    }
  },
};

let toastTimer = null;
function toast(message, kind = '') {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
}

function showView(name) {
  state.view = name;
  document.querySelectorAll('.view').forEach((view) => {
    view.hidden = view.id !== 'view-' + name;
  });
  document.body.classList.toggle('is-viewer', name === 'viewer');
  window.scrollTo(0, 0);
}

/* ---------- Навигация ---------- */

function enterCamera(room) {
  state.role = 'cam';
  state.room = normalizeRoom(room) || randomRoom();
  store.set('lastRoom', state.room);
  setUrl('cam', state.room);
  state.cam.idAttempts = 0;

  $('cam-room').textContent = state.room;
  $('cam-room-big').textContent = state.room;
  updateCamLink();

  showView('camera');
  refreshCamStatus();
  initCameraPeer();
}

function enterViewer(room) {
  const normalized = normalizeRoom(room);
  if (normalized.length !== ROOM_LEN) {
    toast('Введите код комнаты из 5 символов', 'error');
    $('landing-room').focus();
    return;
  }

  state.role = 'viewer';
  state.room = normalized;
  store.set('lastRoom', normalized);
  setUrl('view', normalized);
  $('viewer-room').textContent = normalized;

  showView('viewer');
  resetViewerUi();
  initViewerPeer();
}

function exitToLanding() {
  if (state.role === 'cam') {
    stopBroadcast();
    destroyPeer();
    state.cam.peerOpen = false;
    clearCamReconnect();
  } else if (state.role === 'viewer') {
    teardownViewer();
  }

  state.role = null;
  setUrl(null, null);
  $('landing-room').value = store.get('lastRoom', '');
  showView('landing');
}

/* ---------- Камера: PeerJS ---------- */

function destroyPeer() {
  if (state.call) {
    try { state.call.close(); } catch (_) {}
    state.call = null;
  }
  if (state.conn) {
    try { state.conn.close(); } catch (_) {}
    state.conn = null;
  }
  if (state.peer) {
    try { state.peer.destroy(); } catch (_) {}
    state.peer = null;
  }
}

function initCameraPeer() {
  if (typeof Peer === 'undefined') {
    setCamStatus('Не загрузился PeerJS. Проверьте интернет и обновите страницу.', 'error');
    return;
  }

  destroyPeer();
  state.cam.peerOpen = false;
  refreshCamStatus();

  const peer = new Peer(camPeerId(state.room), PEER_OPTIONS);
  state.peer = peer;

  peer.on('open', () => {
    if (state.peer !== peer) return;
    state.cam.peerOpen = true;
    state.cam.idAttempts = 0;
    clearCamReconnect();
    refreshCamStatus();
  });

  peer.on('connection', (conn) => {
    if (state.peer !== peer) return;
    onCameraConnection(conn);
  });

  peer.on('error', (err) => {
    if (state.peer !== peer) return;
    onCameraPeerError(err, peer);
  });

  peer.on('disconnected', () => {
    if (state.peer !== peer) return;
    state.cam.peerOpen = false;
    refreshCamStatus();
    scheduleCamReconnect();
  });
}

function onCameraPeerError(err, peer) {
  const type = err && err.type ? err.type : '';
  console.warn('PeerJS (камера):', type, err);

  if (type === 'unavailable-id') {
    if (state.cam.idAttempts < 2) {
      state.cam.idAttempts += 1;
      setCamStatus('Код комнаты ещё занят, пробуем снова…', 'wait');
      setTimeout(() => {
        if (state.role === 'cam' && state.peer === peer) initCameraPeer();
      }, 1500);
    } else {
      state.cam.idAttempts = 0;
      state.room = randomRoom();
      store.set('lastRoom', state.room);
      setUrl('cam', state.room);
      $('cam-room').textContent = state.room;
      $('cam-room-big').textContent = state.room;
      updateCamLink();
      toast('Старый код освободить не удалось — создан новый: ' + state.room, 'error');
      initCameraPeer();
    }
    return;
  }

  if (['network', 'server-error', 'socket-error', 'socket-closed', 'ssl-unavailable'].includes(type)) {
    state.cam.peerOpen = false;
    setCamStatus('Нет связи с сигнальным сервером. Проверьте интернет.', 'error');
    scheduleCamReconnect();
    return;
  }

  if (type === 'browser-incompatible') {
    setCamStatus('Браузер не поддерживает WebRTC. Попробуйте Chrome или Safari.', 'error');
  }
}

function clearCamReconnect() {
  clearTimeout(state.cam.reconnectTimer);
  state.cam.reconnectTimer = null;
}

function scheduleCamReconnect() {
  if (state.role !== 'cam') return;
  clearCamReconnect();
  state.cam.reconnectTimer = setTimeout(() => {
    state.cam.reconnectTimer = null;
    if (state.role !== 'cam') return;

    const peer = state.peer;
    if (!peer || peer.destroyed) {
      initCameraPeer();
      return;
    }
    if (peer.disconnected) {
      try { peer.reconnect(); } catch (_) {}
    }
    setTimeout(() => {
      if (state.role !== 'cam' || state.peer !== peer) return;
      if (!peer || peer.destroyed) {
        initCameraPeer();
        return;
      }
      if (peer.open) {
        state.cam.peerOpen = true;
        refreshCamStatus();
      } else {
        scheduleCamReconnect();
      }
    }, 1800);
  }, 1800);
}

function onCameraConnection(conn) {
  if (state.conn && state.conn !== conn) {
    try { state.conn.close(); } catch (_) {}
  }
  state.conn = conn;

  const handleOpen = () => {
    if (state.conn !== conn) return;
    refreshCamStatus();
    if (state.stream) startCameraCall();
  };

  conn.on('open', handleOpen);
  conn.on('close', () => {
    if (state.conn !== conn) return;
    state.conn = null;
    if (state.call) {
      try { state.call.close(); } catch (_) {}
      state.call = null;
    }
    stopCamStats();
    setCamStats('');
    refreshCamStatus();
  });
  conn.on('error', (err) => {
    console.warn('DataConnection (камера):', err);
  });

  if (conn.open) handleOpen();
}

function startCameraCall() {
  const peer = state.peer;
  const conn = state.conn;
  if (!peer || peer.destroyed || !peer.open || !conn || !conn.open || !state.stream) return;

  if (state.call) {
    try { state.call.close(); } catch (_) {}
    state.call = null;
  }

  let call;
  try {
    call = peer.call(conn.peer, state.stream);
  } catch (err) {
    console.warn('Не удалось отправить видео экрану:', err);
    return;
  }
  if (!call) return;

  state.call = call;
  call.on('close', () => {
    if (state.call !== call) return;
    state.call = null;
    stopCamStats();
    setCamStats(state.stream ? 'Ожидаем экран' : '');

    // Если связь с экраном осталась, но медиаканал закрылся — пробуем ещё раз.
    if (state.stream && state.conn && state.conn.open) {
      setTimeout(() => {
        if (state.role === 'cam' && state.stream && state.conn && state.conn.open && !state.call) {
          startCameraCall();
        }
      }, 1500);
    }
  });
  call.on('error', (err) => console.warn('MediaConnection (камера):', err));

  setTimeout(() => tuneVideoSender(call), 700);
  setTimeout(() => tuneVideoSender(call), 2200);
  startCamStats();
}

function tuneVideoSender(call) {
  try {
    const pc = call && call.peerConnection;
    if (!pc) return;
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) return;

    const quality = currentQuality();
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = quality.bitrate;
    params.encodings[0].maxFramerate = quality.fps;
    params.degradationPreference = 'maintain-framerate';
    sender.setParameters(params).catch(() => {});
  } catch (_) {
    /* некоторые браузеры не дают менять параметры */
  }
}

function refreshCamStatus() {
  if (state.role !== 'cam') return;

  const connected = !!(state.conn && state.conn.open);
  const signaling = !!(state.peer && !state.peer.destroyed && state.cam.peerOpen);

  if (state.stream) {
    if (connected) setCamStatus('В эфире · экран на связи', 'live');
    else if (signaling) setCamStatus('В эфире · ждём экран', 'warn');
    else setCamStatus('В эфире · нет сигнального сервера', 'warn');
    return;
  }

  if (!signaling) {
    setCamStatus('Подключение к сигнальному серверу…', 'wait');
    return;
  }

  setCamStatus(connected ? 'Экран на связи · включите камеру' : 'Готово · ждём экран', connected ? 'ready' : 'idle');
}

function setCamStatus(text, stateName) {
  const pill = $('cam-status');
  if (!pill) return;
  pill.dataset.state = stateName || 'idle';
  $('cam-status-text').textContent = text;
}

/* ---------- Камера: видео ---------- */

function currentQuality() {
  return QUALITIES[$('cam-quality').value] || QUALITIES['480p24'];
}

async function getUserMediaStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const error = new Error('no-media');
    error.name = 'NotSupportedError';
    throw error;
  }

  const quality = currentQuality();
  const facing = $('cam-facing').value;
  const withAudio = $('cam-mic').checked;

  const video = {
    facingMode: facing === 'user' ? { ideal: 'user' } : { ideal: 'environment' },
    width: { ideal: quality.w },
    height: { ideal: quality.h },
    frameRate: { ideal: quality.fps, max: quality.fps },
  };
  const audio = withAudio
    ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    : false;

  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio });
  } catch (err) {
    if (err && (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError')) {
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: withAudio });
    }
    throw err;
  }
}

function mediaErrorText(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Доступ к камере запрещён. Разрешите камеру в настройках браузера и обновите страницу.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'Камера не найдена.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Камера занята другим приложением. Закройте его и попробуйте снова.';
  }
  if (name === 'OverconstrainedError') {
    return 'Камера не поддерживает выбранное качество. Попробуйте 360p.';
  }
  if (name === 'NotSupportedError') {
    return 'Браузер не поддерживает доступ к камере. Откройте сайт в Chrome или Safari.';
  }
  return 'Не удалось включить камеру: ' + ((err && (err.message || err.name)) || 'неизвестная ошибка');
}

async function startBroadcast() {
  if (state.cam.starting || state.stream) return;

  if (!window.isSecureContext) {
    toast('Камера работает только по HTTPS. Откройте сайт через GitHub Pages.', 'error');
    return;
  }

  state.cam.starting = true;
  updateCameraButtons();
  setCamStatus('Включаем камеру…', 'wait');

  try {
    const stream = await getUserMediaStream();
    state.stream = stream;

    const preview = $('cam-preview');
    preview.srcObject = stream;
    preview.play().catch(() => {});
    $('cam-placeholder').hidden = true;

    updateCameraButtons();
    refreshCamStatus();
    if (state.conn && state.conn.open) startCameraCall();
    startCamStats();
    await requestWakeLock();
    toast('Трансляция началась', 'ok');
  } catch (err) {
    console.error('getUserMedia:', err);
    const message = mediaErrorText(err);
    setCamStatus(message, 'error');
    toast(message, 'error');
  } finally {
    state.cam.starting = false;
    updateCameraButtons();
  }
}

function stopBroadcast() {
  if (state.call) {
    try { state.call.close(); } catch (_) {}
    state.call = null;
  }
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }

  const preview = $('cam-preview');
  if (preview) preview.srcObject = null;
  const placeholder = $('cam-placeholder');
  if (placeholder) placeholder.hidden = false;

  stopCamStats();
  setCamStats('');
  releaseWakeLock();
  updateCameraButtons();
  if (state.role === 'cam') refreshCamStatus();
}

async function restartBroadcast() {
  if (!state.stream) return;
  stopBroadcast();
  await startBroadcast();
}

function updateCameraButtons() {
  const start = $('cam-start');
  const stop = $('cam-stop');
  if (!start || !stop) return;

  const live = !!state.stream;
  start.hidden = live || state.cam.starting;
  stop.hidden = !live;
  start.disabled = state.cam.starting;
  stop.disabled = state.cam.starting;
  start.textContent = state.cam.starting ? 'Включаем камеру…' : 'Начать трансляцию';
}

function startCamStats() {
  stopCamStats();
  state.cam.lastStats = null;
  state.cam.statsTimer = setInterval(camStatsTick, 1000);
  camStatsTick();
}

function stopCamStats() {
  clearInterval(state.cam.statsTimer);
  state.cam.statsTimer = null;
  state.cam.lastStats = null;
}

async function camStatsTick() {
  const call = state.call;
  if (!call || !call.peerConnection) {
    setCamStats(state.stream ? 'Ожидаем экран' : '');
    return;
  }

  try {
    const report = await call.peerConnection.getStats();
    let outbound = null;
    report.forEach((item) => {
      if (item.type === 'outbound-rtp' && (item.kind === 'video' || item.mediaType === 'video') && !item.isRemote) {
        outbound = item;
      }
    });
    if (!outbound) return;

    const now = performance.now();
    const previous = state.cam.lastStats;
    let kbps = null;
    if (previous && typeof outbound.bytesSent === 'number') {
      const seconds = (now - previous.t) / 1000;
      if (seconds > 0) kbps = Math.max(0, ((outbound.bytesSent - previous.bytes) * 8) / 1000 / seconds);
    }
    state.cam.lastStats = { t: now, bytes: outbound.bytesSent || 0 };

    const parts = [];
    if (outbound.frameWidth) parts.push(`${outbound.frameWidth}×${outbound.frameHeight}`);
    if (typeof outbound.framesPerSecond === 'number') parts.push(`${Math.round(outbound.framesPerSecond)} fps`);
    if (kbps !== null) parts.push(`${Math.round(kbps)} кбит/с`);
    setCamStats(parts.join(' · ') || 'В эфире');
  } catch (_) {
    /* статистика не критична */
  }
}

function setCamStats(text) {
  const el = $('cam-stats');
  if (el) el.textContent = text;
}

function updateCamLink() {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('mode', 'view');
  url.searchParams.set('room', state.room);
  const link = url.href;

  $('cam-link').value = link;

  const qr = $('cam-qr');
  if (qr) {
    qr.hidden = false;
    qr.src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=10&data=' + encodeURIComponent(link);
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Ссылка скопирована', 'ok');
    return;
  } catch (_) {
    /* fallback ниже */
  }
  try {
    const input = $('cam-link');
    input.focus();
    input.select();
    document.execCommand('copy');
    toast('Ссылка скопирована', 'ok');
  } catch (_) {
    toast('Не удалось скопировать. Выделите ссылку вручную.', 'error');
  }
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || !state.stream) return;
  try {
    state.cam.wakeLock = await navigator.wakeLock.request('screen');
    state.cam.wakeLock.addEventListener('release', () => {
      state.cam.wakeLock = null;
    });
  } catch (_) {
    /* не поддерживается или запрещено */
  }
}

async function releaseWakeLock() {
  if (!state.cam.wakeLock) return;
  try { await state.cam.wakeLock.release(); } catch (_) {}
  state.cam.wakeLock = null;
}

/* ---------- Экран: PeerJS ---------- */

function teardownViewerPeer() {
  clearViewerReconnect();
  if (state.conn) {
    const conn = state.conn;
    state.conn = null;
    try { conn.close(); } catch (_) {}
  }
  if (state.call) {
    const call = state.call;
    state.call = null;
    try { call.close(); } catch (_) {}
  }
  if (state.peer) {
    const peer = state.peer;
    state.peer = null;
    try { peer.destroy(); } catch (_) {}
  }
  state.viewer.peerOpen = false;
  state.viewer.connecting = false;
}

function initViewerPeer() {
  if (typeof Peer === 'undefined') {
    showViewerWaiting(
      'Не загрузился PeerJS',
      'Проверьте интернет и обновите страницу. Без библиотеки сигнализации видео не установить.',
      { spinner: false, retry: true }
    );
    return;
  }

  closeViewerCall();
  teardownViewerPeer();
  setViewerLink(false);
  showViewerWaiting('Подключаемся…', `Ищем камеру в комнате ${state.room}.`, { spinner: true });

  const peer = new Peer(PEER_OPTIONS);
  state.peer = peer;

  peer.on('open', () => {
    if (state.peer !== peer) return;
    state.viewer.peerOpen = true;
    connectToCamera();
  });

  peer.on('call', (call) => {
    if (state.peer !== peer) return;
    onViewerCall(call);
  });

  peer.on('error', (err) => {
    if (state.peer !== peer) return;
    onViewerPeerError(err);
  });

  peer.on('disconnected', () => {
    if (state.peer !== peer) return;
    state.viewer.peerOpen = false;
    if (!state.conn || !state.conn.open) setViewerLink(false);
    scheduleViewerReconnect(1500);
  });
}

function connectToCamera() {
  const peer = state.peer;
  if (state.role !== 'viewer' || !peer || peer.destroyed) return;

  if (!state.viewer.peerOpen || !peer.open) {
    scheduleViewerReconnect(2000);
    return;
  }
  if (state.conn && (state.conn.open || state.viewer.connecting)) return;

  clearViewerReconnect();
  state.viewer.connecting = true;
  if (!state.viewer.videoPlaying) {
    showViewerWaiting('Подключаемся…', `Ищем камеру в комнате ${state.room}.`, { spinner: true });
  }

  let conn;
  try {
    conn = peer.connect(camPeerId(state.room), {
      reliable: true,
      serialization: 'json',
      metadata: { role: 'viewer' },
    });
  } catch (err) {
    console.warn('Не удалось подключиться к камере:', err);
    state.viewer.connecting = false;
    scheduleViewerReconnect(2000);
    return;
  }

  state.conn = conn;
  const openTimer = setTimeout(() => {
    if (state.conn === conn && !conn.open) {
      state.conn = null;
      state.viewer.connecting = false;
      try { conn.close(); } catch (_) {}
      scheduleViewerReconnect(2000);
    }
  }, 10000);

  conn.on('open', () => {
    clearTimeout(openTimer);
    if (state.conn !== conn) return;
    state.viewer.connecting = false;
    setViewerLink(true);
    if (!state.viewer.videoPlaying) {
      showViewerWaiting(
        'Ожидание видео…',
        'Экран подключён. На телефоне нажмите «Начать трансляцию».',
        { spinner: true }
      );
    }
  });

  conn.on('data', () => {
    /* данные не используются: канал нужен только для связи и переподключения */
  });

  conn.on('close', () => {
    clearTimeout(openTimer);
    if (state.conn !== conn) return;
    state.conn = null;
    state.viewer.connecting = false;
    setViewerLink(false);
    closeViewerCall();
    if (state.role !== 'viewer') return;
    showViewerWaiting(
      'Нет связи с камерой',
      'Проверьте, что страница камеры открыта и телефон в сети. Пробуем переподключиться…',
      { spinner: true, retry: true }
    );
    scheduleViewerReconnect(2500);
  });

  conn.on('error', (err) => {
    console.warn('DataConnection (экран):', err);
  });
}

function onViewerCall(call) {
  if (state.call && state.call !== call) {
    const previous = state.call;
    state.call = null;
    try { previous.close(); } catch (_) {}
  }

  state.call = call;
  try {
    call.answer();
  } catch (err) {
    console.warn('Не удалось принять видеозвонок:', err);
  }

  call.on('stream', (stream) => {
    if (state.call !== call) return;
    attachViewerStream(call, stream);
  });

  call.on('close', () => {
    if (state.call !== call) return;
    state.call = null;
    onViewerCallClosed();
  });

  call.on('error', (err) => {
    console.warn('MediaConnection (экран):', err);
  });
}

function attachViewerStream(call, stream) {
  const video = $('viewer-video');
  video.srcObject = stream;
  video.muted = true;
  updateSoundButton(stream);

  video.play().then(() => {
    if (state.call !== call) return;
    state.viewer.videoPlaying = true;
    hideViewerWaiting();
    tuneViewerReceiver(call);
    startViewerStats();
    if (state.conn && state.conn.open) setViewerLink(true);
  }).catch((err) => {
    console.warn('Автовоспроизведение заблокировано:', err);
    showViewerWaiting(
      'Нажмите, чтобы включить видео',
      'Браузер заблокировал автоматический запуск. Коснитесь экрана.',
      { spinner: false }
    );
  });
}

function tryResumeVideo() {
  const video = $('viewer-video');
  if (!video.srcObject) return;
  video.play().then(() => {
    state.viewer.videoPlaying = true;
    hideViewerWaiting();
    if (state.call) {
      tuneViewerReceiver(state.call);
      startViewerStats();
    }
  }).catch(() => {});
}

function onViewerCallClosed() {
  state.viewer.videoPlaying = false;
  stopViewerStats();
  const video = $('viewer-video');
  if (video) {
    video.srcObject = null;
    video.muted = true;
  }
  const sound = $('viewer-sound');
  if (sound) sound.hidden = true;
  resetViewerHud();

  if (state.role !== 'viewer') return;
  if (state.conn && state.conn.open) {
    showViewerWaiting(
      'Трансляция остановлена',
      'На телефоне остановили камеру. Ждём, когда её снова включат…',
      { spinner: true }
    );
  } else {
    showViewerWaiting(
      'Нет видео',
      'Камера не транслирует. Пробуем подключиться заново…',
      { spinner: true, retry: true }
    );
  }
}

function closeViewerCall() {
  const call = state.call;
  state.call = null;
  if (call) {
    try { call.close(); } catch (_) {}
  }
  state.viewer.videoPlaying = false;
  stopViewerStats();
  const video = $('viewer-video');
  if (video) {
    video.srcObject = null;
    video.muted = true;
  }
  const sound = $('viewer-sound');
  if (sound) sound.hidden = true;
  resetViewerHud();
}

function tuneViewerReceiver(call) {
  const video = $('viewer-video');
  try { video.playoutDelayHint = 0; } catch (_) {}
  try {
    const pc = call && call.peerConnection;
    if (!pc) return;
    const receiver = pc.getReceivers().find((r) => r.track && r.track.kind === 'video');
    if (receiver && 'jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
  } catch (_) {
    /* необязательная оптимизация */
  }
}

function onViewerPeerError(err) {
  const type = err && err.type ? err.type : '';
  console.warn('PeerJS (экран):', type, err);

  if (type === 'peer-unavailable') {
    state.viewer.connecting = false;
    if (state.conn) {
      const conn = state.conn;
      state.conn = null;
      try { conn.close(); } catch (_) {}
    }
    setViewerLink(false);
    if (!state.viewer.videoPlaying) {
      showViewerWaiting(
        'Камера не найдена',
        `Убедитесь, что на телефоне открыта комната ${state.room} и нажата кнопка «Начать трансляцию». Пробуем снова…`,
        { spinner: true, retry: true }
      );
    }
    scheduleViewerReconnect(2500);
    return;
  }

  if (['network', 'server-error', 'socket-error', 'socket-closed', 'ssl-unavailable'].includes(type)) {
    state.viewer.peerOpen = false;
    if (!state.conn || !state.conn.open) setViewerLink(false);
    if (!state.viewer.videoPlaying) {
      showViewerWaiting(
        'Нет связи с сигнальным сервером',
        'Проверьте интернет на этом устройстве. Переподключаемся…',
        { spinner: true, retry: true }
      );
    }
    scheduleViewerReconnect(3000);
    return;
  }

  if (type === 'unavailable-id') {
    initViewerPeer();
    return;
  }

  if (type === 'browser-incompatible') {
    showViewerWaiting(
      'Браузер не поддерживает WebRTC',
      'Откройте сайт в современном Chrome, Edge, Firefox или Safari.',
      { spinner: false }
    );
  }
}

function clearViewerReconnect() {
  clearTimeout(state.viewer.reconnectTimer);
  state.viewer.reconnectTimer = null;
}

function scheduleViewerReconnect(delay = 2500) {
  if (state.role !== 'viewer') return;
  clearViewerReconnect();
  state.viewer.reconnectTimer = setTimeout(() => {
    state.viewer.reconnectTimer = null;
    if (state.role !== 'viewer') return;

    const peer = state.peer;
    if (!peer || peer.destroyed) {
      initViewerPeer();
      return;
    }

    if (!peer.open) {
      if (peer.disconnected) {
        try { peer.reconnect(); } catch (_) {}
      }
      setTimeout(() => {
        if (state.role !== 'viewer' || state.peer !== peer) return;
        if (!peer || peer.destroyed) {
          initViewerPeer();
          return;
        }
        if (peer.open) {
          state.viewer.peerOpen = true;
          connectToCamera();
        } else {
          scheduleViewerReconnect(2500);
        }
      }, 1800);
      return;
    }

    state.viewer.peerOpen = true;
    if (!state.conn || !state.conn.open) connectToCamera();
  }, delay);
}

function reconnectNow() {
  if (state.role !== 'viewer') return;

  clearViewerReconnect();
  if (state.conn) {
    const conn = state.conn;
    state.conn = null;
    try { conn.close(); } catch (_) {}
  }
  closeViewerCall();
  state.viewer.connecting = false;
  setViewerLink(false);
  showViewerWaiting('Подключаемся…', `Ищем камеру в комнате ${state.room}.`, { spinner: true });

  if (!state.peer || state.peer.destroyed) {
    initViewerPeer();
    return;
  }
  if (!state.peer.open) {
    if (state.peer.disconnected) {
      try { state.peer.reconnect(); } catch (_) {}
    }
    scheduleViewerReconnect(1200);
    return;
  }
  state.viewer.peerOpen = true;
  connectToCamera();
}

function setViewerLink(connected) {
  const pill = $('viewer-link-state');
  if (!pill) return;
  pill.dataset.state = connected ? 'live' : 'off';
  $('viewer-link-text').textContent = connected ? 'на связи' : 'нет связи';
}

function showViewerWaiting(title, text, options = {}) {
  const overlay = $('viewer-waiting');
  if (!overlay) return;
  if (!title) {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  $('viewer-wait-title').textContent = title;
  $('viewer-wait-text').textContent = text || '';
  $('viewer-wait-spinner').hidden = !options.spinner;
  $('viewer-retry').hidden = !options.retry;
}

function hideViewerWaiting() {
  const overlay = $('viewer-waiting');
  if (overlay) overlay.hidden = true;
}

function resetViewerUi() {
  closeViewerCall();
  state.viewer.lastStats = null;
  setViewerLink(false);
  const video = $('viewer-video');
  video.muted = true;
  video.srcObject = null;
  $('viewer-sound').hidden = true;
  resetViewerHud();
  showViewerWaiting('Подключаемся…', `Ищем камеру в комнате ${state.room}.`, { spinner: true });
}

function teardownViewer() {
  clearViewerReconnect();
  stopViewerStats();
  closeViewerCall();
  teardownViewerPeer();
}

function resetViewerHud() {
  $('hud-res').textContent = '—';
  $('hud-fps').textContent = '—';
  $('hud-bitrate').textContent = '—';
}

function startViewerStats() {
  stopViewerStats();
  state.viewer.lastStats = null;
  state.viewer.statsTimer = setInterval(viewerStatsTick, 1000);
  viewerStatsTick();
}

function stopViewerStats() {
  clearInterval(state.viewer.statsTimer);
  state.viewer.statsTimer = null;
  state.viewer.lastStats = null;
}

async function viewerStatsTick() {
  const call = state.call;
  if (!call || !call.peerConnection) return;

  try {
    const report = await call.peerConnection.getStats();
    let inbound = null;
    report.forEach((item) => {
      if (item.type === 'inbound-rtp' && (item.kind === 'video' || item.mediaType === 'video') && !item.isRemote) {
        inbound = item;
      }
    });
    if (!inbound) return;

    const now = performance.now();
    const previous = state.viewer.lastStats;
    let kbps = null;
    let fps = inbound.framesPerSecond;
    if (previous) {
      const seconds = (now - previous.t) / 1000;
      if (seconds > 0) {
        if (typeof inbound.bytesReceived === 'number') {
          kbps = Math.max(0, ((inbound.bytesReceived - previous.bytes) * 8) / 1000 / seconds);
        }
        if (typeof fps !== 'number' && typeof inbound.framesDecoded === 'number') {
          fps = Math.max(0, (inbound.framesDecoded - previous.frames) / seconds);
        }
      }
    }
    state.viewer.lastStats = {
      t: now,
      bytes: inbound.bytesReceived || 0,
      frames: inbound.framesDecoded || 0,
    };

    $('hud-res').textContent = inbound.frameWidth ? `${inbound.frameWidth}×${inbound.frameHeight}` : '—';
    $('hud-fps').textContent = typeof fps === 'number' ? `${Math.round(fps)} fps` : '—';
    $('hud-bitrate').textContent = kbps !== null ? `${Math.round(kbps)} кбит/с` : '—';
  } catch (_) {
    /* статистика не критична */
  }
}

function updateSoundButton(stream) {
  const button = $('viewer-sound');
  if (!button) return;
  const hasAudio = !!(stream && stream.getAudioTracks().some((track) => track.readyState === 'live'));
  button.hidden = !hasAudio;
  if (!hasAudio) {
    $('viewer-video').muted = true;
    return;
  }
  $('viewer-video').muted = true;
  button.textContent = '🔇';
  button.title = 'Включить звук';
}

function toggleFullscreen() {
  const stage = $('viewer-stage');
  const video = $('viewer-video');

  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }

  const request = stage.requestFullscreen || stage.webkitRequestFullscreen;
  if (request) {
    Promise.resolve(request.call(stage)).catch(() => {
      toast('Полноэкранный режим недоступен в этом браузере', 'error');
    });
    return;
  }

  if (video.webkitEnterFullscreen) {
    video.webkitEnterFullscreen();
  } else {
    toast('Полноэкранный режим недоступен в этом браузере', 'error');
  }
}

function updateFullscreenButton() {
  const button = $('viewer-fullscreen');
  if (!button) return;
  const active = !!document.fullscreenElement;
  button.textContent = active ? '⤢' : '⛶';
  button.title = active ? 'Выйти из полноэкранного режима' : 'На весь экран';
  button.setAttribute('aria-label', button.title);
}

/* ---------- События интерфейса ---------- */

function bindLanding() {
  $('btn-role-cam').addEventListener('click', () => enterCamera(randomRoom()));
  $('btn-role-viewer').addEventListener('click', () => enterViewer($('landing-room').value));
  $('landing-room').addEventListener('input', (event) => {
    event.target.value = normalizeRoom(event.target.value);
  });
  $('landing-room').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      enterViewer(event.target.value);
    }
  });
}

function bindCamera() {
  $('cam-start').addEventListener('click', startBroadcast);
  $('cam-stop').addEventListener('click', stopBroadcast);
  $('cam-exit').addEventListener('click', exitToLanding);
  $('cam-copy').addEventListener('click', () => copyText($('cam-link').value));
  $('cam-qr').addEventListener('load', () => { $('cam-qr').hidden = false; });
  $('cam-qr').addEventListener('error', () => { $('cam-qr').hidden = true; });

  const restartIfLive = () => {
    if (state.stream) restartBroadcast();
  };
  $('cam-quality').addEventListener('change', restartIfLive);
  $('cam-facing').addEventListener('change', restartIfLive);
  $('cam-mic').addEventListener('change', restartIfLive);
}

function bindViewer() {
  $('viewer-exit').addEventListener('click', exitToLanding);
  $('viewer-retry').addEventListener('click', (event) => {
    event.stopPropagation();
    reconnectNow();
  });
  $('viewer-fullscreen').addEventListener('click', toggleFullscreen);
  $('viewer-video').addEventListener('click', tryResumeVideo);
  $('viewer-waiting').addEventListener('click', tryResumeVideo);

  $('viewer-sound').addEventListener('click', () => {
    const video = $('viewer-video');
    if (!video.srcObject) return;
    video.muted = !video.muted;
    $('viewer-sound').textContent = video.muted ? '🔇' : '🔊';
    $('viewer-sound').title = video.muted ? 'Включить звук' : 'Выключить звук';
    if (!video.muted) video.play().catch(() => {});
  });

  document.addEventListener('fullscreenchange', updateFullscreenButton);
}

function bindGlobal() {
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return; // страница уходит в bfcache — не рвём трансляцию
    if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
    destroyPeer();
  });

  document.addEventListener('visibilitychange', () => {
    if (state.role !== 'cam' || !state.stream) return;
    if (document.visibilityState === 'visible') {
      if (!state.cam.wakeLock) requestWakeLock();
    } else {
      releaseWakeLock();
    }
  });
}

/* ---------- Старт ---------- */

function init() {
  bindLanding();
  bindCamera();
  bindViewer();
  bindGlobal();

  const params = new URLSearchParams(location.search);
  const mode = params.get('mode');
  const room = roomFromUrl();

  $('landing-room').value = store.get('lastRoom', '');

  if (mode === 'cam') {
    enterCamera(room || store.get('lastRoom', '') || randomRoom());
  } else if (mode === 'view') {
    if (room.length === ROOM_LEN) {
      enterViewer(room);
    } else {
      showView('landing');
      if (room) $('landing-room').value = room;
    }
  } else {
    showView('landing');
  }
}

init();
