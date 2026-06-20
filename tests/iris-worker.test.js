import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileTransfer } from '../server/iris-worker.js';

const CHECKED_AT = '2026-06-20T12:00:00.000Z';

function createStore() {
    const patches = [];
    return {
        patches,
        async patchTransfer(id, patch) {
            patches.push({ id, patch });
            return { id, ...patch };
        },
    };
}

test('worker marks an unindexed burn as attestation pending', async () => {
    const store = createStore();
    await reconcileTransfer(store, {
        id: 'transfer-1',
        state: 'burn_submitted',
        burnTxHash: '0xburn',
        sourceDomain: 26,
        metadata: {},
    }, {
        fetchAttestation: async () => ({ status: 'not_indexed' }),
        now: () => CHECKED_AT,
    });

    assert.equal(store.patches.length, 1);
    assert.equal(store.patches[0].patch.state, 'attestation_pending');
    assert.equal(store.patches[0].patch.metadata.workerStatus, 'not_indexed');
});

test('worker completes a forwarded transfer when Circle reports its fill', async () => {
    const store = createStore();
    await reconcileTransfer(store, {
        id: 'transfer-2',
        state: 'attestation_pending',
        burnTxHash: '0xburn',
        sourceDomain: 26,
        useForwarder: true,
        metadata: {},
    }, {
        fetchAttestation: async () => ({
            status: 'complete',
            message: { forwardTxHash: '0xfill', forwardState: 'complete' },
        }),
        now: () => CHECKED_AT,
    });

    const patch = store.patches[0].patch;
    assert.equal(patch.state, 'completed');
    assert.equal(patch.mintTxHash, '0xfill');
    assert.equal(patch.metadata.workerStatus, 'forwarder_confirmed');
    assert.equal(patch.metadata.completedAt, CHECKED_AT);
});

test('worker makes a non-forwarded attested burn recoverable', async () => {
    const store = createStore();
    await reconcileTransfer(store, {
        id: 'transfer-3',
        state: 'attestation_pending',
        burnTxHash: '0xburn',
        sourceDomain: 5,
        useForwarder: false,
        metadata: {},
    }, {
        fetchAttestation: async () => ({ status: 'complete', message: { attestation: '0xproof' } }),
        now: () => CHECKED_AT,
    });

    assert.equal(store.patches[0].patch.state, 'recoverable');
    assert.equal(store.patches[0].patch.metadata.workerStatus, 'attestation_ready');
});

test('worker preserves an already-claimed terminal transfer', async () => {
    const store = createStore();
    await reconcileTransfer(store, {
        id: 'transfer-4',
        state: 'already_claimed',
        burnTxHash: '0xburn',
        updatedAt: '2026-06-20T11:59:00.000Z',
        metadata: {},
    }, { now: () => CHECKED_AT });

    const patch = store.patches[0].patch;
    assert.equal(patch.state, 'already_claimed');
    assert.equal(patch.metadata.completedAt, '2026-06-20T11:59:00.000Z');
});

test('worker records Circle lookup failures without destroying lifecycle state', async () => {
    const store = createStore();
    await reconcileTransfer(store, {
        id: 'transfer-5',
        state: 'attestation_pending',
        burnTxHash: '0xburn',
        sourceDomain: 26,
        metadata: {},
    }, {
        fetchAttestation: async () => { throw new Error('Circle unavailable'); },
        now: () => CHECKED_AT,
    });

    const patch = store.patches[0].patch;
    assert.equal(patch.state, undefined);
    assert.equal(patch.metadata.workerStatus, 'error');
    assert.equal(patch.metadata.workerError, 'Circle unavailable');
});
