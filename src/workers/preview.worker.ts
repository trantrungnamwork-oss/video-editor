import { PreviewSession } from '../media/preview/previewSession';
import type { FromWorker, ToWorker } from '../media/preview/protocol';

const session = new PreviewSession((msg: FromWorker, transfer?: Transferable[]) =>
  postMessage(msg, { transfer: transfer ?? [] }),
);

self.onmessage = (e: MessageEvent<ToWorker>) => session.handle(e.data);
