# HTM Room Control — M1 Deployment Runbook

Operational steps to bring up one room Pi running `htm-room-control` (M1). Target
device: Raspberry Pi 4/5, Raspberry Pi OS Bookworm 64-bit. HTTP port 4000; nginx
fronts it at `/room-control/`.

## 1. Flash and first boot

1. Flash **Raspberry Pi OS Bookworm 64-bit** with Raspberry Pi Imager.
2. In the imager advanced options: set hostname, enable SSH, set the `pi` user.
3. Boot, then SSH in: `ssh pi@<hostname>.local`.
4. Set a **static IP `192.168.0.125`** (e.g. via `sudo nmtui` → edit connection →
   IPv4 manual, address `192.168.0.125/24`, gateway/DNS per site). Reboot.

## 2. Install

```bash
git clone https://github.com/hourtomidnight/htm-room-control ~/htm-room-control
cd ~/htm-room-control
bash scripts/setup-pi.sh
```

The script: installs Node 22 via NodeSource if `node` is missing or older than 22,
clones/updates to `$HOME/htm-room-control`, runs `npm install --omit=dev`
(`googleapis` is the only runtime dep), installs and enables both systemd units
(`htm-room-control` + `htm-room-control-kiosk`), and installs the nginx snippet.

## 3. Configuration

Migrate an existing HTM-Control-Basic config, or start fresh:

```bash
npm run migrate-config -- /path/to/old/config.json ./config.json
# or just create ./config.json fresh and edit it via the config page
```

Startup **refuses to run (exit 1) on an invalid `config.json`** — check
`journalctl -u htm-room-control` if the service will not stay up.

## 4. Credentials and Sheets IDs

1. Copy the service-account key to `~/htm-room-control/google-credentials.json`
   (gitignored, never committed). Without it the Sheets mirror simply stays
   disabled and the clock still runs.
2. Open `http://192.168.0.125/room-control/config.html` and set the sessions /
   hints / operators spreadsheet IDs and tab names.

## 5. Audio assets

Drop the room audio into `~/htm-room-control/public/assets/`
(`TimerMusic.mp3`, `FinaleMusic.mp3`, `ClueSound.mp3`). The app runs without
them — audio commands are just silent.

## 6. Verify

```bash
systemctl status htm-room-control          # active (running)
curl -sf http://localhost:4000/healthz     # -> ok
```

Then open `http://192.168.0.125/room-control/` from another machine and confirm
the operator console loads and the clock responds to start/stop.

## 7. Hook up the room PLC (read-only in M1)

1. In `config.json` point `config.plcs[0]` at the room PLC (host, port, unit id,
   the signal/register map).
2. Restart: `sudo systemctl restart htm-room-control`.
3. Watch the event stream while toggling a PLC bit:

   ```bash
   curl -N "http://localhost:4000/api/events?type=signal-change"
   ```

   Each PLC bit change should appear as a `signal-change` event. M1 Modbus is
   **read-only** — writes land in M3.

## 8. Rollback

```bash
sudo systemctl stop htm-room-control
```

M1 is additive and runs on its own dedicated Pi — the legacy `HTM-Control-Basic`
instance on its own Pi is untouched, so rollback is just stopping this service
(and, if nginx was wired, removing the `include` line and reloading nginx).
