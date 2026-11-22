# Skyglass OS 🫧

A DIY phone OS for the **Raspberry Pi 5** and the **Freenove 7" touchscreen**.
Plain **Debian** underneath (no Android anywhere), a glossy **Frutiger Aero** phone shell on top.

- **Your PIN, nothing else.** The lock screen asks for a 4–8 digit PIN you choose. You set it when you flash the card, or the first time you swipe up. There's no Linux password, and `sudo` never asks for one.
- **Your own OS image.** `build/build-image.sh` builds Debian trixie arm64 from scratch with the Raspberry Pi kernel and firmware, plus Skyglass.
- **A real phone shell.** Lock screen, home screen, pull-down quick settings, notifications, on-screen keyboard (in Linux apps too), screen sleep, and the Pi 5 power button acts as the phone's home/lock key.
- **Better than Android, in the ways that matter here:** it's real Linux. Root without hacks, `apt install` anything, a real bash terminal, no Google account, no telemetry, no ads, and any desktop Linux app runs fullscreen from **Linux Apps**.

## Apps

| App | What it does |
|---|---|
| Phone | Dialer with glossy orbs. Makes real calls through ModemManager when a 4G HAT (e.g. SIM7600) is attached |
| Messages | SMS threads through ModemManager |
| Sky Search | Private Aero search powered by DuckDuckGo: live suggestions, instant answers, Images/News/Videos/Maps/Weather/Wikipedia bubbles. Web pages open in real Chromium (mobile layout, Aero-skinned DuckDuckGo) with a **✕ · ○ · ‹** bar at the bottom: Close, Home, Back |
| Photo & video editor | Tap any photo/video → **Edit · Copy to… · Delete**. Photos: brightness/contrast/saturation/warmth, 8 filters, crop (free, square, 4:3, 16:9…), rotate, mirror. Videos: trim, rotate, mute (ffmpeg). Save as a copy or replace |
| Weather | Open-Meteo forecast (no account): now, 24 hours, 7 days. Pick any city |
| Music | Plays ~/Music and USB drives, keeps playing in the background, bubble visualizer, shuffle |
| Light | **Flashlight** on the RGB LED (neutral, warm, cold, red night light, SOS, brightness) and **party effects**: rainbow, disco, music sync (follows the beat in Music), candle, breathe, chase, police, strobe. Also a Flashlight tile in the pull-down |
| Calendar · Sketch · Monitor | Month view with events; finger painting saved to Photos; live CPU/temperature/RAM/storage and top programs |
| Games | Sky Pop (pop the rising bubbles), Glass Memory (find the pairs), Bubble Tac Toe (vs. the phone), **Bubble Hop** (3-world platformer), **Cloudblocks** (3D block-building sandbox with flying, water, clouds and sky glass; saves your world) |
| Screensavers | Bubbles, Aurora, Starfield, Rainy window, Lava lamp, Fireflies, Kaleidoscope, Aquarium (secret) or Random |
| 3D Viewer | WebGL model viewer with the #3DBenchy built in: drag to spin, pinch/scroll to zoom, two fingers to pan, double-tap to reset. Tapping any `.stl` in Files opens it here |
| Camera | Live preview, photos and **video recording** (720p .mp4) with a Pi camera module. Tap “Saving to phone/USB” to save straight onto a USB drive |
| Photos / Files | Gallery of photos and videos. Plug in a USB drive and it mounts by itself: tap **Select**, pick photos/videos, then **Copy to…** or **Move to…** the drive. Files lists Phone + USB drives with an **Eject** button |
| Notes, Calculator, Clock | The basics, done in Aero style |
| Terminal | xterm.js on a real bash pty with an Esc/Tab/Ctrl/arrow key row. nano and htop work |
| Linux Apps | Every installed `.desktop` app, opened full screen. The Aero on-screen keyboard (squeekboard) pops up when an app's text field is focused and pushes the app up instead of covering it |
| Android | Android apps through Waydroid (a real Android container, not an emulator). One-time **Set up Android** button. Android only runs while it's open |
| Settings | Themes: Sky, Aqua and **Old school** (a classic grey 3D desktop: bevelled windows, cream title bars, an icon bar). Wi-Fi, **hotspot**, **Bluetooth pairing** (scan, pair, connect, forget), **wallpaper** (4 drawn skies, shipped pictures, or any JPG/PNG/WebP of yours), glass/bubbles, brightness, screen sleep, rotation, sound, **notifications**, **keyboard** (on-screen keyboard, hardware layout, compositor), **Android**, **software updates** (apt with progress), about, power |

