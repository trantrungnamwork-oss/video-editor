import { probeInWorker } from '../media/workerProbe';

void probeInWorker(globalThis).then((result) => postMessage(result));
