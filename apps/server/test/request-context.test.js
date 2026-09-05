import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRequestTraces,
  currentNodeUORequestContext,
  finishNodeUORequestContext,
  requestTraceSnapshot,
  withNodeUORequestContext,
} from '../src/systems/request-context.js';

afterEach(clearRequestTraces);

describe('NodeUO causal request context', () => {
  it('preserves trace and transaction identity across async boundaries', async () => {
    await withNodeUORequestContext({ id: 'session-1', accountName: 'alice' }, {
      id: 'request-1', feature: 'protocol.causality', traceId: 'trace-1',
      correlationId: 'correlation-1', transactionId: 'transaction-1',
    }, async () => {
      await Promise.resolve();
      expect(currentNodeUORequestContext()).toMatchObject({
        traceId: 'trace-1', correlationId: 'correlation-1', transactionId: 'transaction-1',
        requestId: 'request-1', account: 'alice',
      });
      finishNodeUORequestContext('handled');
    });
    expect(requestTraceSnapshot({ correlationId: 'correlation-1' })).toEqual([
      expect.objectContaining({ traceId: 'trace-1', outcome: 'handled', durationMs: expect.any(Number) }),
    ]);
  });
});
