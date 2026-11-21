# Freelancer Bid Assistant

Two Chrome / Edge extensions that work together:

| | Folder | Runs on | Does |
|---|---|---|---|
| **B1** | `b1-claude/` | claude.ai | Receives project details from B2, types them into your pinned **BID** chat, waits for Claude's answer, sends the bid back to B2 |
| **B2** | `b2-freelancer/` | freelancer.com project pages | Adds **Copy project** and **Write bid** buttons (bottom-right) |

- **Copy project**: copies the project title, URL, budget, description and skills to the clipboard.
- **Write bid**: copies the project and sends it to B1. B1 returns Claude's full reply, and B2 picks out the parts and fills the bid form:

  ```
  Profile: Logo • UI/UX • Illustration • Book Cover • Figma · $75 (3 h) · 2 days   -> profile "Design", Bid Amount 75, delivered in 2 days
  ```text
  Hi there, ...                                                                    -> the code box goes into "Describe your proposal"
  ```
  Notes for you ...                                                                -> ignored
  ```

  Nothing is submitted. You review the form and place the bid yourself.

### Profile mapping (`b2-freelancer/parse.js`, `PROFILES`)

| Profile in Claude's reply | Option in "Select a profile" |
|---|---|
| Software Consultant \| Web Platforms • SaaS • AI | General |
| iOS & Android App \| React Native • Flutter • SaaS | Mobile |
| AI Automation Engineer \| Chatbots • n8n • GHL | AI & automation |
| Logo • UI/UX • Illustration • Book Cover • Figma | Design |
| 2D/3D CAD \| AutoCAD • Civil • Blender 3D Rendering | CAD |
| Game Dev \| Unity • C# • Unreal • Roblox • Blender | Game |

Shortened labels such as "Game Dev | Unity" still match. If the profile doesn't match any row, the profile is left as it is.
Timelines in hours, weeks or months are converted to days (3 weeks becomes 21).

## Install

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and select `b1-claude/`. Do the same for `b2-freelancer/`.
3. B2 finds B1 by its name, so the extension IDs don't matter. Chrome will say both can "manage your apps, extensions and themes". They need that only to find each other.
4. Click the **B2** toolbar icon and then **Check** to confirm everything is connected.

## Set up B1

1. Log in to claude.ai and open your pinned **BID** chat.
2. Click the B1 toolbar icon, then **Use current tab** and **Save**.
   If you skip this, B1 looks for a sidebar chat named `BID` and remembers it.
3. Optional settings:
   - **Message template**: `{project}` is replaced with the project text. For example: `Write a bid for this project. Reply with the bid text only.\n\n{project}`
   - **Switch to the Claude tab while writing**: off by default. Claude runs in a background tab.
   - **Timeout**: default 240 s.

Keep a claude.ai tab open (or let B1 open one). B1 sends the message as you, in your own logged-in session.

## Use

Open a project page on freelancer.com and click **Write bid** (top right). A one-line alert at the top center shows progress and then the result. It hides by itself (it stays while your mouse is over it), and × closes it:

- **Success:** the profile matched one of your 6 profiles *and* Claude's reply had a code box. The form is filled, and the alert shows a **Bid** button.
  Clicking **Bid** ticks **SEALED** under Optional Upgrades and clicks **Place Bid**. Nothing else is ticked.
- **Failed:** there was no code box, or the profile didn't match. The alert lists why. Whatever could be filled is filled, but the Bid button stays grey (inactive), so you place the bid yourself.

## B1 on a VPS, B2 on your PC

1. **On the VPS**, run one command:
   ```bash
   sudo bash FB/relay/setup.sh
   ```
   It installs everything, keeps a small relay running (also after reboots) and prints a **pairing code** like `203.0.113.7:8787/9f3c…`.
2. Paste the pairing code into the **B1** popup (in the VPS Chrome) and the **B2** popup (on your PC), and click **Save** in each.
3. B2's popup should say **All good ✓**.

If your VPS provider has its own firewall or security group, allow TCP port 8787 there. Chrome on the VPS must keep running and stay logged in to claude.ai.
To use B1 and B2 in the same Chrome again, clear the pairing code.

Advanced: the relay uses plain HTTP. For HTTPS, put it behind your own domain (e.g. `caddy reverse-proxy --from bids.example.com --to 127.0.0.1:8787`) and use `https://bids.example.com/<token>` as the pairing code.

## Troubleshooting

- **Nothing appears on `chrome://extensions` after Load unpacked:** Chrome was started with `--disable-extensions`. Check `chrome://version` → Command Line, then restart Chrome without that flag.
- **The B2 status bubble shows an error:** click B2's icon, then **Check**. It tells you which part is missing: B1 off or not installed, not logged in to claude.ai, or no chat named BID.
- **Buttons missing on a Freelancer page:** refresh the page after installing or reloading the extensions. Regional sites such as freelancer.in and freelancer.co.uk are supported.

## Notes

- B1 sends Claude's whole last reply, with each code box wrapped in ``` so B2 can find the bid. If there is no code box, B2 uses everything after the Profile line.
- The status bubble lists what was filled, and anything that was skipped or not found.
- claude.ai and freelancer.com change their HTML sometimes. The selectors are at the top of each `content.js`
  (`findInput`, `findSendButton`, `assistantMessages`, `findBidTextarea`, `projectDetailsContainer`)
  and include fallbacks.
- After you reload an extension, refresh any freelancer.com / claude.ai tabs that were already open.
