# Submitting Hive Helpers for Pi to PiOS

This file is a checklist and a draft proposal. **Nothing has been submitted yet.** This repository is private. Making it public, posting a Brainstorm proposal, and opening a pull request against [pi-apps/PiOS](https://github.com/pi-apps/PiOS) all need Osahon Ikuobase's approval, and several of those steps can only be done while signed in as him.

Official sources used to write this (retrieved 19 November 2026):

- PiOS process and licence: <https://github.com/pi-apps/PiOS>
- Licence text (used verbatim in [LICENSE](./LICENSE), with only the copyright line filled in): <https://github.com/pi-apps/PiOS/blob/main/LICENSE> (raw: <https://raw.githubusercontent.com/pi-apps/PiOS/main/LICENSE>)
- PiOS app and library list (the file a pull request would edit): <https://github.com/pi-apps/PiOS/blob/main/list.md>
- Brainstorm overview: <https://pi-apps.github.io/community-developer-guide/docs/gettingStarted/brainstorm/>
- PiOS / Brainstorm steps also summarised on the Pi hackathon pages: <https://minepi.com/hackathon-instructions/> and <https://minepi.com/developers/pi-hackathon/>

## Official process

From the [PiOS README](https://github.com/pi-apps/PiOS/blob/main/README.md), with Brainstorm details from the developer guide and hackathon instructions:

### 1. Create a Pi Brainstorm proposal *(Osahon's own login, in the Pi Browser)*

Projects without a Brainstorm proposal link will not be accepted.

1. Open the **Pi Browser** while signed in as Osahon Ikuobase (the Pioneer / developer account that should own the project).
2. Open the **Brainstorm** tile.
3. Create a new project proposal (the Brainstorm app is where Pioneers propose ideas and list projects). Use the draft text in the next section.
4. Copy the public proposal URL (existing listings use the form `https://brainstorm.pinet.com/project/<id>`). You will paste this into the PiOS list pull request.

This step cannot be done from this repository or from a GitHub login alone.

### 2. Open a pull request on pi-apps/PiOS adding the project to the list *(Osahon's GitHub login: Michael00820)*

Create a pull request on [pi-apps/PiOS](https://github.com/pi-apps/PiOS) that adds a row to [list.md](https://github.com/pi-apps/PiOS/blob/main/list.md). This package is a library, so the row belongs in the **SDKs and other libraries** table, not the App List. Follow the formatted row template already in that file. Incomplete submissions are rejected.

Information necessary for the PR to be approved:

- **Category** (for a library: `SDK`; propose a new category in the same PR only if needed)
- **Title**
  - Allowed forms: “App_Name for Pi”, “App_Name on Pi”, “App_Name”
  - Not allowed: “Pi App_Name” (to avoid confusion with apps developed by the Pi Core Team)
  - Pi's trademark guidance also says a name may include “Pi” but must **not** use it as a prefix. The GitHub repository is `pihive-pi-helpers` (it starts with “pi”). For the official list / Brainstorm title, prefer a name that does not start with “Pi”, for example **Hive Helpers for Pi**. Title confirmed by Osahon on 19 Nov 2026: **Hive Helpers for Pi**.
  - The project must include this language in its code (already present in LICENSE, README and the package entry files): *Pi, Pi Network and the Pi logo are trademarks of the Pi Community Company.*
- **Description** — short description of what the library aims to achieve
- **Programming Languages + Framework**
- **Link to Pi Brainstorm project proposal** (required; the PR will be rejected without it)

Information **not** necessary for the PR to be approved (the Core Team fills in the repo link on approval):

- Link To Repo
- Link to Testnet App
- Link to Mainnet App

Draft row for the SDKs table (Brainstorm link to be filled in after step 1):

```
| Hive Helpers for Pi | TypeScript helpers for Pi Browser sign-in, server-side /v2/me verification, user-to-app payment approve/complete, and app-to-user payouts with a Horizon reader. | SDK | TypeScript | TBD | <Brainstorm URL> |
```

**Do not open this pull request until Osahon has approved the submission and the Brainstorm URL exists.**

### 3. Pi Core Team approves the PR and creates a repository under `pi-apps`

If the PR is accepted, the Core Team:

- merges it,
- creates a repository under <https://github.com/pi-apps>,
- invites the **GitHub user who submitted the pull request** as admin of that new repository.

That admin can add team members, accept community pull requests, and later move or delete the repository. The Core Team does not maintain the application code.

### 4. Put the PiOS licence in the hosted repository and develop there

The [PiOS README](https://github.com/pi-apps/PiOS/blob/main/README.md) says: edit the copyright line of the LICENSE file in the new repository and start coding. The official licence source is <https://github.com/pi-apps/PiOS/blob/main/LICENSE>. To be included in the PiOS app list you must use this licence without alterations, aside from the copyright notice.

This private repository already uses that official text, with the copyright line set to:

```
Copyright (C) 2026 Osahon Ikuobase
```

After `pi-apps` hosts a copy, copy or push the same tree (still with no keys or secrets) into the new repository. The Core Team fills the “Link To Repo” column on approval.

### 5. Optional later updates

When a Testnet or Mainnet demo exists, the project admin can send a later pull request to add those links on the list. To leave the PiOS library later, the admin can move the repository out of `pi-apps` and open a PR to remove the row.

## Draft Brainstorm proposal

Use or adapt this text when creating the proposal in Brainstorm. The title avoids a “Pi …” prefix, per the naming rules above.

**Title:** Hive Helpers for Pi

**Short description:**

Hive Helpers for Pi is a TypeScript library that other official Pi Network apps can use for the common Pi Platform work: signing a Pioneer in from the Pi Browser, verifying that sign-in on the server with `GET /v2/me`, approving and completing user-to-app payments, and sending app-to-user payouts (including a read-only Horizon client to check transactions and balances). It is not a marketplace or a consumer app. It is the reusable Pi integration layer extracted from PiHive, published under the PiOS License so it may be used only inside the official Pi Network.

**What it is / who it is for:**

A small open-source toolkit for community developers building Pi Browser apps in TypeScript or JavaScript (for example Express or other Node servers plus a frontend that loads the official Pi JS SDK).

**Problem it solves:**

Every Pi app has to do the same careful work: never trust a uid the browser sends, talk to the Platform API with the server API key, wrap `Pi.createPayment` callbacks, sign A2U transactions without leaking the app wallet seed, and retry completions idempotently. This library packages those pieces so a new app does not have to re-implement them.

**How it uses Pi:**

- Pioneers sign in with the official Pi SDK; the server verifies the access token at `https://api.minepi.com/v2/me`.
- User-to-app payments are approved and completed through the official Pi Platform payment endpoints.
- App-to-user payouts are created on the Platform API, signed against Pi's Horizon, and completed on the Platform API.
- Use is limited to official Pi Network applications by the PiOS License.

**Programming languages and framework:** TypeScript (Node.js 18+, the official Pi JS SDK in the browser, `@stellar/stellar-sdk` only on the server for A2U).

**Category:** SDK / Ecosystem tools

**Notes the proposal can mention:**

- The copyright holder is Osahon Ikuobase (GitHub: Michael00820).
- PiHive, the marketplace this was extracted from, remains a separate private project and is not itself licensed under PiOS.
- The source will be hosted under `pi-apps` if this submission is accepted; until then the source is public at `Michael00820/pihive-pi-helpers` (made public with Osahon's approval on 19 Nov 2026).

## What is already done in this repository

- Official PiOS licence text, copyright line `Copyright (C) 2026 Osahon Ikuobase`
- Trademark notice in LICENSE, README and package entry files
- Helper code, tests, and a typecheck/build
- Secret scan before the initial commit (see the scan notes kept with the commit work, not in the source tree)
- Public GitHub repository `Michael00820/pihive-pi-helpers` (not yet under `pi-apps`)

## What still needs Osahon's approval and login

| Step | Who must do it | Notes |
|---|---|---|
| Read the licence and confirm the copyright line | Osahon | Official text is unaltered except the copyright notice |
| Confirm the public title (recommended: “Hive Helpers for Pi”) | Osahon | Avoids a name that starts with “Pi” |
| Make `Michael00820/pihive-pi-helpers` **public** | Done 19 Nov 2026 | Scan history again if more commits are added. |
| Create the Brainstorm proposal | Osahon, in the Pi Browser | Paste the draft above. Only he can do this. |
| Open the pull request on `pi-apps/PiOS` (`list.md`) | Osahon (GitHub user Michael00820) | Include the Brainstorm URL. The user who opens the PR becomes admin of the `pi-apps` repo. |
| Accept the `pi-apps` invitation and push or copy this code there | Osahon | Confirm LICENSE is still the official PiOS text |
| Later: add Testnet/Mainnet links, or a demo, if you want them on the list | Osahon | Optional follow-up PRs |

No one else should make this repository public, post on Brainstorm, or open a pull request against `pi-apps/PiOS` unless Osahon has asked them to do that specific step.
