# void example: static-site

Tiny static site for testing the void deploy pipeline end-to-end.

**Build:** `npm run build` (copies index.html to dist/)
**Serve:** `npm start` (serves dist/ on port 3000)

For the real test, point void at this repo:
```json
{
  "repo_url": "https://github.com/retraut/void",
  "ref": "main",
  "build_command": "cd examples/static-site && npm run build",
  "serve_command": "cd examples/static-site && npm start",
  "port": 3000
}
```

The agent will:
1. `git clone https://github.com/retraut/void /tmp/build/<id>`
2. `cd /tmp/build/<id> && cd examples/static-site && npm run build`
3. `cd /tmp/build/<id> && cd examples/static-site && npm start` (in background)
4. Report back with local port 3000
5. (Next step: cloudflared tunnel for public access)
