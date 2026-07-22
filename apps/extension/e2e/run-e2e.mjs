import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { rm } from 'node:fs/promises';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Invalid address type')));
      }
    });
    server.on('error', (err) => reject(err));
  });
}

async function main() {
  let outputDir = '';
  try {
    const port = await getFreePort();
    outputDir = `/tmp/opencode/2fa-playwright-${process.pid}-${port}`;
    const env = {
      ...process.env,
      PLAYWRIGHT_PORT: String(port),
      PLAYWRIGHT_OUTPUT_DIR: outputDir
    };

    const child = spawn('pnpm', ['exec', 'playwright', 'test', '--config', 'playwright.config.mjs'], {
      stdio: 'inherit',
      env,
      shell: false,
    });

    const code = await new Promise((resolve) => {
      child.on('exit', (c) => resolve(c ?? 0));
      child.on('error', (err) => {
        console.error('Child process error:', err);
        resolve(1);
      });
    });

    if (outputDir) {
      await rm(outputDir, { recursive: true, force: true });
    }
    process.exit(code);
  } catch (err) {
    console.error('Failed to run E2E tests:', err);
    if (outputDir) {
      try {
        await rm(outputDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.error('Cleanup error:', cleanupErr);
      }
    }
    process.exit(1);
  }
}

main();
