const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createAudioPlayer } = require('../src/audio-player');

function fakeEventStore() {
  const events = [];
  return { events, record: (e) => { events.push(e); return { id: events.length }; } };
}

function fakeChild() {
  const listeners = {};
  return {
    pid: Math.floor(Math.random() * 100000),
    kill: () => { (listeners.exit || []).forEach(cb => cb()); },
    on(evt, cb) { (listeners[evt] = listeners[evt] || []).push(cb); return this; },
  };
}

function makePlayer(overrides = {}) {
  const spawnCalls = [];
  const spawn = overrides.spawn || ((cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return fakeChild(); });
  const existsBinary = overrides.existsBinary || (() => true); // default: every binary "found"
  const exec = overrides.exec || (() => '');
  const eventStore = overrides.eventStore || fakeEventStore();
  const mediaRoot = overrides.mediaRoot || path.join(__dirname, 'fixtures', 'media');
  const player = createAudioPlayer({ mediaRoot, eventStore, spawn, exec, existsBinary });
  return { player, spawnCalls, eventStore, mediaRoot };
}

test('playEffect spawns mpg123 for an mp3 ref under mediaRoot', async () => {
  const { player, spawnCalls } = makePlayer();
  await player.playEffect('global/chime.mp3');
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].cmd, 'mpg123');
});

test('playEffect on a ref that escapes mediaRoot records audio-error and does not spawn', async () => {
  const { player, spawnCalls, eventStore } = makePlayer();
  await player.playEffect('../../etc/passwd.mp3');
  assert.equal(spawnCalls.length, 0);
  assert.ok(eventStore.events.some(e => e.type === 'audio-error'));
});

test('when no binary is found for an extension, playing that extension is a no-op that logs audio-unavailable', async () => {
  const { player, spawnCalls, eventStore } = makePlayer({ existsBinary: () => false });
  await player.playEffect('global/chime.mp3');
  assert.equal(spawnCalls.length, 0);
  assert.ok(eventStore.events.some(e => e.type === 'audio-unavailable'));
});

test('playMusic kills the previous music child before spawning a new one', async () => {
  const killed = [];
  const spawn = () => {
    const c = fakeChild();
    const origKill = c.kill.bind(c);
    c.kill = () => { killed.push(c.pid); origKill(); };
    return c;
  };
  const { player } = makePlayer({ spawn });
  await player.playMusic('global/bed.mp3');
  const firstState = player.now();
  assert.equal(firstState.music, 'global/bed.mp3');
  await player.playMusic('global/win.mp3');
  assert.equal(killed.length, 1);
  assert.equal(player.now().music, 'global/win.mp3');
});

test('stopMusic kills only the music child, leaving effects running', async () => {
  const { player } = makePlayer();
  await player.playMusic('global/bed.mp3');
  await player.playEffect('global/chime.mp3');
  player.stopMusic();
  const state = player.now();
  assert.equal(state.music, null);
  assert.equal(state.effects, 1);
});

test('stopAll kills the music child and every effect child', async () => {
  const { player } = makePlayer();
  await player.playMusic('global/bed.mp3');
  await player.playEffect('global/chime.mp3');
  await player.playEffect('global/chime.mp3');
  player.stopAll();
  const state = player.now();
  assert.equal(state.music, null);
  assert.equal(state.effects, 0);
});

test('a missing file (present binary, absent path) records audio-error and does not spawn', async () => {
  const { player, spawnCalls, eventStore } = makePlayer({ mediaRoot: require('node:os').tmpdir() });
  await player.playEffect('definitely-not-here-12345.mp3');
  assert.equal(spawnCalls.length, 0);
  assert.ok(eventStore.events.some(e => e.type === 'audio-error' && e.detail.reason === 'missing-file'));
});

test('every play/stop call logs an event with source "audio"', async () => {
  const { player, eventStore } = makePlayer();
  await player.playEffect('global/chime.mp3');
  player.stopAll();
  assert.ok(eventStore.events.every(e => e.source === 'audio'));
  assert.ok(eventStore.events.some(e => e.type === 'audio-play'));
  assert.ok(eventStore.events.some(e => e.type === 'audio-stop'));
});

test('setVolume clamps to 0..1 and returns the applied value', () => {
  const { player } = makePlayer();
  assert.equal(player.setVolume(1.5), 1);
  assert.equal(player.setVolume(-0.3), 0);
  assert.equal(player.setVolume(0.7), 0.7);
  assert.equal(player.now().volume, 0.7);
});

test('setVolume degrades to audio-unavailable (no throw) when amixer is missing', () => {
  const { player, eventStore } = makePlayer({ exec: () => { throw new Error('amixer: not found'); } });
  assert.doesNotThrow(() => player.setVolume(0.5));
  assert.ok(eventStore.events.some(e => e.type === 'audio-unavailable' && e.detail.channel === 'volume'));
});

test('now() reports music ref, effect count, and volume', async () => {
  const { player } = makePlayer();
  assert.deepEqual(player.now(), { music: null, effects: 0, volume: 0.5 });
  await player.playMusic('global/bed.mp3');
  assert.equal(player.now().music, 'global/bed.mp3');
});
