# Group Intelligence Dashboard

A static GitHub Pages site that tracks **[SCPF - Security Department]** (group `4606666`) over time — every member individually — turning the raw roster into promotion timelines, ascension velocity, rank-by-rank timing curves and predicted promotion windows.

**Real data only.** There is no demo mode and no synthetic sample data. The rank ladder shipped in `data/roles.json` was pulled live from the Roblox API; everything else appears once the collector runs.

---

## The thing you need to know first

**Roblox does not publish group join dates or promotion history.** The public API tells you who is in the group and what rank they hold *right now*, and nothing else. There is no endpoint that says "so-and-so was made Sergeant on March 4th."

So this project builds that history itself: a GitHub Action snapshots the full roster every 6 hours, diffs it against the previous snapshot, and records every change as an event. Run it for a month and you have a month of promotion data. Run it for a year and the timing curves get genuinely sharp.

Two honest consequences, surfaced in the UI rather than hidden:

- Members already in the group on day one are marked **pre-existing**. Their tenure is a *lower bound* ("tracked since"), never a join date, and their first rank spell is excluded from timing statistics because we never saw it start.
- Everything improves with time. The first run is a baseline, not a dataset.

---

## Setup

**1. Create the repo**

```bash
git init
git add .
git commit -m "Group intelligence dashboard"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

**2. Let Actions write to the repo**

`Settings → Actions → General → Workflow permissions` → **Read and write permissions** → Save.

Without this the collector runs fine but cannot commit the snapshot it just took.

**3. Turn on Pages**

`Settings → Pages → Source: Deploy from a branch` → branch `main`, folder **`/docs`** → Save.

The site lands at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

**4. Take the first snapshot**

`Actions → Collect group snapshot → Run workflow`. Takes well under a minute for a group this size.

Until that finishes the dashboard shows the real rank ladder and live headcounts from the group API, with an *Awaiting the first roster snapshot* banner over the history-derived panels. After it finishes, the roster fills in. After the second run, movement starts appearing. Promotion windows need about five completed promotions per rank before they unlock.

---

## The real rank ladder

Fetched from `groups.roblox.com/v1/groups/4606666/roles`:

| Rank | Role | Members |
|---:|---|---:|
| 255 | The Administrator | 1 |
| 254 | Chairman of the Council | 1 |
| 253 | Overseer | 1 |
| 252 | O5 Council | 2 |
| 185 | `--------------------` | 1 |
| 180 | Chief of Security | 1 |
| 170 | Security Lieutenant | 4 |
| 150 | Security Officer | 9 |
| 100 | Security Corporal | 17 |
| 60 | Security Specialist | 28 |
| 50 | Security Sentry | 85 |
| 40 | Security Guard | 68 |
| 30 | Security Agent | 134 |
| 20 | Security Cadet | 102 |
| 1 | Security Intern | 131 |

Three properties of this group's API response drive real logic in the collector, and each one broke an earlier version:

**The `Member` base role is a phantom.** Roblox auto-generates a role (`isBase: true`, rank 1) whose user list is not "members with no other role" — it returns the **entire membership**, group owner included. Fetched in parallel with the real roles it would overwrite everyone's true rank with "Member". The collector therefore fetches base roles *first, alone*, and lets every specific role overwrite them afterwards. Anyone still sitting in the base role genuinely holds no other role. It is hidden from the pyramid, since its member count is the whole group.

**Rank is not unique.** `Member` and `Security Intern` are both rank 1. Keying anything by rank silently drops one of them and makes a move between the two invisible. Every identity in this codebase is a `roleId`; a role change with no rank change is recorded as a **lateral** move rather than a promotion.

**`--------------------` is a real role.** Groups use punctuation roles as visual spacers. It is detected, kept in the ladder, rendered as a divider rule in the pyramid, and excluded from the rank timing cards.

To track a different group, change `groupId` in `config.json` and delete `data/roles.json` and `data/group.json` — the collector regenerates both.

---

## What it shows

**Overview** — membership growth, promotion outlook for the whole roster, the rank pyramid with due-for-promotion shading, daily join/promote/leave activity, and a live movement feed.

**Roster** — every tracked member in a virtualized table. Search, filter by rank or promotion status, sort by any column. Click anyone for their full record.

**Promotions** — a weekday × hour heatmap of when promotions actually happen (this reveals when leadership runs rank reviews), a role transition matrix, and the complete movement log.

**Ranks** — per-rank timing cards showing the middle 50% of observed time-in-rank with the median marked, current headcount, and 90-day throughput.

**Leaderboards** — fastest ascension, up next, most promotions, quickest single jump, longest stalled, longest tracked, command, oldest accounts.

**Member drawer** — avatar, current rank, full ascension timeline with the duration of every spell, and the promotion window prediction.

---

## How the promotion window is calculated

For each role, the engine collects every *completed, uncensored* spell that ended in a promotion — how long people actually sat there before moving up — and builds a distribution.

A member's prediction blends two signals:

- the **cohort curve** for their current role (p25 / p50 / p75)
- their **own promotion cadence**, if they have at least two observed promotions, weighted at 40% (`config.json → stats.personalCadenceWeight`)

Status thresholds come from the distribution itself rather than a fixed multiplier, so a role with a naturally long tail doesn't flag half its holders as stalled:

| Status | Meaning |
|---|---|
| **On track** | Time served is at or below the role's median |
| **Due** | Past the median, within the 75th percentile |
| **Overdue** | Past the 75th percentile |
| **Stalled** | Past the 90th percentile |
| **No data yet** | Fewer than 5 completed promotions observed from this role |

The **readiness** bar reads: *"longer than 68% of the members who were promoted out of this role."*

One caveat worth understanding: the stalled bucket will look large at first, and that is statistically correct rather than a bug. The cohort distribution is built from *completed* spells, while the people currently sitting at a rank are disproportionately the slow ones — everyone quick already moved on. This is length-biased sampling, and it settles as history accumulates.

These predictions describe observed patterns. They are not group policy and carry no authority over who actually gets promoted.

---

## Configuration

Everything lives in `config.json`.

| Key | Default | Notes |
|---|---|---|
| `groupId` | `4606666` | The only value you must change to track a different group |
| `tracking.trackAllMembers` | `true` | Every member individually |
| `tracking.leaveGracePeriod` | `2` | Consecutive misses before a member counts as departed |
| `tracking.fetchAccountDetails` | `true` | Account creation dates for new members, cached forever |
| `collection.roleConcurrency` | `4` | Roles fetched in parallel. Raise carefully — Roblox rate-limits hard |
| `stats.minSamplesForPrediction` | `5` | Completed promotions needed before a role gets a prediction curve |

Change the snapshot cadence in `.github/workflows/collect.yml` (`cron: "7 */6 * * *"`).

---

## Local use

```bash
npm run collect   # take a real snapshot (hits the Roblox API)
npm run build     # regenerate docs/data/ from data/
npm run serve     # preview at http://localhost:8080
npm test          # collector + UI regression suites (needs: npm install)
```

The test suite covers the three API quirks above using recorded real response shapes: base-role clobbering, the rank-1 collision and lateral moves, the departure grace period, and the refusal to overwrite state from an empty roster.

---

## How the data is stored

```
data/                       committed state — the source of truth
  roles.json, group.json    group metadata (ships pre-seeded from the live API)
  members.ndjson            one line per member: current role + full role history
  events.ndjson             append-only log of every observed change
  snapshots.ndjson          one line per run: totals and per-role headcount
