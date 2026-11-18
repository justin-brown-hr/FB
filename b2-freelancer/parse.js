// Parses Claude's full BID reply into { bid, profile, amount, days }.
// Expected reply shape:
//   Profile: Logo • UI/UX • Illustration • Book Cover • Figma · $75 (3 h) · 2 days
//   ```
//   Hi there, ...            <- the bid (code block)
//   ```
//   Notes for you that must NOT go into the bid...
(function (root) {
  // Full profile label (as Claude writes it)  ->  option name in Freelancer's "Select a profile" dropdown
  const PROFILES = [
    { label: 'Software Consultant | Web Platforms • SaaS • AI', option: 'General' },
    { label: 'iOS & Android Developer | React Native • Flutter', option: 'Mobile' },
    { label: 'AI Automation Engineer | Chatbots • n8n • GHL', option: 'AI & automation' },
    { label: 'Logo • UI/UX • Illustration • Book Cover • Figma', option: 'Design' },
    { label: '2D/3D CAD | AutoCAD • Civil • Blender 3D Rendering', option: 'CAD' },
    { label: 'Game Dev | Unity • C# • Unreal • Roblox • Blender', option: 'Game' }
  ];

  const norm = (s) => (s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9#+]+/g, ' ').trim();
  const tokens = (s) => new Set(norm(s).split(' ').filter(Boolean));

  // Best matching profile for a free-text profile string, or null.
  function matchProfile(text) {
    if (!text) return null;
    const t = norm(text);
    for (const p of PROFILES) {
      if (t === norm(p.label) || t === norm(p.option)) return p;
    }
    const tt = tokens(text);
    let best = null, bestScore = 0;
    for (const p of PROFILES) {
      const pt = tokens(p.label);
      let hit = 0;
      pt.forEach((w) => { if (tt.has(w)) hit++; });
      // share of the label's words found, or (for shortened labels) share of the text's words in the label
      const score = Math.max(hit / pt.size, tt.size >= 2 ? hit / tt.size : 0);
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return bestScore >= 0.6 ? best : null;
  }

  function parseDays(s) {
    const m = (s || '').match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mo)\b/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const u = m[2].toLowerCase();
    let days = n;
    if (/^(h|hr|hrs|hour|hours)$/.test(u)) days = n / 24;
    else if (/^(w|wk|wks|week|weeks)$/.test(u)) days = n * 7;
    else if (/^(mo|month|months)$/.test(u)) days = n * 30;
    return Math.max(1, Math.ceil(days));
  }

  function parseProfileLine(line) {
    const out = { profileText: null, amount: null, days: null };
    const body = line.replace(/^\W*profile\s*[:\-–]\s*/i, '').replace(/\*\*/g, '');
    // fields are separated by a middle dot "·" (or " | " / " - " as a fallback)
    let parts = body.split(/\s*·\s*/);
    if (parts.length < 2) parts = body.split(/\s+[-–—]\s+/);
    const rest = [];
    for (const raw of parts) {
      const p = raw.trim();
      if (!p) continue;
      const money = p.match(/(?:[$€£₹]|USD|EUR|GBP|INR)\s*([\d,]+(?:\.\d+)?)/i) || p.match(/^([\d,]+(?:\.\d+)?)\s*(?:USD|\$)/i);
      if (out.amount == null && money) { out.amount = parseFloat(money[1].replace(/,/g, '')); continue; }
      if (out.days == null && /\b(days?|weeks?|months?|hours?|hrs?)\b/i.test(p) && !/[$€£₹]/.test(p)) {
        out.days = parseDays(p);
        if (out.days != null) continue;
      }
      rest.push(p);
    }
    out.profileText = rest.join(' · ') || null;
    return out;
  }

  // The bid is Claude's code box (B1 wraps code boxes in ```). No code box = no bid.
  function extractBid(text) {
    const fences = [...text.matchAll(/```[^\n]*\n([\s\S]*?)\n?```/g)].map((m) => m[1].trim()).filter(Boolean);
    if (!fences.length) return null;
    return fences.reduce((a, b) => (b.length > a.length ? b : a)); // the bid is the biggest box
  }

  function parseBidResponse(text) {
    text = (text || '').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const profileIdx = lines.findIndex((l) => /^\W*profile\s*[:\-–]/i.test(l.trim()));
    const meta = profileIdx >= 0 ? parseProfileLine(lines[profileIdx].trim()) : { profileText: null, amount: null, days: null };
    const profile = matchProfile(meta.profileText);
    return {
      bid: extractBid(text),            // string, or null when there is no code box
      profileText: meta.profileText,
      profile,                 // { label, option } or null
      amount: meta.amount,     // number or null
      days: meta.days          // integer or null
    };
  }

  const api = { parseBidResponse, matchProfile, parseDays, PROFILES, norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FBAParse = api;
})(typeof self !== 'undefined' ? self : this);
