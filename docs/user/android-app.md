# ViewCode Android app

ViewCode's Android app is built from this repository on your own free Expo
account. It installs as **ViewCode** (`com.viewcode.app.preview` for the
preview build) next to the Play Store T3 Code app; the two never share data,
links or pairings.

## Build and install

You need a ViewCode checkout with dependencies installed (`vp i`), Node.js 24
and a free [Expo account](https://expo.dev/signup). Run everything from
`apps/mobile`:

```bash
npm install -g eas-cli
eas login
cd apps/mobile
eas init
```

`eas init` creates a `viewcode` project on your account. ViewCode's app config
is dynamic, so it cannot save the project ID itself; it prints the ID instead.
Store it once, for your machine and for the cloud builder:

```bash
echo "VIEWCODE_EAS_PROJECT_ID=<id from eas init>" >> ../../.env.local
eas env:create --environment preview --name VIEWCODE_EAS_PROJECT_ID \
  --value <id from eas init> --visibility plaintext
```

If you build under an Expo organization rather than your personal account, add
`VIEWCODE_EAS_OWNER=<organization>` the same way.

Then build:

```bash
eas build -p android --profile preview
```

The first build asks to generate an Android keystore; accept. When the build
finishes, EAS prints a link and a QR code. Open it on the phone, download the
APK and install it (Android asks you to allow installs from your browser once).

## Connect to your computer

On the computer, open **Connect phone → Anywhere → Quick connect** (see
[Remote access](./remote-access.md#quick-connect)). In the ViewCode app choose
**Add environment** and scan the code.

## Threads on the phone

Home groups threads into one folder per project, like the desktop sidebar. A
thread that started agents shows an **N agents** row under it; tap it to see
each agent's status and model, and tap an agent to open it. Settled threads
wait in a collapsed **Settled · N** row at the bottom of their folder. Search
looks through every folder, settled threads and agents included, and opens
whatever hides a match. **+** on a folder starts a new task in that project.

## Updating

Pull the latest ViewCode and run `eas build -p android --profile preview` again,
then install the new APK over the old one. Your pairing and settings stay. The
Play Store T3 Code app is separate and updates on its own.
