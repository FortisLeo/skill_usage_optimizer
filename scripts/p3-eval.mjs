import { spawnSync } from 'node:child_process';
const result = spawnSync('npx', ['vitest', '--run', 'tests/mcp-p3.test.ts'], { stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
