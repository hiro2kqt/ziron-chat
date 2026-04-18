/**
 * Ziron Main Entry
 */

import { buildProgram } from './cli/index.js';
import { initializeGateway } from './gateway.js';

async function main() {
  // Initialize gateway before starting any channels
  await initializeGateway();

  const program = buildProgram();
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
