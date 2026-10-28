// ===== YOUR SETTINGS =====
// Paste your NEW Google key between the quotes. The folder ID is already filled in.
const DRIVE_KEY = 'AIzaSyDkbcBEC6VGpx_AVZ5mA6rTjueXeYly4r4';
const DRIVE_FOLDER = '1TZeXtpfhbAp4cyWqEcu2-l__sW4phEIp';
// =========================

const $ = (id) => document.getElementById(id);
const player = $('player'), remote = $('remote'), list = $('list'), now = $('now'), seek = $('seek');
const playBtn = $('play'), statusEl = $('status'), emptyMsg = $('empty');
const SILENCE = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

// ---------- Pause-glitch fixes ----------
// Fix 2 switch: leave false first. If the glitch after pausing is still there
// after Fix 1, change this to true. It sends a tiny inaudible tone to your
// friend only, so the stream never goes fully silent.
const KEEP_ALIVE_TONE = false;

// Fix 1: tell the audio engine this is music, not a phone call
// (no silence-saving mode, stereo, higher quality).
function musicSdp(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!m) return sdp;
  const pt = m[1];
  const params = 'minptime=10;useinbandfec=1;usedtx=0;stereo=1;sprop-stereo=1;maxaveragebitrate=128000';
  const line = new RegExp('a=fmtp:' + pt + ' [^\\r\\n]*');
  return line.test(sdp) ? sdp.replace(line, 'a=fmtp:' + pt + ' ' + params) : sdp;
}

// Relay servers: they connect the two phones when cellular networks block direct links
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:global.relay.metered.ca:80', username: '2d13b11c777ed832f36508d8', credential: 'rMPG82aBxmp77mmf' },
  { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: '2d13b11c777ed832f36508d8', credential: 'rMPG82aBxmp77mmf' },
  { urls: 'turn:global.relay.metered.ca:443', username: '2d13b11c777ed832f36508d8', credential: 'rMPG82aBxmp77mmf' },
  { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: '2d13b11c777ed832f36508d8', credential: 'rMPG82aBxmp77mmf' },
];
const PEER_OPTIONS = { config: { iceServers: ICE_SERVERS } };

// Needed so audio from Google Drive can be passed on to friends
player.crossOrigin = 'anonymous';

const ICON = {
  play: '<svg viewBox="0 0 24 24" class="size-7" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" class="size-7" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
  loop: '<svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
  loopOne: '<svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/></svg>',
  close: '<svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
};

let songs = [], index = -1, shuffle = false, loopMode = 0; // loop: 0 off, 1 all, 2 one
let peer = null, conn = null, isHost = false;
let ctx = null, delayNode = null, streamDest = null, delayMs = 0;
let guests = new Map();            // host only: everyone listening right now
let sessionCode = '', lastEvent = '', pingTimer = null, watchTimer = null;
let leftByMe = false, hostEnded = false;
let gainNode = null, hostVol = 1;   // host's own volume (does not change what friends hear)
let results = [], mode = 'local', driveIndex = -1, hasTrack = false;   // Drive music state (mode is 'local' or 'drive')
let nowLabel = '';   // what is playing, sent to friends who join late

// ---------- Storage (stays on this phone) ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('gym-music', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('songs', { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveSong(file) {
  const db = await openDB();
  return new Promise((r) => { const tx = db.transaction('songs', 'readwrite'); tx.objectStore('songs').put({ name: file.name, blob: file }); tx.oncomplete = r; });
}
async function deleteSong(name) {
  const db = await openDB();
  return new Promise((r) => { const tx = db.transaction('songs', 'readwrite'); tx.objectStore('songs').delete(name); tx.oncomplete = r; });
}
async function loadSongs() {
  const db = await openDB();
  return new Promise((r) => { db.transaction('songs').objectStore('songs').getAll().onsuccess = (e) => r(e.target.result); });
}

// ---------- Song list ----------
const title = (s) => s.name.replace(/\.[^.]+$/, '');

