const { spawn: realSpawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { resolveSafe } = require('./media-library');

const EXT_PLAYERS = {
  '.mp3': [{ bin: 'mpg123', args: (file) => [file] }],
  '.wav': [{ bin: 'ffplay', args: (file) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', file] },
           { bin: 'aplay', args: (file) => [file] }],
  '.ogg': [{ bin: 'ffplay', args: (file) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', file] },
           { bin: 'aplay', args: (file) => [file] }],
};

function defaultExistsBinary(bin) {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function detectPlayers(existsBinary) {
  const resolved = {};
  for (const [ext, candidates] of Object.entries(EXT_PLAYERS)) {
    resolved[ext] = candidates.find(c => existsBinary(c.bin)) || null;
  }
  return resolved;
}

function createAudioPlayer({ mediaRoot, eventStore, spawn = realSpawn, exec = execSync, existsBinary = defaultExistsBinary }) {
  const players = detectPlayers(existsBinary);
  let musicChild = null;
  let musicRef = null;
  const effectChildren = new Set();
  let volume = 0.5;

  function record(type, subject, detail) {
    try { eventStore.record({ source: 'audio', type, subject, detail }); } catch {}
  }

  function resolveRef(ref) {
    try { return { full: resolveSafe(mediaRoot, ref), ext: path.extname(ref).toLowerCase() }; }
    catch { return null; }
  }

  async function spawnFor(ref, channel) {
    const resolved = resolveRef(ref);
    if (!resolved) { record('audio-error', ref, { channel, reason: 'bad-path' }); return null; }
    if (!fs.existsSync(resolved.full)) { record('audio-error', ref, { channel, reason: 'missing-file' }); return null; }
    const player = players[resolved.ext];
    if (!player) { record('audio-unavailable', ref, { channel, ext: resolved.ext }); return null; }
    let child;
    try {
      child = spawn(player.bin, player.args(resolved.full), { stdio: 'ignore' });
    } catch (err) {
      record('audio-error', ref, { channel, reason: 'spawn-failed', error: String(err) });
      return null;
    }
    record('audio-play', ref, { channel });
    return child;
  }

  async function playEffect(ref) {
    const child = await spawnFor(ref, 'effect');
    if (!child) return;
    effectChildren.add(child);
    child.on('exit', () => effectChildren.delete(child));
    child.on('error', () => effectChildren.delete(child));
  }

  async function playMusic(ref, { loop = true } = {}) {
    void loop; // looping is a player-arg concern folded into future extension; mpg123/-loop handled by caller args if ever needed
    stopMusic();
    const child = await spawnFor(ref, 'music');
    if (!child) { musicChild = null; musicRef = null; return; }
    musicChild = child;
    musicRef = ref;
    child.on('exit', () => { if (musicChild === child) { musicChild = null; musicRef = null; } });
    child.on('error', () => { if (musicChild === child) { musicChild = null; musicRef = null; } });
  }

  function stopMusic() {
    if (musicChild) {
      try { musicChild.kill(); } catch {}
      record('audio-stop', musicRef, { channel: 'music' });
      musicChild = null;
      musicRef = null;
    }
  }

  function stopAll() {
    stopMusic();
    const effectCount = effectChildren.size;
    for (const child of effectChildren) {
      try { child.kill(); } catch {}
    }
    if (effectCount) record('audio-stop', null, { channel: 'effect', count: effectCount });
    effectChildren.clear();
  }

  function setVolume(v) {
    const n = Number(v);
    const clamped = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : volume;
    volume = clamped;
    try { exec(`amixer set Master ${Math.round(clamped * 100)}%`, { stdio: 'ignore' }); }
    catch { record('audio-unavailable', null, { channel: 'volume' }); }
    return clamped;
  }

  function now() {
    return { music: musicRef, effects: effectChildren.size, volume };
  }

  return { playEffect, playMusic, stopMusic, stopAll, setVolume, now };
}

module.exports = { createAudioPlayer };
