import { createEngine } from '../engine/engine.js';
import { startDashboardServer } from './server.js';

const port = parseInt(process.env['DASHBOARD_PORT'] ?? '3000', 10);

async function main(): Promise<void> {
  console.log('Starting LLM Engine...');
  const engine = await createEngine();

  const models = engine.getAvailableModels();
  const providers = engine.getProviderStatus();

  console.log(`Loaded ${providers.length} providers, ${models.length} models`);
  for (const p of providers) {
    console.log(`  ${p.name}: ${p.state} (circuit: ${p.circuitState})`);
  }

  const { port: actualPort } = await startDashboardServer({ engine, port });
  console.log(`\nDashboard running at http://localhost:${actualPort}`);
}

main().catch((err) => {
  console.error('Failed to start dashboard:', err);
  process.exit(1);
});
