import assert from 'node:assert/strict';
import test from 'node:test';
import {
    TRANSFER_STATES,
    formatDuration,
    getActivityFillDurationMs,
    getActivitySortTime,
    getTransferActivityLabel,
    getTransferStatusBucket,
    isForwarderAwaitingFill,
    isLateSyncedCompletion,
    stateFromRecoveryStatus,
    statusFromTransferState,
} from '../src/transfer-lifecycle.js';

test('recovery statuses map to durable lifecycle states', () => {
    assert.equal(stateFromRecoveryStatus(null), TRANSFER_STATES.CREATED);
    assert.equal(stateFromRecoveryStatus({ burnTxHash: 'burn' }), TRANSFER_STATES.BURN_SUBMITTED);
    assert.equal(stateFromRecoveryStatus({ status: 'burned' }), TRANSFER_STATES.RECOVERABLE);
    assert.equal(stateFromRecoveryStatus({ status: 'attesting' }), TRANSFER_STATES.ATTESTATION_PENDING);
    assert.equal(stateFromRecoveryStatus({ status: 'minting' }), TRANSFER_STATES.MINT_SUBMITTED);
    assert.equal(stateFromRecoveryStatus({ status: 'minted' }), TRANSFER_STATES.COMPLETED);
    assert.equal(stateFromRecoveryStatus({ alreadyMinted: true }), TRANSFER_STATES.ALREADY_CLAIMED);
});

test('forwarder handoff stays pending until a destination fill hash exists', () => {
    const handoff = { state: TRANSFER_STATES.COMPLETED, useForwarder: true };
    assert.equal(isForwarderAwaitingFill(handoff), true);
    assert.equal(getTransferStatusBucket(handoff.state, handoff), 'pending');
    assert.equal(statusFromTransferState(handoff.state, handoff), 'minting');
    assert.equal(getTransferActivityLabel(handoff), 'Forwarder finalizing mint');

    const filled = { ...handoff, mintTxHash: '0xfill' };
    assert.equal(isForwarderAwaitingFill(filled), false);
    assert.equal(getTransferStatusBucket(filled.state, filled), 'success');
    assert.equal(statusFromTransferState(filled.state, filled), 'minted');
});

test('fill duration uses the recorded completion time', () => {
    const transfer = {
        state: TRANSFER_STATES.COMPLETED,
        createdAt: '2026-06-20T10:00:00.000Z',
        metadata: { completedAt: '2026-06-20T10:00:37.000Z' },
        mintTxHash: '0xfill',
    };
    assert.equal(getActivityFillDurationMs(transfer), 37_000);
    assert.equal(formatDuration(getActivityFillDurationMs(transfer)), '37s');
    assert.equal(isLateSyncedCompletion(transfer), false);
});

test('late historical sync does not sort as a fresh multi-day fill', () => {
    const transfer = {
        state: TRANSFER_STATES.COMPLETED,
        createdAt: '2026-06-15T10:00:00.000Z',
        updatedAt: '2026-06-20T10:00:00.000Z',
        mintTxHash: '0xfill',
    };
    assert.equal(isLateSyncedCompletion(transfer), true);
    assert.equal(getActivitySortTime(transfer), Date.parse(transfer.createdAt));
});

test('invalid and negative durations are never presented as valid fill times', () => {
    assert.equal(formatDuration(Number.NaN), 'Unknown');
    assert.equal(formatDuration(-1), 'Unknown');
    assert.equal(formatDuration(500), '500ms');
    assert.equal(formatDuration(65_000), '1m 5s');
});
