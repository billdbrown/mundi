import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// The commit a build came from, stored with each claim: worlds drift as the generator changes,
// and this records which generator a claim was made under.
let build = 'dev';
try { build = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* not a checkout */ }

export default defineConfig({
  define: { __MUNDI_BUILD__: JSON.stringify(build) },
  // `npm run dev` has no Worker: point /api at `npx wrangler dev` (port 8787) when it runs.
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