async function refresh() {
  const current = songs[index] && songs[index].name;
  songs = await loadSongs();
  index = songs.findIndex((s) => s.name === current);
  list.innerHTML = '';
  emptyMsg.style.display = songs.length ? 'none' : 'block';
  songs.forEach((song, i) => {
    const li = document.createElement('li');
    li.className = 'flex cursor-pointer items-center gap-3 rounded-xl border-b border-[#2b313b] px-2.5 py-3.5' + (i === index ? ' bg-[#1e232b]' : '');
    const name = document.createElement('span');
    name.className = 'flex-1 truncate text-[15px]' + (i === index ? ' text-[#6f8dff]' : '');
    name.textContent = title(song);
    const del = document.createElement('button');
    del.className = 'p-2 text-[#8d96a3] hover:text-red-400';
    del.innerHTML = ICON.close;
    del.setAttribute('aria-label', 'Delete song');
    del.onclick = async (e) => {
      e.stopPropagation();
      await deleteSong(song.name);
      if (i === index) { player.pause(); now.textContent = 'Nothing playing'; index = -1; hasTrack = false; }
      refresh();
    };
    li.onclick = () => playLocal(i);
    li.append(name, del);
    list.appendChild(li);
  });
}

// ---------- Playback (host) ----------
function playLocal(i) {
  if (!songs[i]) return;
  index = i;
  mode = 'local'; driveIndex = -1; hasTrack = true;
  renderResults();
  if (player.dataset.url) URL.revokeObjectURL(player.dataset.url);
  player.dataset.url = URL.createObjectURL(songs[i].blob);
  player.src = player.dataset.url;
  setupHostAudio();
  player.play();
  nowLabel = title(songs[i]);
  now.textContent = nowLabel;
  send({ t: 'now', title: nowLabel });
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: title(songs[i]), artist: 'Gym Music' });
  refresh();
}
function next() {
  if (mode === 'drive') {
    if (!results.length) return;
    return playDrive(shuffle ? Math.floor(Math.random() * results.length) : (driveIndex + 1) % results.length);
  }
  if (!songs.length) return;
  playLocal(shuffle ? Math.floor(Math.random() * songs.length) : (index + 1) % songs.length);
}
function prev() {
  if (player.currentTime > 3) { player.currentTime = 0; return; }
  if (mode === 'drive') {
    if (!results.length) return;
    return playDrive((driveIndex - 1 + results.length) % results.length);
  }
  if (!songs.length) return;
  playLocal((index - 1 + songs.length) % songs.length);
}
function toggle() {
  if (!hasTrack) return playLocal(0);
  setupHostAudio();
  player.paused ? player.play() : player.pause();
}
const fmt = (s) => isFinite(s) ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : '0:00';

player.onplay = () => playBtn.innerHTML = ICON.pause;
player.onpause = () => playBtn.innerHTML = ICON.play;
player.ontimeupdate = () => {
  seek.value = player.duration ? (player.currentTime / player.duration) * 100 : 0;
  $('cur').textContent = fmt(player.currentTime);
  $('dur').textContent = fmt(player.duration);
};
player.onended = () => {
  if (!hasTrack) return;
  if (mode === 'drive' && driveIndex < 0) return;
  if (mode === 'local' && index < 0) return;
  if (loopMode === 2) { player.currentTime = 0; player.play(); return; }
  const last = mode === 'drive' ? driveIndex >= results.length - 1 : index >= songs.length - 1;
  if (loopMode === 1 || shuffle || !last) next();
};
player.onplaying = () => { if (mode === 'drive') setOn('Playing from Google Drive.'); };
player.onerror = () => {
  if (!hasTrack) return;
  if (mode === 'drive') setOn("Couldn't play this song from Drive. Wait a moment and try again, or tap another song.");
  else setStatus("Couldn't play this file.");
};
seek.oninput = () => { if (player.duration) player.currentTime = (seek.value / 100) * player.duration; };

