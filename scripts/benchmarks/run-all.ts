import { spawn } from 'node:child_process';

const runCommand = (file: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', file],
      {
        stdio: 'inherit',
        cwd: process.cwd(),
        env: process.env,
      },
    );

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${file} exited with code ${code}`));
      }
    });
  });

const run = async () => {
  await runCommand('scripts/benchmarks/run-retrieval.ts');
  await runCommand('scripts/benchmarks/run-agent.ts');
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
