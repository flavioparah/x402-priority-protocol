const fs = require('fs');
const path = require('path');

const now = new Date().toISOString();

const resultsDir = path.resolve(__dirname, '../test-results');
const reportsDir = path.resolve(__dirname, '../reports/generated');

if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const securityResults = readJsonIfExists(path.join(resultsDir, "security-results.json"));
const loadResults = readJsonIfExists(path.join(resultsDir, "load-results.json"));
const mainnetResults = readJsonIfExists(path.join(resultsDir, "mainnet-results.json"));

function summarize(results) {
  const summary = {
    PASSED: 0,
    FAILED: 0,
    NOT_RUN: 0,
    BLOCKED: 0,
    INCONCLUSIVE: 0,
  };

  if (!results || !Array.isArray(results.tests)) {
    summary.NOT_RUN += 1;
    return summary;
  }

  for (const test of results.tests) {
    const status = test.status || "INCONCLUSIVE";
    if (summary[status] === undefined) summary.INCONCLUSIVE += 1;
    else summary[status] += 1;
  }

  return summary;
}

const summary = {
  generatedAt: now,
  security: summarize(securityResults),
  load: summarize(loadResults),
  mainnet: summarize(mainnetResults),
};

const pt = `# Relatório Gerado — x402-Shield

Data/Hora: ${now}

## Resumo

Este relatório foi gerado automaticamente a partir dos arquivos encontrados em \`test-results/\`.

## Security

\`\`\`json
${JSON.stringify(summary.security, null, 2)}
\`\`\`

## Load

\`\`\`json
${JSON.stringify(summary.load, null, 2)}
\`\`\`

## Mainnet

\`\`\`json
${JSON.stringify(summary.mainnet, null, 2)}
\`\`\`

## Observação

Este relatório não inventa resultados. Se arquivos de resultado não foram encontrados, a categoria deve ser considerada NOT RUN ou INCONCLUSIVE.
`;

const en = `# Generated Report — x402-Shield

Date/Time: ${now}

## Summary

This report was automatically generated from files found in \`test-results/\`.

## Security

\`\`\`json
${JSON.stringify(summary.security, null, 2)}
\`\`\`

## Load

\`\`\`json
${JSON.stringify(summary.load, null, 2)}
\`\`\`

## Mainnet

\`\`\`json
${JSON.stringify(summary.mainnet, null, 2)}
\`\`\`

## Note

This report does not fabricate results. If result files were not found, the category must be considered NOT RUN or INCONCLUSIVE.
`;

fs.writeFileSync(path.join(reportsDir, "TEST_RESULTS_PT_BR.generated.md"), pt);
fs.writeFileSync(path.join(reportsDir, "TEST_RESULTS_EN.generated.md"), en);

console.log("Reports generated:");
console.log("- reports/generated/TEST_RESULTS_PT_BR.generated.md");
console.log("- reports/generated/TEST_RESULTS_EN.generated.md");
