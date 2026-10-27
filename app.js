const $ = (id) => document.getElementById(id);
const player = $('player'), list = $('list'), now = $('now'), seek = $('seek');
const playBtn = $('play'), statusEl = $('status'), emptyMsg = $('empty');
const SILENCE = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

// Icons (drawn with SVG, no emoji)
const ICON = {
  play: '<svg viewBox="0 0 24 24" class="size-7" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" class="size-7" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
  loop: '<svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
  loopOne: '<svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/></svg>',
  close: '<svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
};

let songs = [], index = -1, shuffle = false, loopMode = 0; // loop: 0 off, 1 all, 2 one
let peer = null, conn = null, isHost = false, pending = null;

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
    li.onclick = () => playSong(i);
    li.append(name, del);
    list.appendChild(li);
  });
}

// ---------- Playback ----------
function playLocal(i) {
  if (!songs[i]) return;
  index = i;
  if (player.dataset.url) URL.revokeObjectURL(player.dataset.url);
  player.dataset.url = URL.createObjectURL(songs[i].blob);
  player.src = player.dataset.url;
  player.play();
  now.textContent = title(songs[i]);
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: title(songs[i]), artist: 'Gym Music' });
  refresh();
}
function playSong(i) {           // you chose a song: play it here and tell your friend
  playLocal(i);
  send({ t: 'play', name: songs[i].name });
}
function next() {
  if (!songs.length) return;
  playSong(shuffle ? Math.floor(Math.random() * songs.length) : (index + 1) % songs.length);
}
function prev() {
  if (!songs.length) return;
  if (player.currentTime > 3) { player.currentTime = 0; send({ t: 'seek', time: 0 }); return; }
  playSong((index - 1 + songs.length) % songs.length);
}
function toggle() {
  if (index < 0) return playSong(0);
  if (player.paused) { player.play(); send({ t: 'resume', time: player.currentTime }); }
  else { player.pause(); send({ t: 'pause', time: player.currentTime }); }
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
  if (conn && !isHost) return;   // when connected, only the host picks the next song
  if (loopMode === 1 || shuffle || index < songs.length - 1) next();
};
seek.oninput = () => { if (player.duration) player.currentTime = (seek.value / 100) * player.duration; };
seek.onchange = () => send({ t: 'seek', time: player.currentTime });

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
// Fine-tune if your earphones are slower or faster than your friend's
$('ahead').onclick = () => { player.currentTime += 0.05; };
$('back').onclick = () => { player.currentTime = Math.max(0, player.currentTime - 0.05); };

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', toggle);
  navigator.mediaSession.setActionHandler('pause', toggle);
  navigator.mediaSession.setActionHandler('nexttrack', next);
  navigator.mediaSession.setActionHandler('previoustrack', prev);
}

// ---------- Listen together ----------
const setStatus = (t) => { statusEl.textContent = t; };
function send(msg) { if (conn && conn.open) conn.send(msg); }

async function onMessage(m) {
  if (m.t === 'play') {
    const i = songs.findIndex((s) => s.name === m.name);
    if (i >= 0) playLocal(i);
    else { pending = m.name; setStatus('Receiving “' + m.name + '” from your friend...'); send({ t: 'need', name: m.name }); }
  } else if (m.t === 'need') {
    const s = songs.find((x) => x.name === m.name);
    if (s) send({ t: 'file', name: s.name, type: s.blob.type, data: await s.blob.arrayBuffer() });
  } else if (m.t === 'file') {
    await saveSong(new File([m.data], m.name, { type: m.type || 'audio/mpeg' }));
    await refresh();
    if (pending === m.name) {
      pending = null;
      playLocal(songs.findIndex((s) => s.name === m.name));
      setStatus('Connected');
      send({ t: 'sync' });       // ask where the other phone is in the song
    }
  } else if (m.t === 'sync') {
    send({ t: 'seek', time: player.currentTime });
  } else if (m.t === 'pause') {
    player.pause(); player.currentTime = m.time;
  } else if (m.t === 'resume') {
    player.currentTime = m.time; player.play();
  } else if (m.t === 'seek') {
    player.currentTime = m.time;
  }
}

function wire(c) {
  conn = c;
  const ready = () => setStatus('Connected. Pick a song and play.');
  if (c.open) ready(); else c.on('open', ready);
  c.on('data', onMessage);
  c.on('close', () => { conn = null; setStatus('Friend disconnected.'); });
}

// iOS only allows sound after a tap, so unlock audio when the person taps Start/Join
function unlock() {
  player.src = SILENCE;
  player.play().then(() => player.pause()).catch(() => {});
}

$('start').onclick = () => {
  unlock();
  if (peer) peer.destroy();
  isHost = true;
  const code = String(Math.floor(1000 + Math.random() * 9000));
  peer = new Peer('gymmusic-' + code);
  peer.on('open', () => setStatus('Your code is ' + code + '. Tell your friend to join.'));
  peer.on('connection', wire);
  peer.on('error', (e) => setStatus('Error: ' + e.type + '. Tap Start session to try again.'));
};

$('join').onclick = () => {
  const code = $('code').value.trim();
  if (code.length !== 4) return setStatus('Enter the 4-digit code first.');
  unlock();
  if (peer) peer.destroy();
  isHost = false;
  setStatus('Connecting...');
  peer = new Peer();
  peer.on('open', () => wire(peer.connect('gymmusic-' + code, { reliable: true })));
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