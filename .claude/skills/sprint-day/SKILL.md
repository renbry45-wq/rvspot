---
name: sprint-day
description: Run today's RVSpot MWF sprint sequence — park import, blog seed, wrangler deploy
disable-model-invocation: true
---

Run the RVSpot sprint-day sequence for today's date. All commands run from:
C:\Users\renbr\Desktop\rvspot\rvspot\

## Steps

1. Determine today's date slug. Format: {weekday-abbr}-{month-abbr}{day} (e.g. fri-may1, mon-apr27, wed-apr29). No leading zeros on the day.

2. Run park import:
   node scripts/add-parks-{slug}.js
   Wait for it to complete and report how many parks were added.

3. Run blog seed:
   node scripts/seed-blog-{slug}.js
   Wait for it to complete and report how many posts were seeded.

4. Deploy to Cloudflare:
   npx wrangler deploy
   Report the deployment URL and worker name from the output.

## Error handling
- If a script file for today's date does not exist, stop and tell the user. Do not guess at alternate filenames.
- If a step exits non-zero, stop and show the full error output. Do not proceed to the next step.
- If wrangler deploy fails, show the error and remind the user to check .dev.vars is not being deployed.

## Output
After all three steps succeed, print a brief summary:
- Parks added: N
- Blog posts seeded: N
- Deployed: [worker URL]
