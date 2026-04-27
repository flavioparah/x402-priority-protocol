const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const securityTestsDir = path.resolve(__dirname, '../tests/security');
const resultsFile = path.resolve(__dirname, '../test-results/security-results.json');

async function runTestFile(file) {
  return new Promise((resolve) => {
    console.log(`\n[Runner] Executing ${file}...`);
    const child = spawn('node', [path.join(securityTestsDir, file)], {
      stdio: 'inherit',
      env: { ...process.env, GATEWAY_URL: 'http://localhost:3000/rpc' }
    });

    child.on('close', (code) => {
      resolve(code === 0);
    });
  });
}

async function main() {
  const files = fs.readdirSync(securityTestsDir).filter(f => f.endsWith('.test.js'));
  console.log(`[Runner] Found ${files.length} security tests.`);

  for (const file of files) {
    await runTestFile(file);
  }

  console.log(`\n[Runner] All tests completed. Results saved to ${resultsFile}`);
}

main().catch(console.error);