## Hardware

- Raspberry Pi 5 (4 or 8 GB)
- Freenove 7" touchscreen. It's driverless: HDMI for the picture, USB for touch (the kernel's `hid-multitouch` handles it). Plug both cables in.
- Optional: RGB LEDs such as **HW-478 / KY-016** modules for a flashlight, status light and party lights (see [RGB LED](#rgb-led))
- Optional: Pi camera module, 4G/LTE HAT with a SIM for calls and SMS, a UPS/battery HAT (any that shows up in `/sys/class/power_supply` drives the battery icon)

### The display "driver" layer

The panel needs no kernel driver. What a phone needs is the glue, and that's in `skyglass-display`:

```
skyglass-display info                 # panels, modes, EDID name, touch devices, calibration
skyglass-display rotate 90            # portrait: rotates the UI AND the touch input
skyglass-display touch-cycle          # touch doesn't line up after rotating? run until it does
skyglass-display mode 1024x600@60     # force a mode if the panel's EDID is missing or wrong
skyglass-display panel dsi            # if you have the DSI-ribbon version of the panel
skyglass-display scale 1.25           # bigger or smaller UI
```

To check touch alignment (and everything else), dial `*#0*#` in the Phone app. See [Test mode](#test-mode-0).

## Flash it to an SD card (easiest)

```
sudo ./flash.sh
```

The script builds the image if you don't have one yet, finds your SD card (it never offers your system disk), and asks you to **choose your PIN** and optionally a Wi-Fi network. Then it flashes the card and writes your PIN and Wi-Fi onto it. Put the card in the Pi and power on.

## Built to survive bugs

No software is bug-free, so Skyglass is built to recover on its own:

| If this breaks… | …this happens |
|---|---|
| One app throws an error | Only that app closes, with a toast. The rest of the phone keeps running |
| The UI freezes or goes blank | A watchdog notices the missing heartbeat and restarts the UI within ~45 s |
| The backend crashes | It restarts itself within 1 s |
| The UI crashes twice in a row | **Safe mode**: it retries without the GPU and with a fresh browser profile |
| It still won't start after 4 tries | The screen shows the error and the log lines, plus a terminal, instead of a blank screen |
| Saved settings get corrupted | They reset to defaults and the phone boots normally |
| Linux itself hangs | The Pi's hardware watchdog reboots it |
| Logs grow forever | Capped at 100 MB, so they can't fill the card |
| The power is cut (unplugged, weak supply) | `skyglass-repair` fixes the damage at the next boot. See [Built to survive being unplugged](#built-to-survive-being-unplugged) |

When something's wrong, run **`skyglass-doctor`**. It checks the screen, touch, GPU, permissions, backend, disk, temperature and power supply, and tells you how to fix each problem.

Before flashing, run **`./tests/run.sh`**. It runs about 160 automatic checks: script syntax, every backend endpoint, the PIN lockout, the terminal, every app and settings page in a real browser, and crash containment.

## Built to survive being unplugged

A phone gets unplugged, and a weak power supply makes a Pi 5 switch off under load. **`skyglass-repair`** runs at every boot, before the screen starts, and fixes what a power cut can break:

| After a power cut… | …this happens |
|---|---|
| The last shutdown wasn't clean | A notification after boot says so. The Pi's reset register tells "lost power" apart from "froze" |
| A package install or update was cut off halfway | It finishes it (`dpkg --configure -a`) |
| A Skyglass file got damaged or lost | It's checked against its SHA-256 and restored from the known-good copy in `/var/lib/skyglass/source` |
| `config.txt` or `cmdline.txt` on the boot partition got emptied or garbled | It's restored from a backup. Your own edits to them become the new backup |
| A half-written settings file was left behind | It's cleaned up |

Also:
- Changes reach the SD card within about 10 seconds instead of 30, so a power cut loses less.
- The system log is kept across reboots, so you can see what happened before the power went.
- Under-voltage (a weak power supply) shows a notification and an amber LED.

`skyglass-repair --check` reports problems without changing anything, and `skyglass-doctor` runs it too.

## Updates

Settings › Software updates has two parts:

- **Skyglass**, from this project's GitHub releases. Tap **Update**: it downloads the release, runs its `install-on-pi.sh` (new packages and files), and restarts the screen. **Go back to the previous version** undoes the last update.
- **Debian packages**: apt, with progress.

From the command line:

```
skyglass-update --check      # installed and latest version
skyglass-update              # update if there's a newer release
skyglass-update --rollback   # back to the version before
```

The repository is set in `/etc/skyglass/update.conf` (`REPO=owner/name`). An update keeps your settings, files, PIN and LED pins, and a password you gave the user.

## Wallpapers

Settings › Wallpaper offers the drawn skies, the pictures in `/usr/share/skyglass/wallpapers/` (drop more JPG/PNG files there) and every picture in Pictures, Downloads, Desktop and on USB drives. Or open any photo and tap **Wallpaper**. The picture is shrunk to screen size (ffmpeg) into `~/.config/skyglass/wallpaper.jpg`, so the original is never touched. Over SSH:

```
curl -X POST -d '{"path":"/home/skyglass/Pictures/beach.jpg"}' 127.0.0.1:7777/api/wallpaper
```

`build/make-wallpaper.py out.jpg` regenerates the shipped "Aero Lagoon" picture.

## Notifications

New SMS, low battery (20/10/5 %), finished updates, installed Android apps and **any Linux app** all end up in one list:

- A banner slides in at the top. Tap it to open the app, or swipe it up to put it away.
- Pull the status bar down to see the list, with **Clear all**. The orange badge counts the unread ones.
- The lock screen shows the latest three. Settings › Notifications › *Show what they say* hides their text until you unlock.
- **Do Not Disturb** (a tile in the pull-down, or in Settings) stops banners, sounds and waking the screen. Critical ones, like an almost empty battery, still get through.
- Each app can be muted in Settings › Notifications.

Linux apps notify through the standard desktop service (`org.freedesktop.Notifications`). `skyglass-notifyd` passes them on, so `notify-send` and GTK or Qt apps just work. From a script, a cron job or over SSH:

```
skyglass-notify "Backup done" "42 photos copied"
skyglass-notify -a Backup -u critical "Backup failed" "The USB drive is full"
curl -X POST -d '{"title":"Hi","body":"from my PC"}' 127.0.0.1:7777/api/notify
```

They're kept in `~/.config/skyglass/notifications.json` (the last 100).

## RGB LED

Plain RGB LEDs on GPIO pins become the phone's flashlight, its notification and status light, and a party light. The `skyglass-led` service starts at boot, before the UI, so the LED works even when the screen doesn't. That's how it can show an error.

**Wiring one HW-478 / KY-016 module** (pins R, G, B, and "–" for ground). These numbers are the defaults in `/etc/skyglass/led.conf`:

| Module | Pi 5 |
|---|---|
| R | GPIO17 (pin 11) |
| G | GPIO27 (pin 13) |
| B | GPIO22 (pin 15) |
| – | GND (pin 9) |

**Several modules** (2–8):

- **On their own pins** (chase, police and rainbow then move across them): list one `R,G,B` triple per module, e.g. `LEDS="17,27,22 5,6,13 19,26,21 23,24,25"`.
- **In parallel on the same three pins:** the Pi's GPIO pins can only supply a few mA each, so put a PNP transistor in each colour line. For example S8550 or 2N3906: emitter to 3.3 V, base through 1 kΩ to the GPIO, collector to the modules' R, G or B pins. Then set `ACTIVE_LOW=1`. A common-anode module (a "+" pin instead of "–") also needs `ACTIVE_LOW=1`.
- Check whether your modules have resistors on board. Bare SMD RGB LEDs need about 150 Ω on R and 100 Ω on G and B.

After editing: `sudo systemctl restart skyglass-led`, then `skyglass-led test`. Red, green, blue and white should light in turn. It's also a tile in test mode (`*#0*#`).

**What it shows**, highest priority first:

| Light | When |
|---|---|
| Flashlight | You turned it on (pull-down tile, Light app, `skyglass-led on warm`) |
| **Red, fast blink** | Something broke: the UI won't start or froze, the battery is empty, or a script you wrote calls `skyglass-led error backup` |
| **Amber blink / pulse** | Weak power supply (under-voltage), CPU over 82 °C |
| Party | An effect from the Light app |
| Short blip in the app's colour | Unread notifications: green Messages, red Battery, blue Updates, aqua others. Off in Do Not Disturb |
| Orange / green, dim | Charging / full (with a battery HAT) |
| Soft blue breathing | Starting up, until the screen is ready |

Each of these can be switched off in Settings › LED light, which also sets the maximum brightness. From the command line:

```
skyglass-led on warm 0.6      skyglass-led off       skyglass-led sos
skyglass-led party rainbow    skyglass-led party candle    skyglass-led party off
skyglass-led error backup     skyglass-led clear alert:backup
skyglass-led status
```

Full on/off colours cost no CPU. Dimming and mixed colours use software PWM, and only while they're shown. Strobe is capped at 10 flashes per second and asks once before it starts, because fast flashing can trigger seizures. A single small LED module is a keychain-style light, not a phone flashlight. More modules or a brighter LED behind transistors help.

## Compositor and keyboard

The UI runs under **labwc**, a Wayland compositor with layer-shell, input-method v2, text-input v3, virtual keyboard and output power management. That's what lets **squeekboard** float above Linux apps and pop up by itself on text fields in GTK, Qt, Chromium (`--enable-wayland-ime`) and Firefox apps. Apps open maximized without title bars (`/etc/skyglass/labwc/rc.xml`), so the keyboard shrinks them instead of covering them. The keyboard's Aero glass theme is `/usr/share/skyglass/squeekboard/style.css`. To use your own, put a `style.css` in `~/.local/share/squeekboard/`.

Settings › Keyboard switches the on-screen keyboard on or off and sets the layout of USB/Bluetooth keyboards (`KEYBOARD_LAYOUT=de` in `display.conf`). It also picks the compositor.

**cage** stays installed as the fallback. If labwc crashes twice in a row, the session switches to cage by itself, and `skyglass-doctor` tells you it did. To force one, put `COMPOSITOR=cage` or `COMPOSITOR=labwc` in `/etc/skyglass/display.conf`. Logs: `~/.cache/skyglass/labwc.log`, `cage.log`, `squeekboard.log`.

## Android apps

Open **Android** on the home screen and tap **Set up Android**, or run it in the Terminal:

```
skyglass-android setup     # switches to the 4K-page kernel → reboot → run it again
skyglass-android status
```

Setup works in two passes:

1. Android needs 4K memory pages, and the Pi 5's default kernel uses 16K. The first pass installs the Raspberry Pi 4K kernel (`kernel8.img`), adds `kernel=kernel8.img` to `config.txt` (the old file is kept as `config.txt.before-android`) and asks you to reboot.
2. The second pass adds repo.waydro.id and installs `waydroid`. It downloads Android itself (about 1 GB), in 8 parallel parts, which is about 15× faster than Waydroid's own downloader on a Pi's Wi-Fi. The download resumes after a power cut, and setup checks the SHA-256 and keeps only the unpacked images, not the zips. Then it runs `waydroid init` and sets the `minigbm_gbm_mesa` gralloc for the Pi's V3D GPU.

Then:

- **Install an app:** tap any `.apk` in Files, or run `skyglass-android install app.apk`. F-Droid inside Android works too. You get a notification when the install is done.
- **Windowed mode** (Settings › Android, or `skyglass-android windowed on`): every Android app opens as its own window instead of the full Android screen.
- **Android settings:** open them from Settings › Android.

The container never starts at boot. **Open Android** starts it, and a short press on the power button closes Android and stops the container. Apps you install inside Android show up in the Android app and in Linux Apps. To go back to the 16K kernel, remove the `kernel=kernel8.img` line marked `skyglass-android`.

## Battery and heat

An idle phone does almost nothing: about 5% CPU on the lock screen (it was about 19% before), with the CPU at 1.6 GHz instead of 2.4.

- The UI only touches the screen when something changes. The clock wakes once a minute. The bubbles run at 20 fps from one pre-drawn sprite, and they stop while an app covers them or the screen sleeps. The lock-screen shimmer is a GPU transform that rests after a few sweeps.
- Apps left open (clock, games, monitor, 3D viewer) stop animating while the phone is locked, on the screensaver or asleep. When the screen sleeps, the backlight really switches off.
- Cloudblocks draws its block textures once into a small atlas instead of per pixel, draws only the chunks in view, and draws nothing while the view doesn't change. On the Pi: GPU busy 20% → 12% while you look around, and 20% → 0% while you stand still (60 fps either way).
- Chromium starts without the accessibility tree, background networking, sync or component updates that Raspberry Pi OS's launcher adds.
- The backend reads USB changes from `/sys` and only runs `lsblk` when something changes. Wi-Fi/modem status is cached (15 s / 60 s).
- The system uses the `schedutil` governor, Wi-Fi power saving and fewer SD-card flushes. Printing, NFS, cloud-init and the nightly apt/man-db timers are off. `apt` still works whenever you run it.
- Settings are also saved on disk by the backend (`~/.config/skyglass/settings.json`), so they survive a power cut even when the browser's own storage doesn't.

## Test mode (`*#0*#`)

Dial `*#0*#` in Phone for a full hardware test menu, like a phone's hidden factory test mode. Tiles turn green ✔ or red ✘. **Run automatic tests** checks everything that can judge itself in one go.

| Group | Tests |
|---|---|
| Screen | Colours (dead pixels, banding, sharpness), touch draw, touch grid (finds dead zones), multi-touch, brightness, frame rate |
| Sound | Speaker (left, right, sweep), microphone (record + play back), audio devices |
| Hardware | Sensors (temperature, clocks, voltage, throttling), power supply (USB-C input voltage, power per rail), CPU stress (10 s on all cores), storage speed, camera (live picture), green LED, buttons & keys (power button + keyboard) |
| Radios | Wi-Fi & internet (signal, router/internet ping, DNS), Bluetooth (devices nearby), 4G modem & SIM, USB, version & IDs (firmware, bootloader, RTC, serial) |

Tests that change things (CPU stress, LED) only answer the phone's own UI, so a web page can't start them.

## Lock screen PIN

- Swipe up, then type your PIN and press OK.
- After 5 wrong PINs it locks you out for 30 s, then 60 s, and so on up to 15 min. Rebooting doesn't reset the counter.
- To change it: Settings › Lock screen & PIN.
- Forgot it? SSH in or plug in a keyboard and press Ctrl+Alt+F2, then run `skyglass-pin reset` (or `skyglass-pin set`).
- The PIN is stored hashed (PBKDF2-SHA256, 200k rounds) in `~/.config/skyglass/pin.json`.
- The PIN guards the touchscreen. Anyone with physical access to the SD card can still read it, because the card isn't encrypted.

## Other install options

### Option A (recommended): on top of Raspberry Pi OS Lite

1. Open Raspberry Pi Imager. Choose **Raspberry Pi 5**, then **Raspberry Pi OS (other) › Raspberry Pi OS Lite (64-bit)**, then your SD card.
2. When it asks about OS customisation, pick **Edit settings**. Set a username and password (e.g. `pi`), your Wi-Fi, and on the Services tab **enable SSH**. Then write the card.
3. Put the card in the Pi, power it on, and wait about 2 minutes. Then, from your PC:
   ```
   scp -r ~/Projects/skyglass-os pi@raspberrypi.local:
   ssh pi@raspberrypi.local
   cd skyglass-os && sudo ./install-on-pi.sh && sudo reboot
   ```
4. The Pi reboots into Skyglass. Swipe up and choose your PIN.

### Option B: build your own image from scratch (pure Debian + Pi kernel)

On any Linux PC (x86_64 works through qemu):

```
# Arch:   sudo pacman -S --needed debootstrap debian-archive-keyring qemu-user-static qemu-user-static-binfmt dosfstools e2fsprogs rsync && sudo systemctl restart systemd-binfmt
# Debian: sudo apt install debootstrap qemu-user-static binfmt-support debian-archive-keyring dosfstools e2fsprogs rsync
sudo ./build/build-image.sh     # or just: sudo ./flash.sh
```

On first boot the root partition grows to fill the card.

`WITH_ANDROID=1 sudo ./build/build-image.sh` also puts the 4K-page kernel (`kernel8.img`) on the card, so Android setup has no kernel to download. The phone still boots the default kernel until you run `skyglass-android setup`.

### Preview on your PC

```
./preview.sh        # opens the shell in a 600x1024 phone-sized window
```

Wi-Fi, files, terminal and Linux Apps work on the desktop too. They talk to your real PC.

## Controls

The mouse pointer is hidden (it's a touchscreen). Put `SHOW_CURSOR=1` in `/etc/skyglass/display.conf` to get it back when using a real mouse.


- **Swipe up** on the lock screen to unlock. Tap or swipe the bottom bar to go home.
- **Pull down** the status bar for quick settings.
- **Power button:** a short press goes home from a Linux app, or sleeps/wakes the screen. A long press opens the power menu.
- Plug in a keyboard and it works everywhere. Esc means back.

## Layout

```
build/build-image.sh        from-scratch image builder (debootstrap)
build/configure-rootfs.sh   turns any Debian rootfs into Skyglass (user, sudo, autologin, branding)
build/packages.txt          the package list
boot/config.txt             Pi 5 boot config
install-on-pi.sh            install on an existing Pi OS Lite
rootfs/                     files copied onto the device
  usr/lib/skyglass/shell/   server.py (stdlib-only Python backend) + web/ (the UI)
  usr/local/bin/            skyglass-session, skyglass-display, skyglass-android, skyglass-notify(d), skyglass-led, skyfetch, aero, hack
  usr/local/sbin/           skyglass-ledd (the RGB LED service), skyglass-repair, skyglass-firstboot
VERSION                     the Skyglass version (releases are tagged v<VERSION>)
  etc/skyglass/labwc/       compositor config (maximized apps, no title bars)
  usr/share/skyglass/       wallpapers, the invisible cursor, the squeekboard Aero theme
  etc/                      sudoers, tty1 autologin, logind power-key, profile
```

## Known limits (honest list)

- The on-screen keyboard in Linux apps needs the app to support Wayland text-input (GTK, Qt, Firefox and Chromium with `--enable-wayland-ime` do). X11-only apps and Electron apps without Wayland IME need a USB or Bluetooth keyboard. So does everything after a fallback to cage, which has no layer-shell or text-input.
- Android (Waydroid) needs the 4K-page kernel. Waydroid's Pi 5 graphics support is young, so some apps may render slowly or not at all.
- The Pi 5 has no headphone jack, and the DSI panel has no speaker. Sound plays through HDMI, USB or Bluetooth speakers/headphones. Test mode flags this.
- No microphone is fitted by default. Plug in a USB mic or headset.
- Call audio depends on your modem HAT's audio routing. Dialing and SMS work through ModemManager either way.
- HDMI panels have no backlight control, so brightness is software dimming and "screen off" is a black overlay. Panels with a backlight (like the DSI version) really switch it off when the screen sleeps.
- If touch is mirrored or rotated wrong after `rotate`, run `skyglass-display touch-cycle`. Panels differ.

## Roadmap (planned next)

- Test labwc, squeekboard and Waydroid on more panels and HATs, and tune the squeekboard layout for the 7" screen.
- Notifications from Android apps (Waydroid has no host notification bridge yet).
- Contacts, so calls, SMS and their notifications show names instead of numbers.
- Alarms and timers in Clock that ring even while the phone sleeps.

<details>
<summary>🥚 Easter eggs (spoilers!)</summary>

- **Konami code** on the lock screen (short flicks ↑↑↓↓←→←→, or keyboard ↑↑↓↓←→←→BA) unlocks the **Aurora** theme and a bubble storm (and a rainbow on the LED)
- Tap **Version** in Settings › About **7 times** to become a Bubble Developer. You get the hidden **Aquarium** app (tap to feed), and fish swim across your home screen
- **Long-press the wallpaper** for endless **Bubble Wrap**, with a lifetime pop counter
- Dialer codes: `*#06#` device ID, `*#0*#` test mode, `*#*#4636#*#*` testing info, `*#7777#` bubble storm (the LED goes disco). Try calling `42`
- Calculator: `1337`, `0.1+0.2`, the answer to everything, and dividing by zero
- At 3:14 the status bar clock turns into π
- Terminal: `sudo make me a sandwich`, `please`, `aero`, `hack`, `skyfetch`
- Open the browser console (dev preview) and say hi
- Sky Search: try `do a barrel roll`, `askew`, `frutiger aero`, `sudo make me a sandwich`
</details>


#3DBenchy is by Creative Tools (3dbenchy.com), shipped unmodified under CC BY-ND 4.0.
