export const TRANSFER_STATES = Object.freeze({
    CREATED: 'created',
    BURN_SUBMITTED: 'burn_submitted',
    ATTESTATION_PENDING: 'attestation_pending',
    MINT_SUBMITTED: 'mint_submitted',
    COMPLETED: 'completed',
    RECOVERABLE: 'recoverable',
    ALREADY_CLAIMED: 'already_claimed',
    FAILED: 'failed',
});

const TRANSFER_STATE_LABELS = Object.freeze({
    [TRANSFER_STATES.CREATED]: 'Created',
    [TRANSFER_STATES.BURN_SUBMITTED]: 'Burn submitted',
    [TRANSFER_STATES.ATTESTATION_PENDING]: 'Waiting for Circle attestation',
    [TRANSFER_STATES.MINT_SUBMITTED]: 'Mint submitted',
    [TRANSFER_STATES.COMPLETED]: 'Completed',
    [TRANSFER_STATES.RECOVERABLE]: 'Ready to resume',
    [TRANSFER_STATES.ALREADY_CLAIMED]: 'Already claimed',
    [TRANSFER_STATES.FAILED]: 'Failed before burn',
});

export const MAX_REASONABLE_FILL_DURATION_MS = 30 * 60 * 1000;

export function stateFromRecoveryStatus(recovery) {
    if (!recovery) return TRANSFER_STATES.CREATED;
    if (recovery.alreadyMinted) return TRANSFER_STATES.ALREADY_CLAIMED;
    if (recovery.status === 'minted') return TRANSFER_STATES.COMPLETED;
    if (recovery.status === 'minting') return TRANSFER_STATES.MINT_SUBMITTED;
    if (recovery.status === 'attesting') return TRANSFER_STATES.ATTESTATION_PENDING;
    if (recovery.status === 'burned') return TRANSFER_STATES.RECOVERABLE;
    if (recovery.burnTxHash) return TRANSFER_STATES.BURN_SUBMITTED;
    return TRANSFER_STATES.CREATED;
}

export function getTransferStateLabel(state) {
    return TRANSFER_STATE_LABELS[state] || TRANSFER_STATE_LABELS[TRANSFER_STATES.RECOVERABLE];
}

export function isForwarderAwaitingFill(record, state = record?.state) {
    if (!record?.useForwarder || record?.mintTxHash || record?.txHash) return false;
    return [
        TRANSFER_STATES.ATTESTATION_PENDING,
        TRANSFER_STATES.MINT_SUBMITTED,
        TRANSFER_STATES.COMPLETED,
    ].includes(state);
}

export function getTransferActivityLabel(record, state = record?.state) {
    return isForwarderAwaitingFill(record, state)
        ? 'Forwarder finalizing mint'
        : getTransferStateLabel(state);
}

export function getTransferStatusBucket(state, record = null) {
    if (isForwarderAwaitingFill(record, state)) return 'pending';
    if (state === TRANSFER_STATES.COMPLETED || state === TRANSFER_STATES.ALREADY_CLAIMED) return 'success';
    if (state === TRANSFER_STATES.FAILED) return 'error';
    return 'pending';
}

export function statusFromTransferState(state, record = null) {
    if (isForwarderAwaitingFill(record, state)) return 'minting';
    if (state === TRANSFER_STATES.COMPLETED || state === TRANSFER_STATES.ALREADY_CLAIMED) return 'minted';
    if (state === TRANSFER_STATES.ATTESTATION_PENDING) return 'attesting';
    if (state === TRANSFER_STATES.MINT_SUBMITTED) return 'minting';
    return 'burned';
}

export function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return 'Unknown';
    if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

export function isTerminalActivityState(state, item = null) {
    if (isForwarderAwaitingFill(item, state)) return false;
    return state === TRANSFER_STATES.COMPLETED || state === TRANSFER_STATES.ALREADY_CLAIMED;
}

export function getActivityCompletionTime(item = {}) {
    const metadata = item.metadata || {};
    const lifecycleState = item.lifecycleState || item.state || (item.alreadyMinted ? TRANSFER_STATES.ALREADY_CLAIMED : null);
    const candidates = [
        item.completedAt,
        item.finishedAt,
        item.claimedAt,
        metadata.completedAt,
        metadata.finishedAt,
        metadata.claimedAt,
        metadata.forwarderConfirmedAt,
    ];
    if (item.mintTxHash || item.txHash) candidates.push(item.updatedAt);
    if (isTerminalActivityState(lifecycleState, item)) candidates.push(item.updatedAt, item.createdAt);
    const value = candidates.find(candidate => Number.isFinite(new Date(candidate || '').getTime()));
    return value || null;
}

export function getActivityStartTime(item = {}) {
    const value = item.timestamp || item.createdAt;
    const time = new Date(value || '').getTime();
    return Number.isFinite(time) ? time : null;
}

export function getActivityFillDurationMs(item = {}) {
    const started = getActivityStartTime(item);
    const completed = new Date(getActivityCompletionTime(item) || '').getTime();
    if (!Number.isFinite(started) || !Number.isFinite(completed)) return null;
    return completed - started;
}

export function isLateSyncedCompletion(item = {}) {
    const duration = getActivityFillDurationMs(item);
    return Number.isFinite(duration) && duration > MAX_REASONABLE_FILL_DURATION_MS;
}

export function getActivitySortTime(item = {}) {
    const lifecycleState = item.lifecycleState || item.state || (item.alreadyMinted ? TRANSFER_STATES.ALREADY_CLAIMED : null);
    if (isLateSyncedCompletion(item)) {
        const created = getActivityStartTime(item);
        if (Number.isFinite(created)) return created;
    }
    const sortTimestamp = isTerminalActivityState(lifecycleState, item)
        ? (getActivityCompletionTime(item) || item.timestamp || item.createdAt)
        : (item.updatedAt || item.timestamp || item.createdAt);
    const time = new Date(sortTimestamp || '').getTime();
    return Number.isFinite(time) ? time : 0;
}