function setActive(btn, on) {
  btn.classList.toggle('text-[#6f8dff]', on);
  btn.classList.toggle('text-[#8d96a3]', !on);
}
playBtn.onclick = toggle; $('next').onclick = next; $('prev').onclick = prev;
$('shuffle').onclick = (e) => { shuffle = !shuffle; setActive(e.currentTarget, shuffle); };
$('loop').onclick = (e) => {
  loopMode = (loopMode + 1) % 3;
  e.currentTarget.innerHTML = loopMode === 2 ? ICON.loopOne : ICON.loop;
  setActive(e.currentTarget, loopMode > 0);
};

// Delay only YOUR sound, so it lines up with your friend's (who gets the stream a bit later)
function setDelay(ms) {
  delayMs = Math.max(0, Math.min(1000, ms));
  if (delayNode) delayNode.delayTime.value = delayMs / 1000;
  $('delayval').textContent = delayMs + ' ms';
}
$('more').onclick = () => setDelay(delayMs + 50);
$('less').onclick = () => setDelay(delayMs - 50);

// ---------- Volume (each person controls only their own) ----------
const curve = (pct) => Math.pow(pct / 100, 2);   // feels smoother than a straight line
function loadVol(k) {
  try { const v = parseInt(localStorage.getItem(k), 10); return isNaN(v) ? 100 : Math.max(0, Math.min(100, v)); } catch (e) { return 100; }
}
function saveVol(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

// Host volume: only changes what YOU hear, friends are not affected
$('vol').value = loadVol('gym-vol');
hostVol = curve($('vol').value);
$('volval').textContent = $('vol').value + '%';
$('vol').oninput = () => {
  hostVol = curve($('vol').value);
  if (gainNode) gainNode.gain.value = hostVol;
  $('volval').textContent = $('vol').value + '%';
  saveVol('gym-vol', $('vol').value);
};

// Guest volume: works on laptops and Android. iPhones ignore it (use the volume buttons there).
const volOK = (() => { const a = document.createElement('audio'); a.volume = 0.5; return a.volume === 0.5; })();
$('gvol').value = loadVol('gym-gvol');
$('gvolval').textContent = $('gvol').value + '%';
if (volOK) remote.volume = curve($('gvol').value);
$('gvol').oninput = () => {
  if (volOK) remote.volume = curve($('gvol').value);
  $('gvolval').textContent = $('gvol').value + '%';
  saveVol('gym-gvol', $('gvol').value);
};

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', toggle);
  navigator.mediaSession.setActionHandler('pause', toggle);
  navigator.mediaSession.setActionHandler('nexttrack', next);
  navigator.mediaSession.setActionHandler('previoustrack', prev);
}

// ---------- Drive music (your own Google Drive folder) ----------
const setOn = (t) => { $('onstatus').textContent = t; };
let driveAll = [];       // every song in the Drive folder
let currentUrl = '';     // the Drive song playing right now

const driveUrl = (id) => 'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media&key=' + encodeURIComponent(DRIVE_KEY);

function renderResults() {
  const ul = $('results');
  ul.innerHTML = '';
  results.forEach((t, i) => {
    const active = mode === 'drive' && i === driveIndex;
    const li = document.createElement('li');
    li.className = 'cursor-pointer rounded-xl border-b border-[#2b313b] px-2 py-3' + (active ? ' bg-[#15181e]' : '');
    const a = document.createElement('div');
    a.className = 'truncate text-sm' + (active ? ' text-[#6f8dff]' : '');
    a.textContent = t.title;
    li.append(a);
    li.onclick = () => playDrive(i);
    ul.appendChild(li);
  });
}

function startUrl(url, label) {
  if (player.dataset.url) { URL.revokeObjectURL(player.dataset.url); player.dataset.url = ''; }
  currentUrl = url;
  player.src = url;
  hasTrack = true;
  setupHostAudio();
  player.play().catch(() => {});
  nowLabel = label;
  now.textContent = label;
  send({ t: 'now', title: label });
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: label, artist: 'Gym Music' });
}

