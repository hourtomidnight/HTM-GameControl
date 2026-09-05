# Audio player — on-Pi verification (sub-milestone 3)

After deploying this branch to the Pi (`bash scripts/setup-pi.sh` picks up `mpg123`/`alsa-utils`):

1. Confirm the ALSA default output device reaches the room speakers/amp
   (`aplay -l` to list devices; `amixer` to confirm a `Master` control exists —
   if the Pi has more than one audio output, `.asoundrc` may need a `default`
   device pinned; this is spec §12 open item 1, resolve it here if not
   already resolved).
2. Drop a small test file at `media/test.mp3` on the Pi (via the Media
   Library page from sub-milestone 2, or `scp` directly).
3. From a Node REPL on the Pi (`node`, inside the repo dir):
   ```js
   const { createEventStore } = require('./src/event-store');
   const { createAudioPlayer } = require('./src/audio-player');
   const es = createEventStore({ path: './room-control.db' });
   const ap = createAudioPlayer({ mediaRoot: './media', eventStore: es });
   ap.playEffect('test.mp3'); // should audibly play out the jack/speakers
   ap.setVolume(0.3);         // should audibly lower the level
   ap.stopAll();              // should stop it if still playing
   ```
4. Record the outcome (worked / didn't / what was needed — e.g. a specific
   `.asoundrc` device index) in this note for the next sub-milestone's
   context, since sub-milestone 6 wires real game-engine events to this
   same player and will assume this verification already passed.
