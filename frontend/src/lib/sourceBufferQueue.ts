export type SourceBufferQueue = {
  enqueue: (op: () => void) => void;
  dispose: () => void;
};

/**
 * SourceBuffer.appendBuffer/remove are async and mutually exclusive
 * (guarded by `updating`). This serializes both kinds of operations
 * through a single FIFO so callers never touch the raw SourceBuffer.
 */
export function createSourceBufferQueue(sourceBuffer: SourceBuffer, meetingId?: string): SourceBufferQueue {
  const queue: Array<() => void> = [];

  const drain = () => {
    if (sourceBuffer.updating || queue.length === 0) return;
    const op = queue.shift();
    op?.();
  };

  const onError = (e: Event) => console.error('[debug] SourceBuffer error', meetingId, e);
  const onUpdateEndDebug = () => console.log('[debug] updateend', meetingId, sourceBuffer.buffered.length);

  sourceBuffer.addEventListener('updateend', drain);
  sourceBuffer.addEventListener('error', onError);
  sourceBuffer.addEventListener('updateend', onUpdateEndDebug);

  return {
    enqueue(op: () => void) {
      queue.push(op);
      drain();
    },
    dispose() {
      sourceBuffer.removeEventListener('updateend', drain);
      sourceBuffer.removeEventListener('error', onError);
      sourceBuffer.removeEventListener('updateend', onUpdateEndDebug);
      queue.length = 0;
    },
  };
}
