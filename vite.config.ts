import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// The commit a build came from, stored with each claim: worlds drift as the generator changes,
// and this records which generator a claim was made under.
let build = 'dev';
try { build = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* not a checkout */ }

// No /api proxy: `npm run dev` runs without claims (the panel says they're unavailable). To try
// claims, build and run `npx wrangler@4 dev`, which serves dist/ and the Worker together.
export default defineConfig({
  define: { __MUNDI_BUILD__: JSON.stringify(build) },
});
