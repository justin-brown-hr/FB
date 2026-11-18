# Freelancer Bid Assistant: notes for Claude

- **Always bump the version** in the `manifest.json` of every extension you change (`b1-claude/`, `b2-freelancer/`)
  in the same commit. The user checks the version on `chrome://extensions` and in each popup to confirm they have the update.
  Use semver: patch for fixes (1.1.0 → 1.1.1), minor for new features (1.1.0 → 1.2.0).
- Mention the new version number(s) in the reply to the user.
- `relay/` has no version number. Mention when it changed so the user re-runs `sudo bash relay/setup.sh` on the VPS.
