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

## Managing agents

Long-press an agent row for **Stop agent**, **Resume agent** or **Discard held
messages**. Long-press the thread that started them for **Stop all agents (N
running)**. A stopped agent is paused, not deleted: it shows **paused**, messages
from other agents wait for it, and **Resume** continues where it stopped.
Discard drops the waiting messages instead.

Inside a thread with agents, the **Active agents** strip above the composer
lists them with their status and model. Tap it to expand, tap an agent to open
it, and use **Stop** or **Resume** per agent or for all of them.

## Switching models

Tap the model chip in the composer to pick any model from any provider the
computer has set up, with its effort, fast mode and, for Claude, the 200k or 1M
context window. Another model from the same provider continues the same
session. Picking a different provider (marked **Handoff**) hands the chat
over on your next message: your messages carry over word for word, earlier
replies as a summary.

## Usage

Tap the chart button in the Home header (or **Settings → Usage**). **Limits**
shows every provider your computers report, Claude, Codex, Cursor, Command Code
and the rest: each window's share left, when it resets, and banked reset credits
where the provider has them. A provider that has not reported anything yet says
**No data yet**. **Waiting on a limit** lists threads a usage limit stopped, with
when each continues on its own ("Resumes at 9:31 PM"); tap one to open it and
cancel or resume it now. Opening the screen checks limits; pull down to check
again. **Usage** shows token use and estimated cost over time.

## Notifications

Your computer can notify the phone when an agent finishes, needs your approval
or an answer, hits a usage limit, or continues after the limit resets. A child
agent's notification is titled with the thread that started it. Tap a
notification to open its thread. Notifications show the thread title and the
event, never message text; they travel through Expo's push service and Google's
Firebase.

Turn them on in **Settings → Notifications → Phone notifications** and pick the
kinds you want. The phone registers with every computer it is connected to;
removing the phone under the computer's **Connections** stops them. Each
computer sends its own notifications, so it must be running, but the phone does
not need to be connected.

### One-time Firebase setup

Android delivers notifications through Firebase, so your build needs your own
Firebase project. Do this once, before building (see [Build and install](#build-and-install)):

1. In the [Firebase console](https://console.firebase.google.com), create a
   project, then **Add app → Android** with the package name
   `com.viewcode.app.preview`. Download `google-services.json`; skip the SDK
   steps.
2. Give the file to the build as `T3CODE_ANDROID_GOOGLE_SERVICES_FILE`, the
   variable the app config reads. For the cloud builder, from `apps/mobile`:

   ```bash
   eas env:create --environment preview --name T3CODE_ANDROID_GOOGLE_SERVICES_FILE \
     --type file --value ./google-services.json --visibility secret
   ```

   For builds and `eas` commands on your machine, also add
   `T3CODE_ANDROID_GOOGLE_SERVICES_FILE=/absolute/path/to/google-services.json`
   to the repository's `.env.local`. Keep the file out of git.

3. In Firebase, open **Project settings → Service accounts → Generate new
   private key**. Upload that key to Expo:

   ```bash
   eas credentials
   ```

   Choose **Android → preview → Google Service Account → Manage your Google
   Service Account Key for Push Notifications (FCM V1) → Upload a new service
   account key**, and pick the downloaded JSON. Then delete the local copy.

4. Rebuild with `eas build -p android --profile preview` and install the new
   APK. An update over the air cannot add Firebase to an existing install.

If **Phone notifications** says the build has no Firebase or no EAS project,
the build was made without step 2 or without `VIEWCODE_EAS_PROJECT_ID`.

## Updating

Pull the latest ViewCode and run `eas build -p android --profile preview` again,
then install the new APK over the old one. Your pairing and settings stay. The
Play Store T3 Code app is separate and updates on its own.
