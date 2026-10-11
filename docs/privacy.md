# Privacy policy

This policy covers Pi Desktop and Pi Remote, its companion app for iPhone,
iPad and Android, and `pi-remote`, the headless host for servers. They are
open-source community projects, not affiliated with or endorsed by pi or
Earendil.

**In short: we collect nothing.** The apps have no accounts, no analytics,
no advertising, no crash reporting and no server of their own. Your data
stays on your devices and goes only where you send it.

## What Pi Desktop does with your data

Pi Desktop runs the [pi](https://pi.dev) coding agent on your computer. Your
chats, project files and settings stay on that computer, in pi's own folder
(`~/.pi/agent`). When you chat, pi sends your prompts and the context it
needs to the AI model provider you configured in pi (for example Anthropic
or OpenAI), under that provider's terms. Pi Desktop and `pi-remote` also ask
GitHub's public API whether a newer release exists (a plain request with no
data about you), and the pull request features use your own GitHub CLI
login. Nothing else is sent anywhere.

## What Pi Remote does with your data

Pi Remote is a remote control for Pi Desktop (or `pi-remote`) running on
your own computer. It connects directly to that computer over your network
or VPN, end-to-end encrypted; there is no relay server in between, and we
cannot see the connection.

- **What it sends, and where:** the prompts you type, the photos and files
  you attach, your answers to pi's questions and the actions you take (such
  as committing changes) go to the computer you paired with, and nowhere
  else.
- **What it keeps on the phone:** the computers you paired with and the
  phone's key for the encrypted link (in the system keychain, never
  backed up or synced), your preferences, unsent drafts and a cache of your
  chat list, so the app opens quickly. Removing the app removes them.
- **Camera:** only to scan the pairing code your computer shows and to take
  photos you choose to attach. Nothing is recorded or kept.
- **Photos:** only the photos you pick are read, to attach them to a
  message. Saving an image to your library happens only when you ask.
- **Local network:** to reach your computer on your network.
- **Notifications:** created on the phone itself when a chat finishes or pi
  needs you. There is no push server; nothing about your chats leaves your
  devices to make them.

## Third parties

Neither app includes third-party SDKs, trackers or advertising. The AI model
provider you set up in pi processes what pi sends it; see that provider's
privacy policy.

## Children

The apps are developer tools and are not directed at children.

## Changes and contact

Changes to this policy are published in this file, with their history in
the [repository](https://github.com/azygoss/pi-desktop/commits/main/docs/privacy.md).
Questions: open an issue at
[github.com/azygoss/pi-desktop/issues](https://github.com/azygoss/pi-desktop/issues).

Last updated: October 11, 2026.
