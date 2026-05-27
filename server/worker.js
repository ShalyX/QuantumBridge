import { store } from './store.js';
import { startIrisWorker } from './iris-worker.js';

const worker = startIrisWorker(store);

console.log(`[QuantumBridge Worker] Circle Iris polling enabled (${store.kind})`);

function shutdown() {
    worker.stop();
    console.log('[QuantumBridge Worker] stopped');
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
