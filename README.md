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
| iOS & Android Developer \| React Native • Flutter | Mobile |
| AI Automation Engineer \| Chatbots • n8n • GHL | AI & automation |
| Logo • UI/UX • Illustration • Book Cover • Figma | Design |
| 2D/3D CAD \| AutoCAD • Civil • Blender 3D Rendering | CAD |
| Game Dev \| Unity • C# • Unreal • Roblox • Blender | Game |

Shortened labels such as "Game Dev | Unity" still match. If the profile doesn't match any row, the profile is left as it is.
Timelines in hours, weeks or months are converted to days (3 weeks becomes 21).

## Install

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and select `b1-claude/`. Do the same for `b2-freelancer/`.
3. Check the IDs. Each extension has a fixed ID set by the `key` in its manifest, and the two use these IDs to find each other:
   - B1: `healnpcjminpoeiichodknaejnbjojmp`
   - B2: `nlejmfpbabcofjkfpdinpkccflhbofjf`

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

Open a project page on freelancer.com and click **Write bid**. The status bubble shows progress. After about 10–60 s the proposal box is filled and outlined in green.

## Notes

- B1 sends Claude's whole last reply, with each code box wrapped in ``` so B2 can find the bid. If there is no code box, B2 uses everything after the Profile line.
- The status bubble lists what was filled, and anything that was skipped or not found.
- claude.ai and freelancer.com change their HTML sometimes. The selectors are at the top of each `content.js`
  (`findInput`, `findSendButton`, `assistantMessages`, `findBidTextarea`, `projectDetailsContainer`)
  and include fallbacks.
- After you reload an extension, refresh any freelancer.com / claude.ai tabs that were already open.
