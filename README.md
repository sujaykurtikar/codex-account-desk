# Account Desk

A shared dashboard for tracking Codex account usage and choosing an account with enough short-window and weekly allowance. The account list starts empty and grows only when someone adds an account. Connected identities are named by the email returned during OpenAI sign-in.

## Deploy on Render

1. Push this folder to a Git repository and create a Render Blueprint from its `render.yaml`.
2. Set `DASHBOARD_PASSWORD` to a strong group password in Render. Share it only with people who should see and manage the account list.
3. Deploy. Render provides the public URL; everyone using it signs in with the same group password and sees the same list.

The Blueprint uses a persistent disk and a single paid Starter web service. Do not switch it to a free web service: free instances have ephemeral storage and cannot retain account profiles across restarts. Back up the disk and restrict the shared password because authorized users can add, disconnect, or delete accounts.

Each account is connected using the official OpenAI device sign-in flow, which works when the dashboard is hosted remotely. Verify the email shown by OpenAI before confirming. Account credentials are isolated in the server's persistent data directory; they are not sent to the browser or included in exported snapshots. The Render deployment runs a Codex app-server process per connected account.

## Run locally

Requires Node.js 22+ and the Codex CLI. Install dependencies and start:

```sh
npm ci
npm start
```

Open http://127.0.0.1:4317. Set `CODEX_BIN` if the Codex CLI is not on `PATH`. Local data is stored under `~/.local/share/codex-account-desk/` unless `ACCOUNT_DESK_DATA` is set. Directly opening `index.html` enables a separate manual-only workspace in browser storage.

## Recommendations

The dashboard tracks remaining allowance percentages, not raw token counts. It ranks accounts only when both usage windows are known, fresh, above the reserve, and not past their reset time. Connected snapshots refresh every five minutes. Unknown allowance is never treated as 100%.

- **Balanced:** weights short-window headroom, weekly headroom, and reset timing.
- **Capacity:** prioritizes available headroom across both windows.
- **Reset:** prioritizes a short-window reset that is approaching.

These are scheduling heuristics, not guaranteed optimal token allocation: task costs and future demand are unknown. Different usage windows are not interchangeable token units.

## Verify

```sh
npm test
npm run test:browser
```

The protocol uses the [Codex app-server API](https://learn.chatgpt.com/docs/app-server). No model inference is requested for monitoring.
