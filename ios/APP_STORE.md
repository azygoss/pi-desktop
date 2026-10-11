# Publishing Pi Remote on the App Store

What the app already does for review, what is left to do in App Store
Connect, and the text to paste there. Account-specific values (team id,
Apple ID, certificates) never go into this repository.

## Ready in the project

- **Privacy manifest:** `PiRemote/Resources/PrivacyInfo.xcprivacy` declares
  no tracking, no collected data, and the one required-reason API the app
  uses (`UserDefaults`, reason `CA92.1`).
- **Purpose strings** for every protected resource the app touches:
  - camera (scan the pairing code, take a photo to attach);
  - photo library (save an image);
  - local network.

  Photo picking uses the out-of-process picker, which needs no permission.
- **Background mode:** only `fetch`, for `BGAppRefreshTask`. It reconnects
  briefly to announce chats that finished.
- **App Transport Security:** only `NSAllowsArbitraryLoads` is set (see the
  review note below). `NSAllowsLocalNetworking` was removed on purpose: when
  it is present, iOS ignores `NSAllowsArbitraryLoads`.
- **Icon:** a single 1024 × 1024 PNG with no alpha channel.
- **Launch screen** from `UILaunchScreen`.
- **iPhone and iPad:** iPhone is portrait-only. iPad supports all four
  orientations, as multitasking requires.
- **In-app links:** Settings → About links to the privacy policy, support
  and source code, and carries a non-affiliation note. The pairing screen
  links to Pi Desktop.
- **Accessibility:**
  - text follows Dynamic Type up to the AX3 size;
  - icon buttons have labels;
  - diff lines read as one element each.
- **Pairing links** ask for confirmation before pairing, so a link from a
  web page cannot silently pair the phone with someone else's computer.

## Decisions before the first submission

1. **Name and icon (Guideline 5.2.1).** The icon and the in-app mark use the
   pi logo, which belongs to Earendil / the pi project. Either get written
   permission from Earendil to use it, or replace `AppIcon` and `LaunchMark`
   with an original design.
   - "Pi Remote" may already be taken on the store. Reserve the name in App
     Store Connect early. Alternatives: "Pi Remote for Pi Desktop",
     "Remote for Pi Desktop".
2. **Export compliance.** `project.yml` sets
   `ITSAppUsesNonExemptEncryption: false`. However, the app implements
   XSalsa20-Poly1305 itself (`PiRemoteKit/Crypto/SecretBox.swift`) for its
   end-to-end link, in addition to Apple's CryptoKit. Under US export rules
   that is mass-market encryption, published as open source.
   - **The cautious path:** set the key to `true`. In App Store Connect,
     declare that the app uses standard encryption algorithms in addition to
     Apple's, and answer the follow-up questions (including availability in
     France).
   - The answer is a legal declaration by the account holder, so confirm it
     before uploading.
3. **App Review access (Guideline 2.1).** A reviewer has no Pi Desktop to
   pair with, and pairing codes expire after five minutes, so a code in the
   notes will not work. Options, from least to most effort:
   - **(a) Demo video.** Record one: pairing, a chat streaming, the diff
     view, committing. Link it in the review notes (template below).
   - **(b) Demo server.** Keep a `pi-remote` host running on a reachable
     server (`pi-remote start --host <public name>`). Tell the reviewer to
     message you for a fresh code, or add a long-lived demo pairing to the
     host.
   - **(c) Demo mode.** Add an in-app demo mode with synthetic data. This is
     the most work, but the most reliable path through review.
4. **Version.** `MARKETING_VERSION` is `0.4.0` and `CURRENT_PROJECT_VERSION`
   is `5` (`project.yml`). Raise the build number for every upload.

## Build and upload

```bash
cd ios
DEVELOPMENT_TEAM=<your team id> scripts/archive.sh            # build/PiRemote.ipa
DEVELOPMENT_TEAM=<your team id> scripts/archive.sh --upload   # to App Store Connect
```

