const IRIS_API = process.env.IRIS_API || 'https://iris-api-sandbox.circle.com';
const POLL_MS = Number(process.env.QUANTUM_WORKER_INTERVAL_MS || 5000);

async function fetchCctpAttestation(sourceDomain, burnTxHash) {
    const url = `${IRIS_API}/v2/messages/${sourceDomain}?transactionHash=${encodeURIComponent(burnTxHash)}`;
    const response = await fetch(url);
    if (response.status === 404) {
        return { status: 'not_indexed' };
    }
    if (!response.ok) {
        throw new Error(`Circle attestation lookup failed (${response.status})`);
    }
    const data = await response.json();
    const message = data.messages?.[0];
    if (!message) return { status: 'not_indexed', raw: data };
    const attestation = message.attestation;
    const status = String(message.status || '').toLowerCase();
    const isComplete = attestation?.startsWith?.('0x') && !status.includes('pending');
    return {
        status: isComplete ? 'complete' : 'pending',
        message,
        raw: data,
    };
}

function isForwarderConfirmed(message) {
    const forwardState = String(message?.forwardState || '').toUpperCase();
    return Boolean(message?.forwardTxHash) || forwardState === 'CONFIRMED';
}

async function reconcileTransfer(store, transfer) {
    if (!transfer?.burnTxHash) return;

    const checkedAt = new Date().toISOString();
    if (transfer.alreadyMinted || transfer.state === 'already_claimed') {
        await store.patchTransfer(transfer.id, {
            state: 'already_claimed',
            errorMessage: null,
            lastCheckedAt: checkedAt,
            metadata: {
                ...(transfer.metadata || {}),
                workerStatus: 'already_claimed',
            },
        });
        return;
    }
    if (transfer.sourceDomain === undefined || transfer.sourceDomain === null) return;

    try {
        const attestation = await fetchCctpAttestation(transfer.sourceDomain, transfer.burnTxHash);

        if (attestation.status === 'not_indexed' || attestation.status === 'pending') {
            await store.patchTransfer(transfer.id, {
                state: 'attestation_pending',
                errorMessage: null,
                lastCheckedAt: checkedAt,
                metadata: {
                    ...(transfer.metadata || {}),
                    workerStatus: attestation.status,
                },
            });
            return;
        }

        const message = attestation.message;
        if (transfer.useForwarder && isForwarderConfirmed(message)) {
            await store.patchTransfer(transfer.id, {
                state: 'completed',
                mintTxHash: message.forwardTxHash || transfer.mintTxHash || null,
                errorMessage: null,
                lastCheckedAt: checkedAt,
                attestation: message,
                metadata: {
                    ...(transfer.metadata || {}),
                    workerStatus: 'forwarder_confirmed',
                    forwardState: message.forwardState || null,
                },
            });
            return;
        }

        if (transfer.useForwarder) {
            await store.patchTransfer(transfer.id, {
                state: 'attestation_pending',
                errorMessage: null,
                lastCheckedAt: checkedAt,
                attestation: message,
                metadata: {
                    ...(transfer.metadata || {}),
                    workerStatus: 'forwarder_pending',
                    forwardState: message.forwardState || null,
                },
            });
            return;
        }

        await store.patchTransfer(transfer.id, {
            state: 'recoverable',
            errorMessage: null,
            lastCheckedAt: checkedAt,
            attestation: message,
            metadata: {
                ...(transfer.metadata || {}),
                workerStatus: 'attestation_ready',
            },
        });
    } catch (error) {
        await store.patchTransfer(transfer.id, {
            lastCheckedAt: checkedAt,
            metadata: {
                ...(transfer.metadata || {}),
                workerStatus: 'error',
                workerError: error instanceof Error ? error.message : String(error),
            },
        });
    }
}

export function startIrisWorker(store, { intervalMs = POLL_MS } = {}) {
    let running = false;

    async function tick() {
        if (running) return;
        running = true;
        try {
            const transfers = await store.listTransfersForWorker();
            for (const transfer of transfers) {
                await reconcileTransfer(store, transfer);
            }
        } finally {
            running = false;
        }
    }

    const timer = setInterval(tick, intervalMs);
    setTimeout(tick, 1000);
    return {
        stop() {
            clearInterval(timer);
        },
        tick,
    };
}
