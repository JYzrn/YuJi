# YuJi Vercel API

## Why

`*.workers.dev` blocked in China. `*.vercel.app` is accessible.
Vercel free tier: 100k invocations/month, no credit card.

## Deploy

1. https://vercel.com -> New Project -> Import the `vercel-api` folder (push to GitHub first)
2. Auto-detects `api/parse.js` serverless function
3. URL: `https://<project>.vercel.app`
4. Test: `https://<project>.vercel.app/api/parse?url=https://v.douyin.com/xxx`
5. Cloud function env: `YUJI_VERCEL_URL=https://<project>.vercel.app`

## API

- GET /api/parse?url=<encoded link>
- Returns: { code: 0, data: { platform, title, author, imageList[], videoUrl } }