function playDrive(i) {
  const t = results[i];
  if (!t) return;
  mode = 'drive'; driveIndex = i; index = -1;
  setOn('Loading...');
  startUrl(t.url, t.title);
  renderResults();
  refresh();
}

function applyFilter() {
  const q = $('q').value.trim().toLowerCase();
  results = driveAll.filter((t) => t.title.toLowerCase().includes(q));
  driveIndex = mode === 'drive' ? results.findIndex((t) => t.url === currentUrl) : -1;
  renderResults();
}

async function loadDrive() {
  if (DRIVE_KEY.startsWith('PASTE')) return setOn('Add your Google key in app.js first (see the instructions).');
  setOn('Loading your Drive folder...');
  try {
    const q = "'" + DRIVE_FOLDER + "' in parents and trashed=false";
    const url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
      '&fields=' + encodeURIComponent('files(id,name,mimeType,size)') +
      '&orderBy=name&pageSize=1000&key=' + encodeURIComponent(DRIVE_KEY);
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
    driveAll = (j.files || [])
      .filter((f) => /^audio\//.test(f.mimeType) || /\.(mp3|m4a|aac|wav|flac|ogg)$/i.test(f.name))
      .map((f) => ({ title: f.name.replace(/\.[^.]+$/, ''), artist: '', url: driveUrl(f.id) }));
    applyFilter();
    setOn(driveAll.length ? driveAll.length + ' song(s) in your Drive folder.' : 'The folder is empty. Add songs to it in Google Drive, then tap Refresh.');
  } catch (e) {
    setOn("Couldn't load Drive: " + e.message);
  }
}

$('q').oninput = applyFilter;
$('refresh').onclick = loadDrive;

// ---------- Listen together ----------
const setStatus = (t) => { statusEl.textContent = t; };
function send(msg) {
  if (isHost) guests.forEach((g) => { if (g.conn.open) g.conn.send(msg); });
  else if (conn && conn.open) conn.send(msg);
}

// ---------- Who is listening (host) ----------
const clock = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function myName() {
  const n = $('name').value.trim().slice(0, 16) || 'Guest';
  try { localStorage.setItem('gym-name', n); } catch (e) {}
  return n;
}
try { $('name').value = localStorage.getItem('gym-name') || ''; } catch (e) {}

function renderListeners() {
  $('listeners').classList.remove('hidden');
  $('end').classList.remove('hidden');
  $('lcount').textContent = guests.size === 1 ? '1 listening' : guests.size + ' listening';
  const ul = $('lnames');
  ul.innerHTML = '';
  guests.forEach((g) => {
    const li = document.createElement('li');
    li.className = 'flex justify-between';
    const a = document.createElement('span'); a.textContent = g.name + (g.note ? ' (' + g.note + ')' : '');
    const b = document.createElement('span'); b.className = 'text-[#8d96a3]'; b.textContent = 'since ' + g.joinedAt;
    li.append(a, b);
    ul.appendChild(li);
  });
  $('lactivity').textContent = lastEvent;
  setStatus('Your code is ' + sessionCode + '. Tell your friends to join.');
}
function logEvent(text) { lastEvent = text + ' at ' + clock(); renderListeners(); }

function addGuest(c, rawName) {
  if (guests.has(c.peer)) return;
  const name = String(rawName || '').trim().slice(0, 16) || 'Guest';
  const call = peer.call(c.peer, streamDest.stream, { sdpTransform: musicSdp });
  call.on('error', (e) => setStatus('Audio error: ' + e));
  guests.set(c.peer, { name, conn: c, call, joinedAt: clock(), lastSeen: Date.now() });
  if (hasTrack && nowLabel) c.send({ t: 'now', title: nowLabel });
  logEvent(name + ' joined');
}
function removeGuest(id, verb) {
  const g = guests.get(id);
  if (!g) return;
  guests.delete(id);
  try { g.call.close(); } catch (e) {}
  try { g.conn.close(); } catch (e) {}
  logEvent(g.name + ' ' + verb);
}

function setGuestMode(on) {
  $('addlabel').classList.toggle('hidden', on);
  $('library').classList.toggle('hidden', on);
  $('hostctl').classList.toggle('hidden', on);
  $('guestmsg').classList.toggle('hidden', !on);
  $('leave').classList.toggle('hidden', !on);
  $('gvolrow').classList.toggle('hidden', !on || !volOK);
  $('guestmsg').textContent = volOK
    ? "Listening to your friend's session. Use the slider to change the volume."
    : "Listening to your friend's session. Use your phone's volume buttons to change the volume.";
  if (on) $('listeners').classList.add('hidden');
  if (on) now.textContent = 'Waiting for your friend to play something';
}

// Host: route the player through Web Audio so we can both hear it and stream it
function setupHostAudio() {
  if (ctx) { ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();
  const source = ctx.createMediaElementSource(player);
  delayNode = ctx.createDelay(1.0);
  delayNode.delayTime.value = delayMs / 1000;
  streamDest = ctx.createMediaStreamDestination();
  gainNode = ctx.createGain();
  gainNode.gain.value = hostVol;
  source.connect(gainNode);
  gainNode.connect(delayNode);
  delayNode.connect(ctx.destination);   // what you hear (volume, then delay)
  source.connect(streamDest);           // what your friend hears (live, not affected by your volume)

  // Fix 2 (optional): a tiny inaudible tone, sent to the stream only, so it never goes fully silent
  if (KEEP_ALIVE_TONE) {
    const keep = ctx.createOscillator();
    const keepGain = ctx.createGain();
    keep.frequency.value = 180;
    keepGain.gain.value = 0.001;
    keep.connect(keepGain);
    keepGain.connect(streamDest);
    keep.start();
  }
  ctx.resume();
}

// Guest side: connect to the host, say our name, and keep pinging so the host knows we are here
function guestWire(c) {
  conn = c;
  const ready = () => {
    setStatus('Connected. Waiting for audio...');
    setGuestMode(true);
    c.send({ t: 'hello', name: myName() });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { if (c.open) c.send({ t: 'ping' }); }, 5000);
  };
  if (c.open) ready(); else c.on('open', ready);
  c.on('data', (m) => {
    if (m.t === 'now') now.textContent = m.title;
    else if (m.t === 'end') hostEnded = true;
  });
  c.on('close', () => {
    if (leftByMe) return;
    conn = null;
    clearInterval(pingTimer);
    remote.pause();
    setStatus(hostEnded ? 'Host ended the session.' : 'Host left the session.');
    setGuestMode(false);
  });
}

// iOS only allows sound after a tap, so unlock audio when the person taps Start/Join
function unlock(el) {
  el.src = SILENCE;
  el.play().then(() => el.pause()).catch(() => {});
}

$('start').onclick = () => {
  setupHostAudio();
  if (!hasTrack) unlock(player);
  if (peer) peer.destroy();
  guests.clear();
  clearInterval(watchTimer);
  isHost = true;
  sessionCode = String(Math.floor(1000 + Math.random() * 9000));
  lastEvent = '';
  peer = new Peer('gymmusic-' + sessionCode, PEER_OPTIONS);
  peer.on('open', () => renderListeners());
  peer.on('connection', (c) => {
    c.on('data', (m) => {
      if (m.t === 'hello') addGuest(c, m.name);
      else if (m.t === 'ping') { const g = guests.get(c.peer); if (g) g.lastSeen = Date.now(); }
      else if (m.t === 'bye') removeGuest(c.peer, 'left');
    });
    c.on('close', () => removeGuest(c.peer, 'left'));
    c.on('error', () => removeGuest(c.peer, 'dropped'));
  });
  peer.on('error', (e) => setStatus('Error: ' + e.type + '. Tap Start session to try again.'));

  // Check each friend's audio link, not just their "still here" pings
  watchTimer = setInterval(() => {
    let changed = false;
    guests.forEach((g, id) => {
      const pc = g.call && g.call.peerConnection;
      const ice = pc ? pc.iceConnectionState : 'new';
      if (ice === 'failed' || ice === 'closed') return removeGuest(id, 'lost connection');
      const linkUp = ice === 'connected' || ice === 'completed';
      const quiet = Date.now() - g.lastSeen > 30000;
      const trouble = !linkUp && (ice === 'disconnected' || quiet);
      if (trouble) { if (!g.troubleSince) g.troubleSince = Date.now(); } else g.troubleSince = null;
      if (g.troubleSince && Date.now() - g.troubleSince > 60000) return removeGuest(id, 'lost connection');
      const note = trouble ? 'not responding' : '';
      if (note !== g.note) { g.note = note; changed = true; }
    });
    if (changed) renderListeners();
  }, 5000);
};

$('join').onclick = () => {
  const code = $('code').value.trim();
  if (code.length !== 4) return setStatus('Enter the 4-digit code first.');
  unlock(remote);
  if (peer) peer.destroy();
  isHost = false;
  leftByMe = false;
  hostEnded = false;
  clearInterval(watchTimer);
  guests.clear();
  setStatus('Step 1 of 3: reaching the connection service...');
  peer = new Peer(undefined, PEER_OPTIONS);

  setTimeout(() => {
    if (!peer.open) setStatus('Step 1 failed: cannot reach the connection service. Check your signal and try again.');
  }, 10000);

  peer.on('open', () => {
    setStatus('Step 2 of 3: looking for your friend...');
    const c = peer.connect('gymmusic-' + code, { reliable: true });
    c.on('iceStateChanged', (s) => setStatus('Step 3 of 3: link check: ' + s));
    guestWire(c);
    setTimeout(() => {
      if (!conn || !conn.open) setStatus('Stuck at the link step. The phones found each other but could not connect directly. The relay may be missing or wrong.');
    }, 20000);
  });

  // The host calls us with the live audio
  peer.on('call', (call) => {
    call.answer(null, { sdpTransform: musicSdp });
    call.on('stream', (stream) => {
      remote.srcObject = stream;
      remote.play().then(() => setStatus('Listening')).catch(() => {
        setStatus('Tap anywhere on the screen to start the sound.');
        document.body.addEventListener('click', () => remote.play(), { once: true });
      });
    });
  });
  peer.on('error', (e) => setStatus('Error: ' + e.type + '. Check the code and try again.'));
};

// File picker: no "accept" filter in the HTML (iOS greys out MP3 with it),
// so we check the file type here instead.
$('picker').onchange = async (e) => {
  const okExt = /\.(mp3|m4a|aac|wav|aiff?|caf|mp4|flac)$/i;
  let skipped = 0;
  for (const f of e.target.files) {
    if (f.type.startsWith('audio/') || okExt.test(f.name)) await saveSong(f);
    else skipped++;
  }
  e.target.value = '';
  if (skipped) setStatus(skipped + ' file(s) skipped because they are not audio.');
  refresh();
};

// Friend taps Leave
$('leave').onclick = () => {
  leftByMe = true;
  try { if (conn && conn.open) conn.send({ t: 'bye' }); } catch (e) {}
  clearInterval(pingTimer);
  setTimeout(() => {
    if (peer) peer.destroy();
    peer = null; conn = null;
    remote.pause(); remote.srcObject = null;
    setGuestMode(false);
    setStatus('You left the session.');
  }, 200);
};

// Host taps End session
$('end').onclick = () => {
  send({ t: 'end' });
  clearInterval(watchTimer);
  setTimeout(() => {
    const all = [...guests.values()];
    guests.clear();
    all.forEach((g) => { try { g.conn.close(); } catch (e) {} });
    if (peer) peer.destroy();
    peer = null;
    $('listeners').classList.add('hidden');
    $('end').classList.add('hidden');
    setStatus('Session ended. Tap Start session for a new one.');
  }, 200);
};

if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
refresh();
loadDrive();