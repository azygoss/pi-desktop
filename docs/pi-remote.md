# pi-remote: Pi Remote on a server

`pi-remote` is Pi Desktop's remote-control host without the desktop app. Run
it on a VPS, a home server or any Linux or macOS machine, pair the
[Pi Remote](https://github.com/azygoss/pi-desktop/tree/main/mobile) Android app with it, and use pi there the
way you would through Pi Desktop: chats with live streaming, sessions and
projects, diffs, commits and pushes, pull requests, side chats, automations
and usage.

It is the same code as the desktop app's host: the phone's requests run
the IPC handlers Pi Desktop's main process runs, behind the same allowlist,
over the same end-to-end encrypted protocol ([remote.md](https://github.com/azygoss/pi-desktop/blob/main/docs/remote.md)). What
needs a desktop is absent: the in-app browser, computer use, dictation and
terminal tabs.

## Requirements

- Node.js 20.11 or newer.
- pi. The package brings a pinned pi as a fallback, but a pi you install and
  log in to yourself is used first:

  ```bash
  npm install -g @earendil-works/pi-coding-agent
  pi            # log in once, as you would on a desktop
  ```

- A way for the phone to reach the server (see [Network](#network)).

## Install

Download `pi-remote-host-<version>.tgz` from the
[latest release](https://github.com/azygoss/pi-desktop/releases/latest) and
install it globally:

```bash
npm install -g ./pi-remote-host-<version>.tgz
```

## Start and pair

```bash
pi-remote start --host <address the phone uses>
```

`--host` is what goes into the pairing code: the server's public IP, a
domain pointing at it, or its Tailscale name. Without it the code lists the
machine's own addresses, which is right on a home network.

In a terminal, the first start shows a QR code. In Pi Remote, choose
**Pair a computer** and scan it. The code works once, for five minutes.

To pair another phone while the host runs (for example as a service), run
this in a terminal on the server:

```bash
pi-remote pair
```

Other commands:

```bash
pi-remote status            # addresses, port and paired phones
pi-remote revoke <phone>    # remove a phone by name or id; it is cut off at once
pi-remote --help
```

## Run it as a service

`pi-remote service install` writes a systemd user service with the options
you give it:

```bash
pi-remote service install --host 203.0.113.7
systemctl --user daemon-reload
systemctl --user enable --now pi-remote
sudo loginctl enable-linger "$USER"   # keep it running after you log out
pi-remote pair
```

Logs: `journalctl --user -u pi-remote -f`. `pi-remote service` (without
`install`) only prints the unit, for other setups.

The service runs pi with the PATH you had when you installed it, so pi, git
and gh are found the same way as in your shell.

## Network

The phone connects straight to the server; there is no relay.

- **Tailscale (or another VPN)** is the simplest and keeps the port off the
  internet: install it on the server and the phone, then
  `pi-remote start --host <server's Tailscale name or 100.x address> --bind <same address>`.
- **A public port** works too. Open TCP 47821 (or your `--port`) in the
  firewall, e.g. `sudo ufw allow 47821/tcp`, and start with
  `--host <public IP or domain>`. With `--host` or `--port` the host uses
  exactly that port and stops if it is taken, so it never drifts away from
  your firewall rule.

Everything after the first message is encrypted end to end
(X25519 + XSalsa20-Poly1305); the phone pins the server's key from the QR
code, and the server only talks to phones it paired. Failed handshakes are
rate limited. An open port still shows that something listens there, which
is why a VPN is the better default.

## Where things live

- `~/.config/pi-remote/` (or `--data-dir`): the host's key and paired phones
  (`remote.json`, readable only by you — on a server there is no OS keychain
  to encrypt it with), app settings, automations, the scratch folder for
  chats without a project (`workspace/`) and the control socket
  (`host.sock`) that `pair`, `status` and `revoke` talk to.
- pi's own data stays where pi keeps it (`~/.pi/agent`); sessions started
  from the phone open in the pi TUI (`pi -r`) and vice versa.
- Deleted sessions and discarded files go to the trash
  (`~/.local/share/Trash`, the freedesktop.org trash), never straight to
  `rm`.

Projects are folders on the server: add one from the phone's Projects tab
by browsing to it.