docs/data/                  generated payloads the site loads
```

State is **newline-delimited JSON sorted by user id**. A roster serialised as a single JSON blob means git stores a fresh copy of the whole file on every one of the ~120 commits a month this repo makes. Line-oriented NDJSON means a snapshot that changes 40 members produces ~40 changed lines, so repo growth tracks real churn instead of roster size. The member index the browser downloads is columnar and rounded for the same reason.

---

## Failure modes that are handled

- **Rate limiting** — a global cooldown, so one 429 pauses every worker instead of burning N parallel retries. Honours `Retry-After`, exponential backoff with jitter.
- **Partial fetches** — if any role fails to enumerate, departure detection is disabled for that run. A half-fetched roster must never be read as "everyone left."
- **Pagination drift** — a member can transiently vanish from a paginated roster mid-fetch, so a departure requires two consecutive misses.
- **Empty responses** — the collector refuses to overwrite state with an empty roster.
- **Concurrent runs** — the workflow uses a concurrency group, and pushes rebase-and-retry.
- **Interrupted writes** — state is written to a temp file and renamed, so a killed runner leaves the previous snapshot intact.

---

## Notes

Avatars use Roblox's stable headshot redirect rather than the thumbnails API, whose signed CDN URLs expire within hours. Requests go from the visitor's browser straight to Roblox, so they cost the Action nothing.

All Roblox endpoints used are public and unauthenticated. No cookies, no tokens, nothing to leak.
