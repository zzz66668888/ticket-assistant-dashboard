# Ticket Assistant Dashboard

A compliant preparation dashboard for concerts, music festivals, product drops, and restocks.

## Features

- Countdown and manual purchase timeline
- Pre-sale checklist for account, identity, address, and payment readiness
- Public official-entry latency checks with average, P95, and failure-rate summaries
- Suggested entry lead time based on measured latency
- Stock-state simulation for planning UI flows
- Explicit boundary: no auto-ordering, queue bypassing, CAPTCHA handling, or platform rule circumvention

## Run Locally

```powershell
npm start
```

Open:

```text
http://localhost:4173/ticket-assistant.html
```

## Deploy To Railway

Railway can deploy this Node app directly from GitHub. The server reads `process.env.PORT` and listens on `0.0.0.0`, which is suitable for Railway public networking.

After deployment, open:

```text
https://your-railway-domain/ticket-assistant.html
```
