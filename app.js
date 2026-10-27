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
      if (i === index) { player.pause(); now.textContent = 'Nothing playing'; index = -1; }
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
  if (player.dataset.url) URL.revokeObjectURL(player.dataset.url);
  player.dataset.url = URL.createObjectURL(songs[i].blob);
  player.src = player.dataset.url;
  if (ctx) ctx.resume();
  player.play();
  now.textContent = title(songs[i]);
  send({ t: 'now', title: title(songs[i]) });
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: title(songs[i]), artist: 'Gym Music' });
  refresh();
}
function next() {
  if (!songs.length) return;
  playLocal(shuffle ? Math.floor(Math.random() * songs.length) : (index + 1) % songs.length);
}
function prev() {
  if (!songs.length) return;
  if (player.currentTime > 3) { player.currentTime = 0; return; }
  playLocal((index - 1 + songs.length) % songs.length);
}
function toggle() {
  if (index < 0) return playLocal(0);
  if (ctx) ctx.resume();
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
  if (index < 0) return;
  if (loopMode === 2) { player.currentTime = 0; player.play(); return; }
  if (loopMode === 1 || shuffle || index < songs.length - 1) next();
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

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', toggle);
  navigator.mediaSession.setActionHandler('pause', toggle);
  navigator.mediaSession.setActionHandler('nexttrack', next);
  navigator.mediaSession.setActionHandler('previoustrack', prev);
}

// ---------- Listen together ----------
const setStatus = (t) => { statusEl.textContent = t; };
function send(msg) { if (conn && conn.open) conn.send(msg); }

function setGuestMode(on) {
  $('addlabel').classList.toggle('hidden', on);
  $('library').classList.toggle('hidden', on);
  $('hostctl').classList.toggle('hidden', on);
  $('guestmsg').classList.toggle('hidden', !on);
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
  source.connect(delayNode);
  delayNode.connect(ctx.destination);   // what you hear (delayed)
  source.connect(streamDest);           // what your friend hears (live)

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

function wire(c) {
  conn = c;
  const ready = () => {
    if (isHost) {
      setStatus('Friend connected. Pick a song and play.');
      if (index >= 0) send({ t: 'now', title: title(songs[index]) });
      const call = peer.call(c.peer, streamDest.stream, { sdpTransform: musicSdp });
      call.on('error', (e) => setStatus('Audio error: ' + e));
    } else {
      setStatus('Connected. Waiting for audio...');
      setGuestMode(true);
    }
  };
  if (c.open) ready(); else c.on('open', ready);
  c.on('data', (m) => { if (m.t === 'now') now.textContent = m.title; });
  c.on('close', () => {
    conn = null;
    setStatus(isHost ? 'Friend disconnected.' : 'Host left the session.');
    if (!isHost) setGuestMode(false);
  });
}

// iOS only allows sound after a tap, so unlock audio when the person taps Start/Join
function unlock(el) {
  el.src = SILENCE;
  el.play().then(() => el.pause()).catch(() => {});
}

$('start').onclick = () => {
  setupHostAudio();
  unlock(player);
  if (peer) peer.destroy();
  isHost = true;
  const code = String(Math.floor(1000 + Math.random() * 9000));
  peer = new Peer('gymmusic-' + code, PEER_OPTIONS);
  peer.on('open', () => setStatus('Your code is ' + code + '. Tell your friend to join.'));
  peer.on('connection', (c) => {
    setStatus('Friend found. Setting up the link...');
    c.on('iceStateChanged', (s) => setStatus('Link check: ' + s));
    wire(c);
  });
  peer.on('error', (e) => setStatus('Error: ' + e.type + '. Tap Start session to try again.'));
};

$('join').onclick = () => {
  const code = $('code').value.trim();
  if (code.length !== 4) return setStatus('Enter the 4-digit code first.');
  unlock(remote);
  if (peer) peer.destroy();
  isHost = false;
  setStatus('Step 1 of 3: reaching the connection service...');
  peer = new Peer(undefined, PEER_OPTIONS);

  setTimeout(() => {
    if (!peer.open) setStatus('Step 1 failed: cannot reach the connection service. Check your signal and try again.');
  }, 10000);

  peer.on('open', () => {
    setStatus('Step 2 of 3: looking for your friend...');
    const c = peer.connect('gymmusic-' + code, { reliable: true });
    c.on('iceStateChanged', (s) => setStatus('Step 3 of 3: link check: ' + s));
    wire(c);
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

if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
refresh();