The bundle id is `io.github.azygoss.piremote`. Register it under
Certificates, Identifiers & Profiles if Xcode does not do it automatically.
Then create the app in App Store Connect with that bundle id. The `build/`
output is git-ignored.

## Screenshots

App Store Connect needs at least:

| Size | Simulator | Pixels |
|---|---|---|
| iPhone 6.9" | iPhone 17 Pro Max | 1320 × 2868 |
| iPad 13" | iPad Pro 13-inch (M5) | 2064 × 2752 |

To make them without real data:

1. Run `pi-remote` with the synthetic fake pi from `test/fixtures/fake-pi.mjs`
   (`--pi test/fixtures/fake-pi.mjs`) in a throwaway data directory.
2. Pair the simulator with `xcrun simctl openurl booted '<link from pi-remote pair>'`.
3. Capture with `xcrun simctl io booted screenshot <file>.png`.

Never show real paths, names or conversations.

## App Store Connect text

**Category:** Developer Tools. **Price:** Free. **Age rating:** 4+ (no
objectionable content; the app shows what the user's own agent produces).

**Subtitle** (30 characters max): `Control Pi Desktop from iPhone`

**Promotional text:**
> Follow and steer your pi coding agent from your phone: answer its
> questions, review the changes and commit, wherever you are.

**Description:**
> Pi Remote is the companion app for Pi Desktop, the open-source desktop app
> for the pi coding agent. pi keeps running on your computer; Pi Remote lets
> you follow and drive it from your iPhone or iPad.
>
> • Start chats in any project and watch replies, thinking and tool steps
>   stream in
> • Steer or stop a run, queue what comes next, answer pi's questions
> • Review the working-tree diff, leave line comments, ask pi for a review,
>   then commit and push
> • Follow the pull request and its checks
> • Attach photos, screenshots and files
> • Manage projects, worktrees, branches and scheduled automations
> • Get a notification when a run finishes or pi needs you
>
> Private by design: the phone talks directly to your computer over your
> network or VPN (such as Tailscale), end-to-end encrypted. There is no
> account, no relay server, no analytics and no tracking.
>
> Requires Pi Desktop on your computer (macOS), or pi-remote on a server.
> Pi Remote is a community project, not affiliated with or endorsed by pi
> or Earendil.

**Keywords** (100 characters max):
`pi,coding agent,ai,remote,developer,terminal,git,diff,code review,llm,tailscale,automation`

**Support URL:** https://github.com/azygoss/pi-desktop/issues
**Marketing URL:** https://github.com/azygoss/pi-desktop
**Privacy policy URL:** https://github.com/azygoss/pi-desktop/blob/main/docs/privacy.md

**App Privacy:** choose **Data Not Collected**. Everything the app sends goes
to the user's own computer, and nothing reaches the developer or a third
party.

## App Review notes (template)

> Pi Remote is a companion app: it remote-controls Pi Desktop (an
> open-source desktop app, https://github.com/azygoss/pi-desktop) running on
> the user's own computer. It has no account and no server of its own; the
> phone connects directly to the computer over the local network or a VPN
> and the link is end-to-end encrypted by the app.
>
> To review it you need a computer running Pi Desktop (Settings → Remote
> control → Show pairing code) or `pi-remote` on a server. A demo video of
> pairing and the main features: <link>. [If you run a demo server: "Contact
> us at <email> and we will send a pairing code for our demo server."]
>
> Why the app sets NSAllowsArbitraryLoads: it connects with a plain
> WebSocket to addresses the user's computer reports (LAN IPs, .local names,
> Tailscale names, or a server's domain). These are encrypted end to end by
> the app (X25519 key exchange, XSalsa20-Poly1305), so TLS is not used.
>
> Background mode "fetch": a background app refresh reconnects briefly to
> post local notifications when a chat the user started has finished. There
> is no push server.
