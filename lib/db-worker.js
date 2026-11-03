import { parentPort, workerData } from 'node:worker_threads';
import { Store } from './store.js';

const store = new Store(workerData.path, workerData.ownerToken);
const lease = workerData.ownerToken ? setInterval(() => store.renew(), 15000) : null;
lease?.unref();
parentPort.postMessage({ ready: true });
parentPort.on('message', ({ id, method, args }) => {
  try {
    if (!['sync', 'pending', 'putEmbeddings', 'failed', 'search', 'keywordSearch', 'status', 'setState', 'rebuild', 'readMemory', 'pendingMemory', 'memoryCounts', 'saveMemory', 'commitMemory', 'close'].includes(method)) throw new Error('Unknown database method');
    const value = store[method](...args);
    parentPort.postMessage({ id, value });
    if (method === 'close') { clearInterval(lease); parentPort.close(); }
  } catch (error) { parentPort.postMessage({ id, error: error.message, code: error.code }); }
});
