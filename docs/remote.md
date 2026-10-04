# Remote control

Pi Desktop can be driven from the Pi Remote app on a phone (`mobile/`). This
page describes how the two talk; the code is in `src/main/remote/`,
`src/shared/remote/` and `mobile/src/remote/`.

## Shape

- **Host.** With remote control on (Settings → Remote control; off by
  default), the main process listens for WebSocket connections on a fixed
  port (47821, or the next free one), on all interfaces.
- **No relay.** The phone connects straight to the computer, so both must be
  able to reach each other: the same network, or a VPN such as Tailscale.
- **The same handlers.** A request names one of the desktop's IPC channels
  and carries its input; main runs the handler the window would
  (`invokeRemote` in `src/main/ipc.ts`). Only allowlisted channels answer
  (`REMOTE_ALLOWED`): nothing that opens a native dialog or menu, no terminal
  or browser panel, no app settings, no quitting, and no remote-control
  management — a phone cannot pair another phone.
- **The same broadcasts.** Events are the desktop's own broadcasts, forwarded
  under their channel names (`REMOTE_FORWARD`). Token deltas of a chat only
  go to phones that subscribed to it; the rest hear when a run starts and
  settles.
- **One chat, two screens.** `chatIdForSession` is how the window and a phone
  find the chat that already owns a session, so neither starts a second pi on
  the same file. An extension dialog answered on one side is closed on the
  other (`pi-desktop:chat:ui-resolved`).

## Pairing

The computer has a long-term X25519 key pair (`remote.json` in the app's data
directory; the secret key is encrypted with the OS keychain through
Electron's `safeStorage`). The phone has its own, kept in the Android
Keystore.

"Show pairing code" creates a one-time token (16 random bytes, five minutes)
and shows a QR code of

```
pidesktop://pair?v=1&k=<desktop public key>&t=<token>&p=<port>&h=<addresses>&n=<name>
```

The phone connects, proves it holds its key, and presents the token inside
the encrypted channel; the desktop then stores the phone's public key. The
token is spent by the first phone that uses it. Removing a phone deletes its
key and cuts its connections.

## Encryption

The transport is a plain WebSocket, so everything is sealed above it
(`src/shared/remote/crypto.ts`, [TweetNaCl](https://tweetnacl.js.org)):

1. The phone sends its static and an ephemeral public key; the desktop
   answers with an ephemeral public key. A phone the desktop does not know
   (and that brings no valid pairing token) is told so inside the encrypted
   channel, so only the real computer can make a phone drop its pairing.
2. Both derive two keys (one per direction) from SHA-512 over a context
   string, all four public keys and three Diffie-Hellman results:
   ephemeral–ephemeral (forward secrecy), phone-ephemeral–desktop-static
   (only the real desktop can compute it; its public key came from the QR
   code) and phone-static–desktop-ephemeral (only the paired phone can).
3. Every frame after that is an XSalsa20-Poly1305 box whose nonce is an
   implicit per-direction counter, so forged, replayed, dropped or reordered
   frames fail to open and the connection is closed.

Frames are JSON, deflated when larger than 1 KB. Repeated failed handshakes
from an address are refused for ten minutes.

## What a paired phone can do

Everything the window can do with a chat — including running shell commands
in your projects through pi. Treat pairing a phone like handing someone your
keyboard: pair only your own devices, and remove a lost phone under
Settings → Remote control.
