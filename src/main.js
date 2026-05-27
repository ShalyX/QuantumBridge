import { 
    createPublicClient, 
    encodeFunctionData,
    formatUnits, 
    http, 
    defineChain
} from 'viem';
import { AppKit } from '@circle-fin/app-kit';
import { ArcTestnet, EthereumSepolia, SolanaDevnet } from '@circle-fin/app-kit/chains';
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { createSolanaKitAdapterFromProvider } from "@circle-fin/adapter-solana-kit";
import { Connection, PublicKey, VersionedMessage, VersionedTransaction, Transaction } from "@solana/web3.js";
import { Buffer } from 'buffer';
import { initWormhole } from './components/wormhole.js';

console.log("%c[QuantumBridge] v3.1 - Quantum Tunneling Core Initialized", "color: #00f2fe; font-weight: bold; font-size: 24px; text-shadow: 0 0 10px #00f2fe;");

// Initialize UI Animations
const wormhole = initWormhole();

// Chain Definitions
const arcTestnet = defineChain({
    id: 5042002,
    name: 'Arc Testnet',
    network: 'arc-testnet',
    nativeCurrency: {
        decimals: 18, 
        name: 'USDC',
        symbol: 'USDC',
    },
    rpcUrls: {
        default: { http: ['https://rpc.testnet.arc.network'] },
        public: { http: ['https://rpc.testnet.arc.network'] },
    },
    blockExplorers: {
        default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' },
    }
});

const ethSepolia = defineChain({
    id: 11155111,
    name: 'Ethereum Sepolia',
    network: 'sepolia',
    nativeCurrency: { decimals: 18, name: 'Sepolia Ether', symbol: 'SEP' },
    rpcUrls: {
        default: { http: ['https://ethereum-sepolia.publicnode.com'] },
        public: { http: ['https://ethereum-sepolia.publicnode.com'] },
    },
    blockExplorers: {
        default: { name: 'Etherscan', url: 'https://sepolia.etherscan.io' },
    }
});

const USDC_ADDRS = {
    'arc': '0x3600000000000000000000000000000000000000',
    'ethereum': '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    'solana': '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
};

const CHAIN_MAPPING = {
    'arc': 'Arc_Testnet',
    'ethereum': 'Ethereum_Sepolia',
    'solana': 'Solana_Devnet'
};

const EVM_CHAINS = {
    arc: arcTestnet,
    ethereum: ethSepolia
};

const CIRCLE_CHAIN_DEFINITIONS = {
    arc: ArcTestnet,
    ethereum: EthereumSepolia,
    solana: SolanaDevnet
};

const CCTP_DOMAINS = {
    ethereum: 0,
    solana: 5,
    arc: 26
};

const FORWARDER_DESTINATIONS = new Set(['arc', 'ethereum']);

const IRIS_API = 'https://iris-api-sandbox.circle.com';
const SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com';
const MESSAGE_TRANSMITTER_V2 = {
    arc: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    ethereum: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'
};

const RECEIVE_MESSAGE_ABI = [
    {
        type: 'function',
        name: 'receiveMessage',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'message', type: 'bytes' },
            { name: 'attestation', type: 'bytes' },
        ],
        outputs: [],
    },
];

const EXPLORERS = {
    'arc': 'https://testnet.arcscan.app',
    'ethereum': 'https://sepolia.etherscan.io',
    'solana': 'https://explorer.solana.com'
};

const getLink = (chain, hash) => {
    const base = EXPLORERS[chain.toLowerCase()] || EXPLORERS.arc;
    const activeHash = hash || '0x360000000000000000000000000000000000000000000000000000000000dead';
    
    if (chain.toLowerCase() === 'solana') return `${base}/tx/${activeHash}?cluster=devnet`;
    return `${base}/tx/${activeHash}`;
};

// State
let evmAccount = null;
let solanaAccount = null;
let solanaWalletType = null;
let currentEvmProvider = null;
let currentSolanaProvider = null;
let evmAdapter = null;
let solanaAdapter = null;
let activeBridgeContext = null;
let isResumingRecoveries = false;
let balances = {
    arc: 0,
    ethereum: 0,
    solana: 0
};
const kit = new AppKit();
let transferLedgerCache = [];
let pendingRecoveriesCache = [];
let activityHistory = [];
let walletViewGeneration = 0;

kit.on('*', async (event) => {
    console.log("[QuantumBridge Event]", event);
    const { method, values: step } = event;
    const { state, txHash } = step || {};
    const from = originChainSelect?.value || 'arc';
    const methodName = String(method || '');
    if (activeBridgeContext?.id) {
        recordTransferEvent(activeBridgeContext.id, `bridge.${methodName || 'event'}.${state || 'unknown'}`, event);
    }
    
    if (state === 'loading') {
        if (method === 'approve') log("Quantum Handshake: Approving USDC transfer...", "loading");
        if (method === 'burn') log("Quantum Handshake: Commencing USDC burn...", "loading");
    }
    if (state === 'success' && txHash) {
        const link = `${EXPLORERS[from]}/tx/${txHash}`;
        log(`[On-Chain] ${method.toUpperCase()}: <a href="${link}" target="_blank" class="log-link">${txHash.slice(0, 8)}...</a>`, 'success');
    }
    if (state === 'success' && txHash && activeBridgeContext && methodName.toLowerCase().includes('burn')) {
        activeBridgeContext = { ...activeBridgeContext, burnTxHash: txHash };
        upsertPendingRecovery({
            ...activeBridgeContext,
            burnTxHash: txHash,
            status: 'burned',
            state: TRANSFER_STATES.BURN_SUBMITTED,
            updatedAt: new Date().toISOString(),
        });
        patchTransferRecord(activeBridgeContext.id, {
            burnTxHash: txHash,
            state: TRANSFER_STATES.BURN_SUBMITTED,
            errorMessage: null,
        });
        addActivity('Teleport', activeBridgeContext.from, activeBridgeContext.to, activeBridgeContext.amount, 'pending', null, {
            burnTxHash: txHash,
            recoveryId: activeBridgeContext.id,
            lifecycleState: TRANSFER_STATES.BURN_SUBMITTED,
            lifecycleLabel: getTransferStateLabel(TRANSFER_STATES.BURN_SUBMITTED),
        });
        log(`Recovery checkpoint saved for burn ${shortHash(txHash)}.`, 'success');
    }
    if (activeBridgeContext) {
        const lowerMethod = methodName.toLowerCase();
        if (state === 'loading' && lowerMethod.includes('attestation')) {
            patchTransferRecord(activeBridgeContext.id, {
                state: TRANSFER_STATES.ATTESTATION_PENDING,
                errorMessage: null,
            });
        }
        if (state === 'loading' && lowerMethod.includes('mint')) {
            patchTransferRecord(activeBridgeContext.id, {
                state: TRANSFER_STATES.MINT_SUBMITTED,
                errorMessage: null,
            });
        }
        if (state === 'error') {
            const productMessage = getProductErrorMessage(step?.error || step?.errorMessage || step);
            const nextState = activeBridgeContext.burnTxHash ? TRANSFER_STATES.RECOVERABLE : TRANSFER_STATES.FAILED;
            patchTransferRecord(activeBridgeContext.id, {
                state: nextState,
                errorMessage: productMessage,
            });
        }
    }
    updateSteps(method, state);
    if (method === 'approve') updateStepper(1, state === 'success' ? 'complete' : 'active');
    if (method === 'burn') updateStepper(2, state === 'success' ? 'complete' : 'active');
    if (method === 'fetchAttestation') updateStepper(3, state === 'success' ? 'complete' : 'active');
    if (method === 'mint') updateStepper(4, state === 'success' ? 'complete' : 'active');
});

// Quantum Sound Engine (Web Audio API Synthesizer)
class QuantumSoundEngine {
    constructor() {
        this.ctx = null;
    }

    init() {
        if (this.ctx) return;
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }

    async play(type) {
        this.init();
        if (this.ctx.state === 'suspended') await this.ctx.resume();

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain);
        gain.connect(this.ctx.destination);

        const now = this.ctx.currentTime;

        if (type === 'click') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(1200, now);
            osc.frequency.exponentialRampToValueAtTime(400, now + 0.05);
            gain.gain.setValueAtTime(0.1, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
            osc.start(now);
            osc.stop(now + 0.05);
        } 
        else if (type === 'warp') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(100, now);
            osc.frequency.exponentialRampToValueAtTime(2000, now + 0.8);
            gain.gain.setValueAtTime(0.05, now);
            gain.gain.linearRampToValueAtTime(0, now + 0.8);
            osc.start(now);
            osc.stop(now + 0.8);
        }
        else if (type === 'success') {
            [440, 659.25, 880].forEach((freq, i) => {
                const o = this.ctx.createOscillator();
                const g = this.ctx.createGain();
                o.type = 'sine';
                o.frequency.setValueAtTime(freq, now + (i * 0.05));
                g.gain.setValueAtTime(0.1, now + (i * 0.05));
                g.gain.exponentialRampToValueAtTime(0.01, now + 0.5 + (i * 0.1));
                o.connect(g);
                g.connect(this.ctx.destination);
                o.start(now + (i * 0.05));
                o.stop(now + 0.6 + (i * 0.1));
            });
        }
        else if (type === 'error') {
            osc.type = 'square';
            osc.frequency.setValueAtTime(150, now);
            osc.frequency.linearRampToValueAtTime(50, now + 0.3);
            gain.gain.setValueAtTime(0.1, now);
            gain.gain.linearRampToValueAtTime(0, now + 0.3);
            osc.start(now);
            osc.stop(now + 0.3);
        }
    }
}

const sounds = new QuantumSoundEngine();

// Filtering State
let currentStatusFilter = 'all';
let currentChainFilter = 'all';

// DOM Elements
const connectEvmBtn = document.getElementById('connect-evm');
const connectSolanaBtn = document.getElementById('connect-solana');
const teleportBtn = document.getElementById('teleport-btn');
const amountInput = document.getElementById('amount');
const destinationAddressInput = document.getElementById('destination-address');
const destinationAddressContainer = document.querySelector('.destination-address-container');
const destinationAddressHint = document.getElementById('destination-address-hint');
const originChainSelect = document.getElementById('origin-chain');
const destinationChainSelect = document.getElementById('destination-chain');
const consoleLogs = document.getElementById('console-logs');
const themeToggle = document.getElementById('theme-toggle');
const forwardingNotice = document.getElementById('forwarding-notice');
const maxBtn = document.getElementById('max-btn');
const presetBtns = document.querySelectorAll('.preset-btn[data-value]');
const refreshBalancesBtn = document.getElementById('refresh-balances');
const successOverlay = document.getElementById('success-overlay');
const closeOverlayBtn = document.getElementById('close-overlay');
const quantumWalletModal = document.getElementById('quantum-wallet-modal');
const closeQuantumModalBtn = document.getElementById('close-quantum-modal');
const txDetailsOverlay = document.getElementById('tx-details-overlay');
const closeTxDetailsBtn = document.getElementById('close-tx-details');
const txDetailsContent = document.getElementById('tx-details-content');
const stepper = document.getElementById('teleport-stepper');
const swapChainsBtn = document.getElementById('swap-chains');
const walletModalTabs = Array.from(document.querySelectorAll('#quantum-wallet-modal .modal-tab[data-tab]'));
const walletModalSections = Array.from(document.querySelectorAll('#quantum-wallet-modal .wallet-section[data-section]'));
const recoveryBurnTxInput = document.getElementById('recovery-burn-tx');
const recoverBurnBtn = document.getElementById('recover-burn-btn');
const pendingRecoveriesEl = document.getElementById('pending-recoveries');
const recoverySourceChainSelect = document.getElementById('recovery-source-chain');
const recoveryDestinationChainSelect = document.getElementById('recovery-destination-chain');
const recoveryBanner = document.getElementById('recovery-banner');
const recoveryBannerText = document.getElementById('recovery-banner-text');
const resumeAllRecoveriesBtn = document.getElementById('resume-all-recoveries');



function log(message, type = 'system') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    const hashRegex = /\[(0x[a-fA-F0-9]{40,}|[1-9A-HJ-NP-Za-km-z]{32,})\]/g;
    let formattedMessage = message.replace(hashRegex, (match, hash) => {
        const from = originChainSelect.value;
        const to = destinationChainSelect.value;
        const explorer = message.toLowerCase().includes('complete') ? EXPLORERS[to] : EXPLORERS[from];
        return `<a href="${explorer}${hash}" target="_blank" class="log-link">${hash.slice(0, 8)}...${hash.slice(-6)}</a>`;
    });

    entry.innerHTML = `<span style="opacity: 0.5">[${time}]</span> ${formattedMessage}`;
    consoleLogs.appendChild(entry);
    consoleLogs.scrollTop = consoleLogs.scrollHeight;
}

function updateStepper(step, status) {
    stepper.style.display = 'grid';
    const steps = [1, 2, 3, 4];
    steps.forEach(s => {
        const el = document.getElementById(`step-${s}`);
        if (s < step) {
            el.className = 'step complete';
        } else if (s === step) {
            el.className = `step ${status}`;
        } else {
            el.className = 'step';
        }
    });
}

function updateSteps(method, state) {
    const steps = document.querySelectorAll('.step');
    let stepIndex = -1;
    if (method === 'approve' || method === 'usdc.increaseAllowance') stepIndex = 0;
    if (method === 'burn' || method === 'cctp.v2.customBurnWithHook') stepIndex = 1;
    if (method === 'attestation') stepIndex = 2;
    if (method === 'mint' || method === 'cctp.v2.mint') stepIndex = 3;
    
    if (stepIndex === -1) return;
    
    steps.forEach((el, idx) => {
        if (idx < stepIndex) el.className = 'step complete';
        else if (idx === stepIndex) {
            el.className = state === 'success' ? 'step complete' : (state === 'error' ? 'step' : 'step active');
        } else {
            el.className = 'step';
        }
    });
}

const RECOVERY_STORAGE_KEY = 'quantum_bridge_cctp_recoveries';
const TRANSFER_STORAGE_KEY = 'quantum_bridge_transfer_lifecycle';
const ACTIVITY_STORAGE_KEY = 'quantum_bridge_activity';
const WALLET_SESSION_STORAGE_KEY = 'quantum_bridge_wallet_session';
const TRANSFER_API_BASE = (import.meta.env.VITE_TRANSFER_API_URL || '').replace(/\/$/, '');
const CHAIN_LABELS = {
    arc: 'Arc',
    ethereum: 'Ethereum Sepolia',
    solana: 'Solana Devnet'
};

const TRANSFER_STATES = Object.freeze({
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

const PRODUCT_ERROR_MESSAGES = Object.freeze({
    alreadyClaimed: 'This burn was already claimed.',
    attestationPending: 'Circle attestation is not ready yet.',
    solanaRecoveryWallet: 'Connect Solflare or Backpack to complete this route.',
    phantomSourceUnsupported: 'Connect Solflare or Backpack to complete this route.',
    walletConnection: 'Wallet connection failed. Refresh and reconnect this wallet from the modal.',
    walletPluginClosed: 'Wallet connection closed. Reopen or unlock the wallet, then try again.',
    walletRejected: 'Wallet approval was cancelled.',
    circleIndexing: 'Circle has not indexed this burn yet. Try again in a moment.',
    attestationExpired: 'Circle attestation expired. Requesting a fresh attestation before minting.',
    solanaHashMismatch: 'This looks like an EVM transaction hash. For Solana source recovery, paste the Solana burn signature or switch the source chain.',
    evmHashMismatch: 'This looks like a Solana signature. For EVM source recovery, paste the 0x burn transaction hash or switch the source chain.',
    invalidDestinationAddress: 'Enter a valid destination wallet address for this chain.',
    missingDestinationAddress: 'Connect a destination wallet or paste a destination address.',
    noCctpMessage: 'No CCTP burn message was found for this transaction.',
    simulationFailed: 'The destination chain rejected this mint. Try Resume transfer again, or use a supported wallet for this route.',
    genericRecoverable: 'Transfer paused. Resume it from the recovery panel when wallets are connected.',
});

function shortHash(hash) {
    if (!hash) return 'unknown';
    return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function nowIso() {
    return new Date().toISOString();
}

function readWalletSession() {
    try {
        const parsed = JSON.parse(localStorage.getItem(WALLET_SESSION_STORAGE_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeWalletSession(patch) {
    const next = {
        ...readWalletSession(),
        ...patch,
        updatedAt: nowIso(),
    };
    localStorage.setItem(WALLET_SESSION_STORAGE_KEY, JSON.stringify(next));
}

function clearWalletSession() {
    localStorage.removeItem(WALLET_SESSION_STORAGE_KEY);
}

function rememberEvmWallet(providerDetail, account) {
    writeWalletSession({
        evm: {
            uuid: providerDetail?.info?.uuid || null,
            rdns: providerDetail?.info?.rdns || null,
            name: providerDetail?.info?.name || 'Detected Wallet',
            icon: providerDetail?.info?.icon || '',
            detectedFallback: !providerDetail?.info?.uuid,
            address: account,
            connectedAt: nowIso(),
        },
    });
}

function rememberSolanaWallet(walletType, address) {
    writeWalletSession({
        solana: {
            walletType,
            address,
            connectedAt: nowIso(),
        },
    });
}

function clearLegacyTransferBrowserStorage() {
    [RECOVERY_STORAGE_KEY, TRANSFER_STORAGE_KEY, ACTIVITY_STORAGE_KEY].forEach(key => {
        try {
            localStorage.removeItem(key);
        } catch {}
    });
}

function readTransferLedger() {
    return transferLedgerCache;
}

function writeTransferLedger(items) {
    transferLedgerCache = Array.isArray(items) ? items : [];
}

function getTransferKey(record) {
    return record?.id || record?.recoveryId || record?.burnTxHash || null;
}

function stateFromRecoveryStatus(recovery) {
    if (!recovery) return TRANSFER_STATES.CREATED;
    if (recovery.alreadyMinted) return TRANSFER_STATES.ALREADY_CLAIMED;
    if (recovery.status === 'minted') return TRANSFER_STATES.COMPLETED;
    if (recovery.status === 'minting') return TRANSFER_STATES.MINT_SUBMITTED;
    if (recovery.status === 'attesting') return TRANSFER_STATES.ATTESTATION_PENDING;
    if (recovery.status === 'burned') return TRANSFER_STATES.RECOVERABLE;
    if (recovery.burnTxHash) return TRANSFER_STATES.BURN_SUBMITTED;
    return TRANSFER_STATES.CREATED;
}

function getTransferStateLabel(state) {
    return TRANSFER_STATE_LABELS[state] || TRANSFER_STATE_LABELS[TRANSFER_STATES.RECOVERABLE];
}

function getTransferStatusBucket(state) {
    if (state === TRANSFER_STATES.COMPLETED || state === TRANSFER_STATES.ALREADY_CLAIMED) return 'success';
    if (state === TRANSFER_STATES.FAILED) return 'error';
    return 'pending';
}

function statusFromTransferState(state) {
    if (state === TRANSFER_STATES.COMPLETED || state === TRANSFER_STATES.ALREADY_CLAIMED) return 'minted';
    if (state === TRANSFER_STATES.ATTESTATION_PENDING) return 'attesting';
    if (state === TRANSFER_STATES.MINT_SUBMITTED) return 'minting';
    return 'burned';
}

function transferApiUrl(path) {
    return `${TRANSFER_API_BASE}${path}`;
}

function normalizeBackendTransferPayload(record) {
    const from = record.from || record.fromChain || null;
    const to = record.to || record.toChain || null;
    const sourceWallet = record.sourceWallet || (from === 'solana' ? solanaAccount : evmAccount) || null;
    const destinationWallet = record.destinationWallet || (to === 'solana' ? solanaAccount : evmAccount) || null;
    const wallets = Array.from(new Set([
        sourceWallet,
        destinationWallet,
        record.recipient,
        evmAccount,
        solanaAccount,
        ...(Array.isArray(record.wallets) ? record.wallets : []),
    ].filter(Boolean).map(String)));

    return {
        ...record,
        from,
        to,
        sourceWallet,
        destinationWallet,
        wallets,
    };
}

async function syncTransferToBackend(record, mode = 'upsert') {
    if (!record?.id) return;
    const payload = normalizeBackendTransferPayload(record);
    const method = mode === 'patch' ? 'PATCH' : 'POST';
    const path = method === 'PATCH'
        ? `/api/transfers/${encodeURIComponent(record.id)}`
        : '/api/transfers';
    try {
        const response = await fetch(transferApiUrl(path), {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error(`Transfer API ${response.status}`);
    } catch (error) {
        console.warn('[QuantumBridge] Transfer API sync failed; local cache remains active.', error);
    }
}

function queueTransferSync(record, mode = 'upsert') {
    if (!record?.id) return;
    window.setTimeout(() => syncTransferToBackend(record, mode), 0);
}

async function recordTransferEvent(transferId, type, payload = {}) {
    if (!transferId) return;
    try {
        await fetch(transferApiUrl(`/api/transfers/${encodeURIComponent(transferId)}/events`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, payload }),
        });
    } catch (error) {
        console.warn('[QuantumBridge] Transfer event sync failed.', error);
    }
}

function mergeBackendTransfersIntoLocal(transfers) {
    if (!Array.isArray(transfers) || transfers.length === 0) return;
    for (const transfer of transfers) {
        const localTransfer = {
            ...transfer,
            id: transfer.id,
            recoveryId: transfer.recoveryId || transfer.id,
            from: transfer.from,
            to: transfer.to,
            status: statusFromTransferState(transfer.state),
            errorMessage: transfer.errorMessage || null,
            alreadyMinted: transfer.alreadyMinted,
        };
        upsertTransferRecord(localTransfer, { sync: false });
        if (transfer.from && transfer.to) {
            addActivity('Teleport', transfer.from, transfer.to, transfer.amount || 'unknown', getTransferStatusBucket(transfer.state), transfer.mintTxHash || null, {
                recoveryId: transfer.recoveryId || transfer.id,
                burnTxHash: transfer.burnTxHash || null,
                alreadyMinted: Boolean(transfer.alreadyMinted),
                lifecycleState: transfer.state,
                lifecycleLabel: getTransferStateLabel(transfer.state),
                errorMessage: transfer.errorMessage || null,
            });
        }
        if (transfer.burnTxHash && (transfer.state === TRANSFER_STATES.COMPLETED || transfer.state === TRANSFER_STATES.ALREADY_CLAIMED)) {
            settlePendingRecoveryFromBackend(transfer);
        } else if (transfer.burnTxHash && transfer.state !== TRANSFER_STATES.FAILED) {
            upsertPendingRecovery(localTransfer, { sync: false });
        }
    }
    syncRecoveryActivityCards();
    renderActivity();
    renderPendingRecoveries();
    renderRecoveryBanner();
}

async function syncServerTransfersForConnectedWallets() {
    const session = readWalletSession();
    const wallets = Array.from(new Set([
        evmAccount,
        solanaAccount,
        session.evm?.address,
        session.solana?.address,
    ].filter(Boolean).map(String)));
    if (wallets.length === 0) return;
    const viewGeneration = walletViewGeneration;
    try {
        const results = await Promise.all(wallets.map(async wallet => {
            const response = await fetch(transferApiUrl(`/api/transfers?wallet=${encodeURIComponent(wallet)}`));
            if (!response.ok) throw new Error(`Transfer API ${response.status}`);
            return response.json();
        }));
        if (viewGeneration !== walletViewGeneration) return;
        const transfersById = new Map();
        for (const result of results) {
            for (const transfer of result.transfers || []) {
                transfersById.set(transfer.id, transfer);
            }
        }
        mergeBackendTransfersIntoLocal(Array.from(transfersById.values()));
    } catch (error) {
        console.warn('[QuantumBridge] Could not load backend transfers; local cache remains active.', error);
    }
}

function upsertTransferRecord(record, options = {}) {
    const key = getTransferKey(record);
    if (!key) return null;
    const items = readTransferLedger();
    const existingIndex = items.findIndex(item =>
        item.id === key ||
        item.recoveryId === key ||
        (record.burnTxHash && item.burnTxHash === record.burnTxHash)
    );
    const existing = existingIndex === -1 ? {} : items[existingIndex];
    const timestamp = nowIso();
    const nextRecord = {
        ...existing,
        ...record,
        id: existing.id || record.id || key,
        recoveryId: record.recoveryId || existing.recoveryId || record.id || key,
        state: record.state || existing.state || stateFromRecoveryStatus(record),
        createdAt: existing.createdAt || record.createdAt || timestamp,
        updatedAt: timestamp,
    };

    if (existingIndex === -1) {
        items.unshift(nextRecord);
    } else {
        items[existingIndex] = nextRecord;
    }
    writeTransferLedger(items);
    if (options.sync !== false) queueTransferSync(nextRecord, 'upsert');
    return nextRecord;
}

function patchTransferRecord(idOrHash, patch, options = {}) {
    if (!idOrHash) return null;
    const items = readTransferLedger();
    const index = items.findIndex(item =>
        item.id === idOrHash ||
        item.recoveryId === idOrHash ||
        item.burnTxHash === idOrHash
    );
    if (index === -1) {
        return upsertTransferRecord({
            id: idOrHash,
            recoveryId: idOrHash,
            ...patch,
        }, options);
    }
    items[index] = { ...items[index], ...patch, updatedAt: nowIso() };
    writeTransferLedger(items);
    if (options.sync !== false) queueTransferSync(items[index], 'patch');
    return items[index];
}

function migrateRecoveriesToTransferLedger() {
    for (const recovery of readPendingRecoveries()) {
        if (!recovery?.burnTxHash) continue;
        upsertTransferRecord({
            ...recovery,
            id: recovery.id || recovery.burnTxHash,
            recoveryId: recovery.id || recovery.burnTxHash,
            state: stateFromRecoveryStatus(recovery),
        });
    }
}

async function copyToClipboard(value, label = 'value') {
    const text = String(value || '');
    if (!text) return false;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            textarea.remove();
        }
        log(`Copied ${label}: ${shortHash(text)}`, 'success');
        return true;
    } catch (e) {
        log(`Copy failed: ${e.message}`, 'error');
        return false;
    }
}

function readPendingRecoveries() {
    return pendingRecoveriesCache;
}

function getActionableRecoveries() {
    const seen = new Set();
    return readPendingRecoveries().filter(item => {
        if (item.status === 'minted') return false;
        const key = `${item.sourceDomain ?? CCTP_DOMAINS[item.from] ?? ''}:${item.destinationDomain ?? CCTP_DOMAINS[item.to] ?? ''}:${item.burnTxHash || item.id}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function writePendingRecoveries(items) {
    pendingRecoveriesCache = Array.isArray(items) ? items : [];
    renderPendingRecoveries();
    renderRecoveryBanner();
}

function clearVisibleTransferState() {
    walletViewGeneration += 1;
    transferLedgerCache = [];
    pendingRecoveriesCache = [];
    activityHistory = [];
    closeTransactionDetails();
    renderActivity();
    renderPendingRecoveries();
    renderRecoveryBanner();
}

function upsertPendingRecovery(transfer, options = {}) {
    if (!transfer?.burnTxHash) return;
    const items = readPendingRecoveries();
    const key = transfer.id || transfer.burnTxHash;
    const existingIndex = items.findIndex(item => item.id === key || item.burnTxHash === transfer.burnTxHash);
    const nextTransfer = {
        id: key,
        from: transfer.from || 'solana',
        to: transfer.to || 'arc',
        amount: transfer.amount || '',
        recipient: transfer.recipient || evmAccount || '',
        sourceDomain: transfer.sourceDomain ?? CCTP_DOMAINS[transfer.from || 'solana'],
        destinationDomain: transfer.destinationDomain ?? CCTP_DOMAINS[transfer.to || 'arc'],
        burnTxHash: transfer.burnTxHash,
        mintTxHash: transfer.mintTxHash || null,
        status: transfer.status || 'burned',
        state: transfer.state || null,
        errorMessage: transfer.errorMessage || null,
        createdAt: transfer.createdAt || new Date().toISOString(),
        updatedAt: transfer.updatedAt || new Date().toISOString(),
    };

    if (existingIndex === -1) {
        items.unshift(nextTransfer);
    } else {
        items[existingIndex] = { ...items[existingIndex], ...nextTransfer };
    }
    upsertTransferRecord({
        ...nextTransfer,
        recoveryId: key,
        state: transfer.state || stateFromRecoveryStatus(nextTransfer),
    }, { sync: options.sync });
    writePendingRecoveries(items);
}

function patchPendingRecovery(idOrHash, patch, options = {}) {
    const items = readPendingRecoveries();
    const index = items.findIndex(item => item.id === idOrHash || item.burnTxHash === idOrHash);
    if (index === -1) return;
    items[index] = { ...items[index], ...patch, updatedAt: new Date().toISOString() };
    patchTransferRecord(items[index].id || items[index].burnTxHash, {
        ...patch,
        state: patch.state || stateFromRecoveryStatus(items[index]),
    }, { sync: options.sync });
    writePendingRecoveries(items);
}

function settlePendingRecoveryFromBackend(transfer) {
    if (!transfer?.burnTxHash) return;
    const items = readPendingRecoveries();
    const index = items.findIndex(item =>
        item.id === transfer.id ||
        item.id === transfer.recoveryId ||
        item.burnTxHash === transfer.burnTxHash
    );
    if (index === -1) return;
    const isAlreadyClaimed = transfer.state === TRANSFER_STATES.ALREADY_CLAIMED || transfer.alreadyMinted;
    items[index] = {
        ...items[index],
        status: 'minted',
        state: isAlreadyClaimed ? TRANSFER_STATES.ALREADY_CLAIMED : TRANSFER_STATES.COMPLETED,
        mintTxHash: transfer.mintTxHash || items[index].mintTxHash || null,
        alreadyMinted: Boolean(isAlreadyClaimed),
        errorMessage: null,
        updatedAt: transfer.updatedAt || new Date().toISOString(),
    };
    writePendingRecoveries(items);
}

function unlockInterruptedRecoveries() {
    const items = readPendingRecoveries();
    let changed = false;
    const unlocked = items.map(item => {
        if (item.status !== 'attesting' && item.status !== 'minting') return item;
        changed = true;
        return {
            ...item,
            status: 'burned',
            errorMessage: PRODUCT_ERROR_MESSAGES.genericRecoverable,
            updatedAt: new Date().toISOString(),
        };
    });
    if (changed) writePendingRecoveries(unlocked);
}

function getErrorText(error, depth = 0, seen = new WeakSet()) {
    if (error === null || error === undefined || depth > 8) return '';
    if (typeof error === 'string') return error;
    if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') return String(error);
    if (typeof error !== 'object') return '';
    if (seen.has(error)) return '';
    seen.add(error);

    const parts = [];
    for (const key of [
        'message',
        'shortMessage',
        'details',
        'reason',
        'name',
        'code',
        'data',
        'error',
        'cause',
        'info',
        'metaMessages',
    ]) {
        if (key in error) parts.push(getErrorText(error[key], depth + 1, seen));
    }

    if (Array.isArray(error)) {
        for (const value of error) parts.push(getErrorText(value, depth + 1, seen));
    } else {
        for (const value of Object.values(error)) parts.push(getErrorText(value, depth + 1, seen));
    }

    return parts.filter(Boolean).join(' ');
}

function isNonceAlreadyUsedError(error) {
    return getErrorText(error).toLowerCase().includes('nonce already used');
}

function getProductErrorMessage(error) {
    const text = getErrorText(error) || String(error?.message || error || '');
    const lower = text.toLowerCase();

    if (isNonceAlreadyUsedError(error)) return PRODUCT_ERROR_MESSAGES.alreadyClaimed;
    if (lower.includes('attestation is still pending') || lower.includes('not ready yet') || lower.includes('has not indexed')) {
        return lower.includes('indexed') ? PRODUCT_ERROR_MESSAGES.circleIndexing : PRODUCT_ERROR_MESSAGES.attestationPending;
    }
    if (lower.includes('messageexpired') || (lower.includes('message') && lower.includes('expired')) || lower.includes('re-attest')) {
        return PRODUCT_ERROR_MESSAGES.attestationExpired;
    }
    if (lower.includes('looks like an evm transaction hash')) return PRODUCT_ERROR_MESSAGES.solanaHashMismatch;
    if (lower.includes('looks like a solana signature')) return PRODUCT_ERROR_MESSAGES.evmHashMismatch;
    if (lower.includes('no cctp message')) return PRODUCT_ERROR_MESSAGES.noCctpMessage;
    if (lower.includes('connect backpack') || lower.includes('connect solflare') || lower.includes('solflare or backpack') || lower.includes('phantom')) {
        return PRODUCT_ERROR_MESSAGES.solanaRecoveryWallet;
    }
    if (lower.includes('plugin closed') || lower.includes('disconnectplugin')) {
        return PRODUCT_ERROR_MESSAGES.walletPluginClosed;
    }
    if (lower.includes('user rejected') || lower.includes('user denied') || lower.includes('cancelled') || lower.includes('canceled')) {
        return PRODUCT_ERROR_MESSAGES.walletRejected;
    }
    if (lower.includes('read-only and non-configurable') || lower.includes('proxy did not return') || lower.includes('did not return a solana public key')) {
        return PRODUCT_ERROR_MESSAGES.walletConnection;
    }
    if (lower.includes('execution reverted') || lower.includes('transaction reverted') || lower.includes('simulation failed')) {
        return PRODUCT_ERROR_MESSAGES.simulationFailed;
    }
    if (lower.includes('already claimed') || lower.includes('already minted')) return PRODUCT_ERROR_MESSAGES.alreadyClaimed;
    return text || PRODUCT_ERROR_MESSAGES.genericRecoverable;
}

function isEvmTxHash(value) {
    return /^0x[0-9a-fA-F]{64}$/.test(String(value || '').trim());
}

function isLikelySolanaSignature(value) {
    const normalized = String(value || '').trim();
    return /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(normalized);
}

function validateBurnHashForSource(source, burnTxHash) {
    if (source === 'solana' && isEvmTxHash(burnTxHash)) {
        throw new Error(PRODUCT_ERROR_MESSAGES.solanaHashMismatch);
    }
    if (source !== 'solana' && !isEvmTxHash(burnTxHash) && isLikelySolanaSignature(burnTxHash)) {
        throw new Error(PRODUCT_ERROR_MESSAGES.evmHashMismatch);
    }
}

function getManualDestinationAddress() {
    return String(destinationAddressInput?.value || '').trim();
}

function getDefaultDestinationAddress(chain) {
    return chain === 'solana' ? solanaAccount : evmAccount;
}

function validateDestinationAddress(chain, address) {
    const value = String(address || '').trim();
    if (!value) throw new Error(PRODUCT_ERROR_MESSAGES.missingDestinationAddress);
    if (chain === 'solana') {
        try {
            new PublicKey(value);
            return value;
        } catch {
            throw new Error(PRODUCT_ERROR_MESSAGES.invalidDestinationAddress);
        }
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw new Error(PRODUCT_ERROR_MESSAGES.invalidDestinationAddress);
    }
    return value;
}

function getDestinationRecipient(chain) {
    return validateDestinationAddress(chain, getManualDestinationAddress() || getDefaultDestinationAddress(chain));
}

function syncDestinationAddressUI() {
    if (!destinationAddressInput) return true;
    const chain = destinationChainSelect?.value || 'solana';
    const manualAddress = getManualDestinationAddress();
    destinationAddressInput.placeholder = chain === 'solana'
        ? 'Use connected Solana wallet'
        : 'Use connected EVM wallet';

    let message = `Leave blank to receive with your connected ${chain === 'solana' ? 'Solana' : 'EVM'} wallet.`;
    let valid = true;
    if (manualAddress) {
        try {
            validateDestinationAddress(chain, manualAddress);
            message = `Receiving on ${CHAIN_LABELS[chain] || chain}: ${shortHash(manualAddress)}`;
        } catch {
            valid = false;
            message = PRODUCT_ERROR_MESSAGES.invalidDestinationAddress;
        }
    }
    destinationAddressContainer?.classList.toggle('invalid', !valid);
    if (destinationAddressHint) destinationAddressHint.textContent = message;
    return valid;
}

function markRecoveryAlreadyMinted(recoveryKey, source, destination, transfer, burnTxHash) {
    patchPendingRecovery(recoveryKey, {
        status: 'minted',
        mintTxHash: null,
        errorMessage: null,
        alreadyMinted: true,
        state: TRANSFER_STATES.ALREADY_CLAIMED,
    });
    patchTransferRecord(recoveryKey || burnTxHash, {
        state: TRANSFER_STATES.ALREADY_CLAIMED,
        burnTxHash,
        alreadyMinted: true,
        errorMessage: null,
    });
    log(`${PRODUCT_ERROR_MESSAGES.alreadyClaimed} Marked complete for burn ${shortHash(burnTxHash)}.`, 'success');
    addActivity('Recovery', source, destination, transfer.amount || 'unknown', 'success', null, {
        burnTxHash,
        recoveryId: recoveryKey,
        alreadyMinted: true,
        lifecycleState: TRANSFER_STATES.ALREADY_CLAIMED,
        lifecycleLabel: getTransferStateLabel(TRANSFER_STATES.ALREADY_CLAIMED),
    });
    updateBalances();
    return { state: 'already-minted', txHash: null };
}

function normalizeAlreadyClaimedRecoveries() {
    const items = readPendingRecoveries();
    let changed = false;
    const normalized = items.map(item => {
        if (item.status === 'minted') return item;
        if (!isNonceAlreadyUsedError(item.errorMessage)) return item;
        changed = true;
        return {
            ...item,
            status: 'minted',
            mintTxHash: item.mintTxHash || null,
            errorMessage: null,
            alreadyMinted: true,
            state: TRANSFER_STATES.ALREADY_CLAIMED,
            updatedAt: new Date().toISOString(),
        };
    });
    if (changed) writePendingRecoveries(normalized);
}

function renderPendingRecoveries() {
    if (!pendingRecoveriesEl) return;
    const actionable = getActionableRecoveries();
    if (actionable.length === 0) {
        pendingRecoveriesEl.innerHTML = '<div class="recovery-empty">No pending CCTP recovery checkpoints.</div>';
        return;
    }

    pendingRecoveriesEl.innerHTML = actionable.map(item => {
        const route = `${CHAIN_LABELS[item.from] || item.from || 'Solana'} -> ${CHAIN_LABELS[item.to] || item.to || 'Arc'}`;
        const disabled = item.status === 'attesting' || item.status === 'minting';
        const label = disabled ? 'Working...' : 'Resume transfer';
        const lifecycleState = stateFromRecoveryStatus(item);
        const lifecycleLabel = getTransferStateLabel(lifecycleState);
        const markLabel = isNonceAlreadyUsedError(item.errorMessage) ? 'Mark complete' : 'Already claimed?';
        const message = item.errorMessage ? getProductErrorMessage(item.errorMessage) : '';
        return `
            <div class="recovery-item">
                <div class="recovery-item-main">
                    <strong>${escapeHtml(route)}</strong>
                    <span>${escapeHtml(item.amount || '?')} USDC • <span class="lifecycle-chip ${escapeHtml(getTransferStatusBucket(lifecycleState))}">${escapeHtml(lifecycleLabel)}</span></span>
                    <span>Burn ${escapeHtml(shortHash(item.burnTxHash))} • Destination ${escapeHtml(CHAIN_LABELS[item.to] || item.to || 'unknown')}</span>
                    ${message ? `<small>${escapeHtml(message)}</small>` : ''}
                </div>
                <div class="recovery-item-actions">
                    <button class="btn btn-glass btn-sm" data-recover-id="${escapeHtml(item.id)}" ${disabled ? 'disabled' : ''}>
                        ${label}
                    </button>
                    <button class="btn btn-glass btn-sm" data-mark-recovered-id="${escapeHtml(item.id)}">
                        ${markLabel}
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function renderRecoveryBanner() {
    if (!recoveryBanner) return;
    const actionable = getActionableRecoveries();
    const count = actionable.length;
    recoveryBanner.hidden = count === 0;
    if (recoveryBannerText) {
        const noun = count === 1 ? 'transfer' : 'transfers';
        recoveryBannerText.textContent = `${count} ${noun} ready to resume after source burn.`;
    }
    if (resumeAllRecoveriesBtn) {
        const resumable = actionable.some(item => item.status !== 'attesting' && item.status !== 'minting');
        resumeAllRecoveriesBtn.disabled = isResumingRecoveries || !resumable;
    }
}

function syncRecoveryRouteControls(changedSelect = null) {
    if (!recoverySourceChainSelect || !recoveryDestinationChainSelect) return;
    if (recoverySourceChainSelect.value === recoveryDestinationChainSelect.value) {
        const target = changedSelect === recoverySourceChainSelect ? recoveryDestinationChainSelect : recoverySourceChainSelect;
        const forbiddenValue = changedSelect?.value || recoveryDestinationChainSelect.value;
        const nextOption = Array.from(target.options).find(option => option.value !== forbiddenValue);
        if (nextOption) target.value = nextOption.value;
    }

}

function toBytes(hex) {
    const normalized = hex.replace(/^0x/, '');
    if (normalized.length % 2 !== 0) throw new Error('Hex value must have an even length');
    return new Uint8Array(Buffer.from(normalized, 'hex'));
}

function normalizeEventNonce(eventNonce) {
    if (eventNonce === undefined || eventNonce === null || eventNonce === '') {
        throw new Error('Circle attestation response did not include an event nonce');
    }
    const raw = String(eventNonce);
    const value = raw.startsWith('0x') ? BigInt(raw) : BigInt(raw);
    return `0x${value.toString(16).padStart(64, '0')}`;
}

function getPublicClientForChain(chainKey) {
    const chain = EVM_CHAINS[chainKey];
    if (!chain) throw new Error(`Unsupported EVM chain: ${chainKey}`);
    return createPublicClient({ chain, transport: http() });
}

async function ensureEvmChain(chainKey) {
    const chain = EVM_CHAINS[chainKey];
    if (!chain) throw new Error(`Unsupported EVM chain: ${chainKey}`);
    if (!currentEvmProvider || !evmAccount) throw new Error(`Connect an EVM wallet for ${chain.name} first`);

    const targetChainId = `0x${chain.id.toString(16)}`;
    const currentChainId = await currentEvmProvider.request({ method: 'eth_chainId' });
    if (currentChainId?.toLowerCase?.() === targetChainId.toLowerCase()) return;

    try {
        await currentEvmProvider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: targetChainId }]
        });
    } catch (e) {
        const isMissing = e.code === 4902 ||
            e?.message?.toLowerCase?.().includes('not configured') ||
            e?.message?.toLowerCase?.().includes('unrecognized chain id');
        if (!isMissing) throw e;
        await currentEvmProvider.request({
            method: 'wallet_addEthereumChain',
            params: [{
                chainId: targetChainId,
                chainName: chain.name,
                nativeCurrency: chain.nativeCurrency,
                rpcUrls: chain.rpcUrls.default.http,
                blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : null
            }]
        });
    }
}

async function fetchCctpAttestation(sourceDomain, burnTxHash) {
    const url = `${IRIS_API}/v2/messages/${sourceDomain}?transactionHash=${encodeURIComponent(burnTxHash)}`;
    const response = await fetch(url);
    if (response.status === 404) {
        throw new Error('Circle has not indexed this burn yet. Try again in a moment.');
    }
    if (!response.ok) {
        throw new Error(`Circle attestation lookup failed (${response.status})`);
    }

    const data = await response.json();
    const message = data.messages?.[0];
    if (!message) {
        throw new Error('No CCTP message found for that burn transaction.');
    }

    const attestation = message.attestation;
    const status = String(message.status || '').toLowerCase();
    const isComplete = attestation?.startsWith?.('0x') && !status.includes('pending');
    if (!isComplete) {
        return { status: 'pending', raw: message };
    }

    return {
        status: 'complete',
        message: message.message,
        attestation,
        eventNonce: message.eventNonce,
        raw: message,
    };
}

function getAttestationExpirationBlock(attestationData) {
    const raw = attestationData?.raw || attestationData;
    const value = raw?.decodedMessage?.decodedMessageBody?.expirationBlock ??
        raw?.decodedMessage?.messageBody?.expirationBlock ??
        raw?.expirationBlock;
    if (value === undefined || value === null || value === '') return null;
    try {
        return BigInt(value);
    } catch {
        return null;
    }
}

async function getDestinationProgressBlock(chainKey) {
    if (chainKey === 'solana') {
        const connection = new Connection(SOLANA_DEVNET_RPC, 'confirmed');
        return BigInt(await connection.getSlot('confirmed'));
    }
    const client = getPublicClientForChain(chainKey);
    return BigInt(await client.getBlockNumber());
}

async function requestCircleReAttestation(eventNonce) {
    const nonce = String(eventNonce || '').trim();
    if (!nonce) throw new Error('Circle attestation response did not include an event nonce');
    const response = await fetch(`${IRIS_API}/v2/reattest/${encodeURIComponent(nonce)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
    });
    if (!response.ok) {
        throw new Error(`Failed to request fresh Circle attestation (${response.status})`);
    }
    return response.json();
}

async function reAttestCctpBurn(sourceDomain, burnTxHash, eventNonce) {
    await requestCircleReAttestation(eventNonce);
    let latest = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, attempt < 3 ? 1500 : 3000));
        latest = await fetchCctpAttestation(sourceDomain, burnTxHash);
        if (latest.status !== 'complete') continue;
        const expirationBlock = getAttestationExpirationBlock(latest);
        if (expirationBlock === 0n || expirationBlock === null) return latest;
    }
    return latest;
}

async function refreshExpiredAttestationIfNeeded(attestationData, sourceDomain, burnTxHash, destination) {
    const expirationBlock = getAttestationExpirationBlock(attestationData);
    if (expirationBlock === null || expirationBlock === 0n) return attestationData;

    let currentBlock = null;
    try {
        currentBlock = await getDestinationProgressBlock(destination);
    } catch (e) {
        console.warn('[QuantumBridge] Could not check destination progress for attestation expiry', e);
    }

    const shouldRefresh = currentBlock === null || currentBlock + 25n >= expirationBlock;
    if (!shouldRefresh) return attestationData;

    log(PRODUCT_ERROR_MESSAGES.attestationExpired, 'loading');
    return reAttestCctpBurn(sourceDomain, burnTxHash, attestationData.eventNonce);
}

async function submitEvmMint(destinationChain, message, attestation) {
    const transmitter = MESSAGE_TRANSMITTER_V2[destinationChain];
    if (!transmitter) throw new Error(`Recovery is not configured for ${destinationChain}`);
    if (!/^0x[0-9a-fA-F]+$/.test(message) || !/^0x[0-9a-fA-F]+$/.test(attestation)) {
        throw new Error('Circle returned invalid message or attestation bytes');
    }

    await ensureEvmChain(destinationChain);
    const data = encodeFunctionData({
        abi: RECEIVE_MESSAGE_ABI,
        functionName: 'receiveMessage',
        args: [message, attestation],
    });

    const txHash = await currentEvmProvider.request({
        method: 'eth_sendTransaction',
        params: [{
            from: evmAccount,
            to: transmitter,
            data,
        }],
    });

    const receipt = await getPublicClientForChain(destinationChain).waitForTransactionReceipt({
        hash: txHash,
    });

    if (receipt.status !== 'success') {
        throw new Error(`Destination mint reverted: ${txHash}`);
    }

    return txHash;
}

async function submitSolanaMint(sourceChain, message, attestation, eventNonce, destinationAddress) {
    if (!solanaAdapter || !solanaAccount) {
        throw new Error(PRODUCT_ERROR_MESSAGES.solanaRecoveryWallet);
    }
    if (solanaWalletType === 'phantom') {
        throw new Error(PRODUCT_ERROR_MESSAGES.solanaRecoveryWallet);
    }

    const sourceChainDefinition = CIRCLE_CHAIN_DEFINITIONS[sourceChain];
    const solanaChainDefinition = CIRCLE_CHAIN_DEFINITIONS.solana;
    if (!sourceChainDefinition || !solanaChainDefinition) {
        throw new Error(`Unsupported Solana recovery route: ${sourceChain} -> solana`);
    }

    const prepared = await solanaAdapter.prepareAction('cctp.v2.receiveMessage', {
        fromChain: sourceChainDefinition,
        toChain: solanaChainDefinition,
        message,
        attestation,
        eventNonce: normalizeEventNonce(eventNonce),
        destinationAddress: destinationAddress || solanaAccount,
    }, {
        chain: solanaChainDefinition,
        address: solanaAccount,
    });

    return prepared.execute();
}

async function recoverCctpMint(transfer) {
    const burnTxHash = String(transfer.burnTxHash || '').trim();
    if (!burnTxHash) throw new Error('Enter a source burn transaction hash or signature');
    const source = transfer.from || 'solana';
    const destination = transfer.to || 'arc';
    if (source === destination) throw new Error('Source and destination chains must be different');
    validateBurnHashForSource(source, burnTxHash);
    const sourceDomain = transfer.sourceDomain ?? CCTP_DOMAINS[source];
    const recoveryKey = transfer.id || burnTxHash;

    if (!sourceDomain && sourceDomain !== 0) throw new Error('Missing CCTP source domain');

    upsertPendingRecovery({
        ...transfer,
        id: recoveryKey,
        from: source,
        to: destination,
        burnTxHash,
        status: 'attesting',
        errorMessage: null,
        state: TRANSFER_STATES.ATTESTATION_PENDING,
    });
    patchTransferRecord(recoveryKey, {
        from: source,
        to: destination,
        burnTxHash,
        state: TRANSFER_STATES.ATTESTATION_PENDING,
        errorMessage: null,
    });
    log(`Checking Circle attestation for ${shortHash(burnTxHash)}...`);

    let attestationData = await fetchCctpAttestation(sourceDomain, burnTxHash);
    if (attestationData.status !== 'complete') {
        patchPendingRecovery(recoveryKey, {
            status: 'burned',
            state: TRANSFER_STATES.RECOVERABLE,
            errorMessage: PRODUCT_ERROR_MESSAGES.attestationPending,
        });
        log(`${PRODUCT_ERROR_MESSAGES.attestationPending} Try Resume transfer again shortly.`, 'loading');
        return null;
    }

    if (destination === 'solana') {
        attestationData = await refreshExpiredAttestationIfNeeded(attestationData, sourceDomain, burnTxHash, destination);
        patchPendingRecovery(recoveryKey, {
            status: 'minting',
            state: TRANSFER_STATES.MINT_SUBMITTED,
            errorMessage: null,
        });
        log('Attestation ready. Submitting Solana receiveMessage...');
        let mintTxHash;
        try {
            mintTxHash = await submitSolanaMint(
                source,
                attestationData.message,
                attestationData.attestation,
                attestationData.eventNonce,
                transfer.recipient || solanaAccount,
            );
        } catch (e) {
            if (isNonceAlreadyUsedError(e)) {
                return markRecoveryAlreadyMinted(recoveryKey, source, destination, transfer, burnTxHash);
            }
            console.warn('[QuantumBridge] Solana mint failed, trying one fresh attestation retry', e);
            const freshAttestationData = await reAttestCctpBurn(sourceDomain, burnTxHash, attestationData.eventNonce);
            try {
                mintTxHash = await submitSolanaMint(
                    source,
                    freshAttestationData.message,
                    freshAttestationData.attestation,
                    freshAttestationData.eventNonce,
                    transfer.recipient || solanaAccount,
                );
            } catch (retryError) {
                if (isNonceAlreadyUsedError(retryError)) {
                    return markRecoveryAlreadyMinted(recoveryKey, source, destination, transfer, burnTxHash);
                }
                throw retryError;
            }
        }
        patchPendingRecovery(recoveryKey, {
            status: 'minted',
            state: TRANSFER_STATES.COMPLETED,
            mintTxHash,
            errorMessage: null,
        });
        log(`Recovery mint complete: <a href="${getLink(destination, mintTxHash)}" target="_blank" class="log-link">${shortHash(mintTxHash)}</a>`, 'success');
        addActivity('Recovery', source, destination, transfer.amount || 'unknown', 'success', mintTxHash, {
            burnTxHash,
            recoveryId: recoveryKey,
            lifecycleState: TRANSFER_STATES.COMPLETED,
            lifecycleLabel: getTransferStateLabel(TRANSFER_STATES.COMPLETED),
        });
        updateBalances();
        return { state: 'minted', txHash: mintTxHash };
    }

    patchPendingRecovery(recoveryKey, {
        status: 'minting',
        state: TRANSFER_STATES.MINT_SUBMITTED,
        errorMessage: null,
    });
    log(`Attestation ready. Submitting ${destination.toUpperCase()} receiveMessage...`);
    let mintTxHash;
    try {
        mintTxHash = await submitEvmMint(destination, attestationData.message, attestationData.attestation);
    } catch (e) {
        if (isNonceAlreadyUsedError(e)) {
            return markRecoveryAlreadyMinted(recoveryKey, source, destination, transfer, burnTxHash);
        }
        throw e;
    }
    patchPendingRecovery(recoveryKey, {
        status: 'minted',
        state: TRANSFER_STATES.COMPLETED,
        mintTxHash,
        errorMessage: null,
    });
    log(`Recovery mint complete: <a href="${getLink(destination, mintTxHash)}" target="_blank" class="log-link">${shortHash(mintTxHash)}</a>`, 'success');
    addActivity('Recovery', source, destination, transfer.amount || 'unknown', 'success', mintTxHash, {
        burnTxHash,
        recoveryId: recoveryKey,
        lifecycleState: TRANSFER_STATES.COMPLETED,
        lifecycleLabel: getTransferStateLabel(TRANSFER_STATES.COMPLETED),
    });
    updateBalances();
    return { state: 'minted', txHash: mintTxHash };
}

async function resumeRecoveries(recoveries) {
    let recovered = 0;
    for (const queuedTransfer of recoveries) {
        const transfer = readPendingRecoveries().find(item => item.id === queuedTransfer.id || item.burnTxHash === queuedTransfer.burnTxHash);
        if (!transfer || transfer.status === 'minted' || transfer.status === 'attesting' || transfer.status === 'minting') continue;
        try {
            const result = await recoverCctpMint(transfer);
            if (result?.state === 'minted' || result?.state === 'already-minted') recovered += 1;
        } catch (e) {
            if (isNonceAlreadyUsedError(e)) {
                markRecoveryAlreadyMinted(transfer.id || transfer.burnTxHash, transfer.from || 'solana', transfer.to || 'arc', transfer, transfer.burnTxHash);
                recovered += 1;
            } else {
                const errorText = getProductErrorMessage(e);
                patchPendingRecovery(transfer.id || transfer.burnTxHash, {
                    status: 'burned',
                    state: TRANSFER_STATES.RECOVERABLE,
                    errorMessage: errorText,
                });
                log(`Resume transfer paused for ${shortHash(transfer.burnTxHash)}: ${errorText}`, 'error');
            }
        }
    }
    return recovered;
}

async function updateBalances() {
    if (evmAccount) {
        try {
            const arcClient = createPublicClient({ chain: arcTestnet, transport: http(), pollingInterval: 100 });
            const ethClient = createPublicClient({ chain: ethSepolia, transport: http() });
            
            const balAbi = [{ name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }];
            
            const arcBal = await arcClient.getBalance({ address: evmAccount });
            const ethBal = await ethClient.readContract({
                address: USDC_ADDRS['ethereum'],
                abi: balAbi,
                functionName: 'balanceOf',
                args: [evmAccount]
            });

            balances.arc = parseFloat(formatUnits(arcBal, 18));
            balances.ethereum = parseFloat(formatUnits(ethBal, 6));

            if (originChainSelect.value === 'arc') document.getElementById('origin-balance').innerText = balances.arc.toFixed(2);
            if (originChainSelect.value === 'ethereum') document.getElementById('origin-balance').innerText = balances.ethereum.toFixed(2);
            if (destinationChainSelect.value === 'arc') document.getElementById('dest-balance').innerText = balances.arc.toFixed(2);
            if (destinationChainSelect.value === 'ethereum') document.getElementById('dest-balance').innerText = balances.ethereum.toFixed(2);
        } catch (e) {
            console.error("EVM balance fetch failed", e);
        }
    }

    if (solanaAccount) {
        try {
            const connection = new Connection(SOLANA_DEVNET_RPC, "confirmed");
            const mint = new PublicKey(USDC_ADDRS['solana']);
            const owner = new PublicKey(solanaAccount);
            const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, { mint });
            
            let bal = 0;
            if (tokenAccounts.value.length > 0) {
                bal = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
            }
            balances.solana = bal;
            const solBal = await connection.getBalance(owner);
            balances.solana_native = solBal / 1e9;
            console.log(`[QuantumBridge] Balances: USDC=${bal}, SOL=${balances.solana_native}`);
            
            if (originChainSelect.value === 'solana') document.getElementById('origin-balance').innerText = balances.solana.toFixed(2);
            if (destinationChainSelect.value === 'solana') document.getElementById('dest-balance').innerText = balances.solana.toFixed(2);
        } catch (e) {
            console.error("Solana balance fetch failed", e);
        }
    }
}

const evmProviders = [];
let evmRestoreAttempted = false;
let solanaRestoreAttempted = false;
let walletRestoreScheduled = false;

function inferEvmProviderName(provider, index = 0) {
    if (provider?.isZerion || provider?.isZerionWallet) return 'Zerion';
    if (provider?.isRabby) return 'Rabby';
    if (provider?.isMetaMask) return 'MetaMask';
    if (provider?.isCoinbaseWallet) return 'Coinbase Wallet';
    if (provider?.isBraveWallet) return 'Brave Wallet';
    if (provider?.isOKExWallet) return 'OKX Wallet';
    if (provider?.isTrust) return 'Trust Wallet';
    return index === 0 ? 'Detected Wallet' : `Detected Wallet ${index + 1}`;
}

function inferEvmProviderRdns(provider) {
    if (provider?.isZerion || provider?.isZerionWallet) return 'io.zerion.wallet';
    if (provider?.isRabby) return 'io.rabby';
    if (provider?.isMetaMask) return 'io.metamask';
    if (provider?.isCoinbaseWallet) return 'com.coinbase.wallet';
    if (provider?.isBraveWallet) return 'com.brave.wallet';
    return null;
}

function buildLegacyEvmProviderDetail(provider, index = 0) {
    const name = inferEvmProviderName(provider, index);
    const rdns = inferEvmProviderRdns(provider);
    return {
        info: {
            uuid: `legacy-${rdns || name}-${index}`.toLowerCase().replace(/[^a-z0-9.-]+/g, '-'),
            rdns,
            name,
            icon: '',
        },
        provider,
    };
}

function registerEvmProvider(providerDetail) {
    if (!providerDetail?.provider) return false;
    const info = providerDetail.info || {};
    const exists = evmProviders.some(existing =>
        existing.provider === providerDetail.provider ||
        (info.uuid && existing.info?.uuid === info.uuid) ||
        (info.rdns && existing.info?.rdns === info.rdns && existing.info?.name === info.name)
    );
    if (exists) return false;
    evmProviders.push(providerDetail);
    renderEvmWallets();
    scheduleWalletSessionRestore();
    return true;
}

function scanLegacyEvmProviders() {
    const injected = [];
    if (Array.isArray(window.ethereum?.providers)) {
        injected.push(...window.ethereum.providers);
    } else if (window.ethereum) {
        injected.push(window.ethereum);
    }
    if (window.zerion?.ethereum) injected.push(window.zerion.ethereum);

    injected.filter(Boolean).forEach((provider, index) => {
        registerEvmProvider(buildLegacyEvmProviderDetail(provider, index));
    });
}

window.addEventListener("eip6963:announceProvider", (event) => {
    registerEvmProvider(event.detail);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));
scanLegacyEvmProviders();
window.setTimeout(scanLegacyEvmProviders, 500);
window.setTimeout(scanLegacyEvmProviders, 1500);

function renderEvmWallets() {
    const list = document.getElementById('evm-wallet-list');
    if (!list) return;
    if (evmProviders.length === 0) {
        list.innerHTML = `
            <div class="wallet-empty">
                No EVM wallets detected in this browser.
                <br>
                Install an EVM wallet extension (for example MetaMask) and refresh.
            </div>
        `;
        return;
    }

    list.innerHTML = evmProviders.map(provider => {
        const name = provider.info.name || 'Wallet';
        const icon = provider.info.icon
            ? `<img src="${provider.info.icon}" alt="${name}" class="wallet-icon">`
            : `<span class="wallet-fallback-icon" aria-hidden="true">${escapeHtml(name.slice(0, 1).toUpperCase())}</span>`;
        return `
        <div class="wallet-option" data-uuid="${provider.info.uuid}">
            ${icon}
            <span class="wallet-name">${escapeHtml(name)}</span>
        </div>
    `;
    }).join('');

    list.querySelectorAll('.wallet-option').forEach(opt => {
        opt.addEventListener('click', () => {
            const uuid = opt.getAttribute('data-uuid');
            const providerDetail = evmProviders.find(p => p.info.uuid === uuid);
            connectEvmWallet(providerDetail);
            closeWalletModal();
        });
    });
}

function getSavedEvmProviderDetail() {
    const saved = readWalletSession().evm;
    if (!saved) return null;
    const exactProvider = evmProviders.find(provider =>
        (saved.uuid && provider.info.uuid === saved.uuid) ||
        (saved.rdns && provider.info.rdns === saved.rdns) ||
        (saved.name && provider.info.name === saved.name)
    );
    if (exactProvider) return exactProvider;
    if (saved.detectedFallback && window.ethereum) {
        return {
            info: {
                uuid: null,
                rdns: null,
                name: saved.name || 'Detected Wallet',
                icon: saved.icon || '',
            },
            provider: window.ethereum,
        };
    }
    return null;
}

function scheduleWalletSessionRestore() {
    if (walletRestoreScheduled) return;
    walletRestoreScheduled = true;
    window.setTimeout(async () => {
        walletRestoreScheduled = false;
        await restoreWalletSessions();
    }, 250);
}

async function restoreWalletSessions() {
    const session = readWalletSession();
    if (!evmAccount && !evmRestoreAttempted && session.evm) {
        const providerDetail = getSavedEvmProviderDetail();
        if (providerDetail) {
            evmRestoreAttempted = true;
            await connectEvmWallet(providerDetail, { silent: true });
        }
    }

    if (!solanaAccount && !solanaRestoreAttempted && session.solana?.walletType) {
        const provider = getSolanaWalletProvider(session.solana.walletType);
        if (provider) {
            solanaRestoreAttempted = true;
            await connectSolanaWallet(session.solana.walletType, { silent: true });
        }
    }
}

async function connectEvmWallet(providerDetail, options = {}) {
    const { silent = false } = options;
    try {
        if (!providerDetail?.provider) throw new Error('No EVM wallet provider available');
        if (!silent) log(`Linking ${providerDetail.info.name}...`);
        currentEvmProvider = providerDetail.provider;
        
        if (!currentEvmProvider._isQuantumPatched) {
            const originalRequest = currentEvmProvider.request.bind(currentEvmProvider);
            currentEvmProvider.request = async (args) => {
                if (args.method === 'wallet_switchEthereumChain') {
                    try {
                        return await originalRequest(args);
                    } catch (e) {
                        const isMissing = e.code === 4902 || 
                                          e?.message?.toLowerCase().includes('not configured') || 
                                          e?.message?.toLowerCase().includes('unrecognized chain id');
                        if (isMissing) {
                            const targetChainIdHex = args.params[0].chainId.toLowerCase();
                            const arcHex = `0x${arcTestnet.id.toString(16)}`.toLowerCase();
                            const ethHex = `0x${ethSepolia.id.toString(16)}`.toLowerCase();
                            
                            let chainToConfig = null;
                            if (targetChainIdHex === arcHex) chainToConfig = arcTestnet;
                            else if (targetChainIdHex === ethHex) chainToConfig = ethSepolia;
                            
                            if (chainToConfig) {
                                return await originalRequest({
                                    method: 'wallet_addEthereumChain',
                                    params: [{
                                        chainId: targetChainIdHex,
                                        chainName: chainToConfig.name,
                                        nativeCurrency: chainToConfig.nativeCurrency,
                                        rpcUrls: chainToConfig.rpcUrls.default.http,
                                        blockExplorerUrls: chainToConfig.blockExplorers ? [chainToConfig.blockExplorers.default.url] : null
                                    }]
                                });
                            }
                        }
                        throw e;
                    }
                }
                return originalRequest(args);
            };
            currentEvmProvider._isQuantumPatched = true;
        }

        const accounts = await currentEvmProvider.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' });
        if (!accounts?.[0]) {
            currentEvmProvider = null;
            evmAdapter = null;
            if (silent) return false;
            throw new Error('No authorized EVM account returned');
        }
        evmAccount = accounts[0];
        evmAdapter = await createViemAdapterFromProvider({ provider: currentEvmProvider });

        if (evmAdapter && evmAdapter.waitForTransaction) {
            const originalEvmWait = evmAdapter.waitForTransaction.bind(evmAdapter);
            evmAdapter.waitForTransaction = async (txHash, config, chain) => {
                const customConfig = { ...config, timeout: 600000 };
                return originalEvmWait(txHash, customConfig, chain);
            };
        }

        connectEvmBtn.querySelector('span').innerText = `${evmAccount.slice(0, 6)}...${evmAccount.slice(-4)}`;
        document.getElementById('disconnect-btn').style.display = 'inline-block';
        rememberEvmWallet(providerDetail, evmAccount);
        log(`${silent ? 'EVM Node Restored' : 'EVM Node Linked'}: ${evmAccount}`, 'success');
        checkReady();
        updateBalances();
        syncServerTransfersForConnectedWallets();
        return true;
    } catch (e) {
        currentEvmProvider = null;
        evmAdapter = null;
        if (silent) {
            console.warn('[QuantumBridge] Silent EVM restore skipped.', e);
            return false;
        }
        log(`Link failed: ${getProductErrorMessage(e)}`, 'error');
        return false;
    }
}

connectEvmBtn.addEventListener('click', () => {
    sounds.play('click');
    if (evmAccount) return;
    if (evmProviders.length === 0 && window.ethereum) {
        connectEvmWallet({ info: { name: 'Detected Wallet', icon: '' }, provider: window.ethereum });
    } else {
        openWalletModal('evm');
    }
});

function setWalletModalTab(tab) {
    walletModalTabs.forEach(btn => {
        const active = btn.getAttribute('data-tab') === tab;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    walletModalSections.forEach(section => {
        const active = section.getAttribute('data-section') === tab;
        section.style.display = active ? '' : 'none';
    });

    // Keep EVM list state fresh when user opens/switches tabs.
    if (tab === 'evm') renderEvmWallets();
    if (tab === 'solana') refreshSolanaWalletDetection();
}

function openWalletModal(tab = 'evm') {
    setWalletModalTab(tab);
    quantumWalletModal.style.display = 'flex';
    document.body.classList.add('modal-open');
}

function closeWalletModal() {
    quantumWalletModal.style.display = 'none';
    document.body.classList.remove('modal-open');
}

closeQuantumModalBtn.addEventListener('click', closeWalletModal);
quantumWalletModal.addEventListener('click', (e) => {
    if (e.target === quantumWalletModal) closeWalletModal();
});
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && quantumWalletModal.style.display === 'flex') closeWalletModal();
});
walletModalTabs.forEach(btn => {
    btn.addEventListener('click', () => {
        sounds.play('click');
        setWalletModalTab(btn.getAttribute('data-tab'));
    });
});

document.getElementById('disconnect-btn').addEventListener('click', () => {
    sounds.play('click');
    try { currentSolanaProvider?.disconnect?.(); } catch {}
    evmAccount = null; evmAdapter = null; currentEvmProvider = null;
    connectEvmBtn.querySelector('span').innerText = "Connect EVM";
    solanaAccount = null; solanaWalletType = null; solanaAdapter = null; currentSolanaProvider = null;
    evmRestoreAttempted = false; solanaRestoreAttempted = false;
    clearWalletSession();
    clearVisibleTransferState();
    clearLegacyTransferBrowserStorage();
    connectSolanaBtn.querySelector('span').innerText = "Connect Solana";
    document.getElementById('disconnect-btn').style.display = 'none';
    updateBalances(); checkReady();
});

connectSolanaBtn.addEventListener('click', () => {
    sounds.play('click');
    if (solanaAccount) return;
    openWalletModal('solana');
});

document.querySelectorAll('#quantum-wallet-modal .wallet-option[data-wallet]').forEach(opt => {
    opt.addEventListener('click', async () => {
        const walletType = opt.getAttribute('data-wallet');
        closeWalletModal();
        await connectSolanaWallet(walletType);
    });
});

function refreshSolanaWalletDetection() {
    const items = document.querySelectorAll('#quantum-wallet-modal .wallet-option[data-wallet]');
    items.forEach(el => {
        const walletType = el.getAttribute('data-wallet');
        const provider = getSolanaWalletProvider(walletType);
        const detected = !!provider;

        el.classList.toggle('not-detected', !detected);
        el.toggleAttribute('aria-disabled', !detected);
        el.style.pointerEvents = detected ? '' : 'none';
        el.title = detected ? '' : 'Wallet not detected';
    });
}

function getSolanaWalletProvider(walletType) {
    if (walletType === 'phantom') {
        const phantom = window.phantom?.solana;
        if (phantom?.isPhantom) return phantom;
        if (window.solana?.isPhantom) return window.solana;
        return null;
    }

    if (walletType === 'solflare') {
        return window.solflare?.isSolflare ? window.solflare : null;
    }

    if (walletType === 'backpack') {
        const backpack = window.backpack?.solana || window.backpack;
        return backpack?.isBackpack ? backpack : null;
    }

    if (walletType === 'zerion') {
        const candidates = [
            window.zerion?.solana,
            window.zerionWallet?.solana,
            window.zerion?.provider?.solana,
            window.ethereum?.isZerion ? window.ethereum.solana : null,
            window.solana?.isZerion ? window.solana : null,
        ];
        return candidates.find(candidate =>
            candidate &&
            typeof candidate.connect === 'function'
        ) || null;
    }

    return null;
}

async function connectSolanaWallet(walletType, options = {}) {
    const { silent = false } = options;
    const provider = getSolanaWalletProvider(walletType);
    
    if (!provider) {
        if (!silent) {
            alert(`${walletType} wallet not detected. Use Phantom, Solflare, Backpack, or Zerion for this route.`);
        }
        return false;
    }
    const btnSpan = connectSolanaBtn.querySelector('span');
    try {
        btnSpan.innerText = silent ? "Restoring..." : "Linking...";
        connectSolanaBtn.classList.add('linking');
        let connectionResult;
        if (silent) {
            try {
                connectionResult = await provider.connect({ onlyIfTrusted: true });
            } catch (e) {
                console.warn(`[QuantumBridge] Silent ${walletType} restore skipped.`, e);
                btnSpan.innerText = "Connect Solana";
                return false;
            }
        } else {
            connectionResult = await provider.connect();
        }
        const pk = provider.publicKey || connectionResult?.publicKey;
        if (!pk) throw new Error(`${walletType} did not return a Solana public key`);
        if (typeof provider.signTransaction !== 'function') throw new Error(`${walletType} does not expose signTransaction`);
        const connectedAddress = pk.toString();
        const coerceToWeb3Transaction = (txLike) => {
            if (!txLike) return txLike;
            if (txLike instanceof VersionedTransaction) return txLike;
            if (txLike instanceof Transaction) return txLike;
            if (txLike instanceof Uint8Array) {
                try { return VersionedTransaction.deserialize(txLike); } catch {}
                try { return Transaction.from(txLike); } catch {}
                return txLike;
            }
            if (typeof txLike === 'string') {
                // Adapter-solana-kit may pass base64-encoded wire transactions to wallet providers.
                // Most browser wallets expect a VersionedTransaction object.
                // Strip any non-base64 characters in case the string is copied/logged with separators.
                let cleaned = txLike.replace(/[^A-Za-z0-9+/=_-]/g, '');
                // Normalize base64url to base64.
                cleaned = cleaned.replace(/-/g, '+').replace(/_/g, '/');
                // Ensure proper padding for base64 decode.
                const pad = cleaned.length % 4;
                if (pad) cleaned = cleaned + '='.repeat(4 - pad);

                const bytes = new Uint8Array(Buffer.from(cleaned, 'base64'));
                try {
                    return VersionedTransaction.deserialize(bytes);
                } catch {}
                try {
                    return Transaction.from(bytes);
                } catch {}

                // Fallback: parse the message portion and rebuild a VersionedTransaction with the
                // wire's signature-vector length to satisfy wallet/web3.js expectations.
                try {
                    let sigCount = 0;
                    let size = 0;
                    while (true) {
                        const b = bytes[size];
                        sigCount |= (b & 0x7f) << (size * 7);
                        size += 1;
                        if ((b & 0x80) === 0) break;
                        if (size > 3) throw new Error('shortvec too long');
                    }
                    const messageOffset = size + (sigCount * 64);
                    if (messageOffset >= bytes.length) throw new Error('wire tx too short for message');
                    const messageBytes = bytes.slice(messageOffset);

                    const message = VersionedMessage.deserialize(messageBytes);
                    const required = message.header.numRequiredSignatures;

                    const tx = new VersionedTransaction(message);
                    // Many wallets (including Rabby Solana) require signatures.length === numRequiredSignatures.
                    // The wire tx may contain more signatures (e.g., padded/placeholder), but for wallet signing
                    // we only need the required signatures.
                    tx.signatures = Array.from({ length: required }, () => new Uint8Array(64));
                    return tx;
                } catch {}

                return txLike;
            }
            // Some wallet APIs pass objects like { transaction, ... }.
            if (typeof txLike === 'object' && 'transaction' in txLike) {
                return coerceToWeb3Transaction(txLike.transaction);
            }
            return txLike;
        };

        const providerProxy = {
            get address() { return connectedAddress; },
            get isConnected() { return true; },
            get publicKey() { return provider.publicKey || pk; },
            connect: (...args) => provider.connect(...args),
            disconnect: provider.disconnect ? (...args) => provider.disconnect(...args) : async () => {},
            signTransaction: async (txLike, ...rest) => provider.signTransaction(coerceToWeb3Transaction(txLike), ...rest),
        };

        if (typeof provider.signAllTransactions === 'function') {
            providerProxy.signAllTransactions = async (txLikes, ...rest) => {
                const txs = Array.isArray(txLikes) ? txLikes.map(coerceToWeb3Transaction) : txLikes;
                return provider.signAllTransactions(txs, ...rest);
            };
        }

        if (typeof provider.signAndSendTransaction === 'function') {
            providerProxy.signAndSendTransaction = async (txLike, ...rest) => {
                return provider.signAndSendTransaction(coerceToWeb3Transaction(txLike), ...rest);
            };
        }
        
        currentSolanaProvider = providerProxy;
        console.log(`[QuantumBridge][Solana] Connected ${walletType}: ${connectedAddress}`);

        solanaAdapter = await createSolanaKitAdapterFromProvider({ 
            provider: currentSolanaProvider,
            chain: 'Solana_Devnet'
        });

        if (solanaAdapter && solanaAdapter.waitForTransaction) {
            const originalSolWait = solanaAdapter.waitForTransaction.bind(solanaAdapter);
            solanaAdapter.waitForTransaction = async (txHash, config, chain) => {
                const customConfig = { ...config, timeout: 600000 };
                return originalSolWait(txHash, customConfig, chain);
            };
        }
        
        solanaAccount = connectedAddress;
        solanaWalletType = walletType;
        connectSolanaBtn.querySelector('span').innerText = `${solanaAccount.slice(0, 4)}...${solanaAccount.slice(-4)}`;
        rememberSolanaWallet(walletType, solanaAccount);
        log(`${silent ? 'Solana Fleet Restored' : 'Solana Fleet Connected'}: ${solanaAccount}`, 'success');
        checkReady(); updateBalances();
        syncServerTransfersForConnectedWallets();
        return true;
    } catch (e) {
        solanaAccount = null;
        solanaWalletType = null;
        solanaAdapter = null;
        currentSolanaProvider = null;
        if (silent) {
            console.warn(`[QuantumBridge] Silent ${walletType} restore failed.`, e);
        } else {
            log(`Solana connection failed: ${getProductErrorMessage(e)}`, 'error');
        }
        btnSpan.innerText = "Connect Solana";
        checkReady();
        return false;
    } finally {
        connectSolanaBtn.classList.remove('linking');
    }
}

function onChainChange() {
    const from = originChainSelect.value;
    const to = destinationChainSelect.value;
    if (from === to) {
        const otherChains = Array.from(destinationChainSelect.options).map(o => o.value).filter(v => v !== from);
        destinationChainSelect.value = otherChains[0];
    }
    forwardingNotice.style.display = FORWARDER_DESTINATIONS.has(destinationChainSelect.value) ? 'flex' : 'none';
    syncDestinationAddressUI();
    updateBalances(); checkReady();
}

originChainSelect.addEventListener('change', onChainChange);
destinationChainSelect.addEventListener('change', onChainChange);

swapChainsBtn.addEventListener('click', () => {
    sounds.play('click');
    const oldFrom = originChainSelect.value;
    originChainSelect.value = destinationChainSelect.value;
    destinationChainSelect.value = oldFrom;
    onChainChange();
});

presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        sounds.play('click');
        amountInput.value = btn.getAttribute('data-value');
        checkReady();
    });
});

maxBtn.addEventListener('click', () => {
    sounds.play('click');
    const from = originChainSelect.value;
    let balance = balances[from === 'arc' ? 'arc' : (from === 'ethereum' ? 'ethereum' : 'solana')];
    amountInput.value = Math.max(0, balance - 0.01).toFixed(2);
    checkReady();
});

refreshBalancesBtn.addEventListener('click', () => {
    sounds.play('click'); updateBalances();
});

amountInput.addEventListener('input', checkReady);
destinationAddressInput?.addEventListener('input', () => {
    syncDestinationAddressUI();
    checkReady();
});

recoverySourceChainSelect?.addEventListener('change', () => syncRecoveryRouteControls(recoverySourceChainSelect));
recoveryDestinationChainSelect?.addEventListener('change', () => syncRecoveryRouteControls(recoveryDestinationChainSelect));

recoverBurnBtn?.addEventListener('click', async () => {
    const burnTxHash = recoveryBurnTxInput.value.trim();
    const source = recoverySourceChainSelect?.value || 'solana';
    const destination = recoveryDestinationChainSelect?.value || 'arc';
    const recoveryId = `${source}-${destination}-${burnTxHash}`;
    if (!burnTxHash) {
        log('Enter a source burn transaction hash or signature to recover.', 'error');
        return;
    }
    if (source === destination) {
        log('Pick different source and destination chains for recovery.', 'error');
        return;
    }
    try {
        validateBurnHashForSource(source, burnTxHash);
    } catch (e) {
        log(getProductErrorMessage(e), 'error');
        return;
    }
    try {
        sounds.play('warp');
        recoverBurnBtn.disabled = true;
        await recoverCctpMint({
            id: recoveryId,
            from: source,
            to: destination,
            sourceDomain: CCTP_DOMAINS[source],
            destinationDomain: CCTP_DOMAINS[destination],
            burnTxHash,
            recipient: destination === 'solana' ? (solanaAccount || '') : (evmAccount || ''),
            sourceWallet: source === 'solana' ? (solanaAccount || '') : (evmAccount || ''),
            destinationWallet: destination === 'solana' ? (solanaAccount || '') : (evmAccount || ''),
            wallets: [evmAccount, solanaAccount].filter(Boolean),
            amount: 'unknown',
        });
        recoveryBurnTxInput.value = '';
    } catch (e) {
        sounds.play('error');
        if (isNonceAlreadyUsedError(e)) {
            markRecoveryAlreadyMinted(recoveryId, source, destination, { id: recoveryId, from: source, to: destination, burnTxHash, amount: 'unknown' }, burnTxHash);
        } else {
            const errorText = getProductErrorMessage(e);
            patchPendingRecovery(recoveryId, {
                status: 'burned',
                state: TRANSFER_STATES.RECOVERABLE,
                errorMessage: errorText,
            });
            log(`Resume transfer paused: ${errorText}`, 'error');
        }
    } finally {
        recoverBurnBtn.disabled = false;
        syncRecoveryActivityCards();
        renderActivity();
        renderPendingRecoveries();
        renderRecoveryBanner();
    }
});

pendingRecoveriesEl?.addEventListener('click', async (event) => {
    const markButton = event.target.closest('[data-mark-recovered-id]');
    if (markButton) {
        const transfer = readPendingRecoveries().find(item => item.id === markButton.dataset.markRecoveredId);
        if (!transfer) return;
        markRecoveryAlreadyMinted(
            transfer.id || transfer.burnTxHash,
            transfer.from || 'solana',
            transfer.to || 'arc',
            transfer,
            transfer.burnTxHash,
        );
        syncRecoveryActivityCards();
        renderActivity();
        renderPendingRecoveries();
        renderRecoveryBanner();
        return;
    }

    const button = event.target.closest('[data-recover-id]');
    if (!button) return;
    const transfer = readPendingRecoveries().find(item => item.id === button.dataset.recoverId);
    if (!transfer) return;
    try {
        sounds.play('warp');
        button.disabled = true;
        await recoverCctpMint(transfer);
    } catch (e) {
        sounds.play('error');
        if (isNonceAlreadyUsedError(e)) {
            markRecoveryAlreadyMinted(transfer.id || transfer.burnTxHash, transfer.from || 'solana', transfer.to || 'arc', transfer, transfer.burnTxHash);
        } else {
            const errorText = getProductErrorMessage(e);
            patchPendingRecovery(transfer.id, {
                status: 'burned',
                state: TRANSFER_STATES.RECOVERABLE,
                errorMessage: errorText,
            });
            log(`Resume transfer paused: ${errorText}`, 'error');
        }
    } finally {
        syncRecoveryActivityCards();
        renderActivity();
        renderPendingRecoveries();
        renderRecoveryBanner();
    }
});

resumeAllRecoveriesBtn?.addEventListener('click', async () => {
    const recoveries = getActionableRecoveries();
    if (recoveries.length === 0) return;
    try {
        sounds.play('warp');
        isResumingRecoveries = true;
        resumeAllRecoveriesBtn.disabled = true;
        log(`Resuming ${recoveries.length} pending CCTP recovery checkpoint${recoveries.length === 1 ? '' : 's'}...`);
        const recovered = await resumeRecoveries(recoveries);
        if (recovered > 0) {
            sounds.play('success');
            log(`Resume all completed ${recovered} recovery mint${recovered === 1 ? '' : 's'}.`, 'success');
        } else {
            log('Resume all finished. No recovery mints were ready yet.', 'loading');
        }
    } catch (e) {
        sounds.play('error');
        log(`Resume all paused: ${getProductErrorMessage(e)}`, 'error');
    } finally {
        syncRecoveryActivityCards();
        renderActivity();
        isResumingRecoveries = false;
        renderPendingRecoveries();
        renderRecoveryBanner();
    }
});

teleportBtn.addEventListener('click', async () => {
    if (teleportBtn.disabled) return;
    const from = originChainSelect.value;
    const to = destinationChainSelect.value;
    const amount = amountInput.value;
    if ((from === 'solana' || to === 'solana') && solanaWalletType === 'phantom') {
        sounds.play('error');
        log(PRODUCT_ERROR_MESSAGES.phantomSourceUnsupported, "error");
        checkReady();
        return;
    }
    
    try {
        sounds.play('warp');
        teleportBtn.disabled = true; teleportBtn.classList.add('loading');
        wormhole.setWarp(true);
        log(`Initiating teleportation sequence: ${from.toUpperCase()} ➔ ${to.toUpperCase()}`);
        
        if (from === 'arc' || from === 'ethereum') await ensureEvmChain(from);
        
        const adapterFrom = from === 'solana' ? solanaAdapter : evmAdapter;
        const useForwarder = FORWARDER_DESTINATIONS.has(to);
        const sourceWallet = from === 'solana' ? solanaAccount : evmAccount;
        const destinationWallet = getDefaultDestinationAddress(to);
        
        const recipient = getDestinationRecipient(to);
        const formattedAmount = parseFloat(amount).toFixed(2);
        const bridgeParams = {
            from: { adapter: adapterFrom, chain: CHAIN_MAPPING[from] },
            to: useForwarder
                ? { chain: CHAIN_MAPPING[to], recipientAddress: recipient, useForwarder: true }
                : { adapter: solanaAdapter, chain: CHAIN_MAPPING[to], recipientAddress: recipient },
            amount: formattedAmount,
            config: { transferSpeed: 'FAST' }
        };

        log(useForwarder
            ? "Quantum tunnel stabilized. Circle Forwarder will complete destination mint..."
            : "Quantum tunnel stabilized. Commencing transfer..."
        );
        activeBridgeContext = {
            id: `${Date.now()}-${from}-${to}`,
            from,
            to,
            amount,
            recipient,
            sourceWallet,
            destinationWallet,
            wallets: [sourceWallet, destinationWallet, recipient].filter(Boolean),
            manualDestinationAddress: getManualDestinationAddress() || null,
            useForwarder,
            sourceDomain: CCTP_DOMAINS[from],
            destinationDomain: CCTP_DOMAINS[to],
            createdAt: new Date().toISOString(),
        };
        upsertTransferRecord({
            ...activeBridgeContext,
            recoveryId: activeBridgeContext.id,
            state: TRANSFER_STATES.CREATED,
        });
        addActivity('Teleport', from, to, amount, 'pending', null, {
            recoveryId: activeBridgeContext.id,
            lifecycleState: TRANSFER_STATES.CREATED,
            lifecycleLabel: getTransferStateLabel(TRANSFER_STATES.CREATED),
        });
        const result = await kit.bridge(bridgeParams);

        if (result.state === 'success') {
            sounds.play('success');
            successOverlay.style.display = 'flex';
            if (activeBridgeContext?.burnTxHash) {
                patchPendingRecovery(activeBridgeContext.burnTxHash, {
                    status: 'minted',
                    state: TRANSFER_STATES.COMPLETED,
                    mintTxHash: result.transactionHash || null,
                    errorMessage: null,
                });
            }
            patchTransferRecord(activeBridgeContext?.id, {
                state: TRANSFER_STATES.COMPLETED,
                mintTxHash: result.transactionHash || null,
                errorMessage: null,
            });
            addActivity('Teleport', from, to, amount, 'success', result.transactionHash, {
                recoveryId: activeBridgeContext?.id,
                burnTxHash: activeBridgeContext?.burnTxHash || null,
                lifecycleState: TRANSFER_STATES.COMPLETED,
                lifecycleLabel: getTransferStateLabel(TRANSFER_STATES.COMPLETED),
            });
        } else {
            const failedStep = result.steps?.find(s => s.state === 'error');
            const stepError = failedStep?.error;
            if (stepError && stepError.cause && stepError.cause.trace) {
                const trace = stepError.cause.trace;
                console.dir(trace);
                const logs = trace.logs || trace.errorDetails?.logs || [];
                const logsStr = Array.isArray(logs) ? logs.join('\n') : String(logs);
                if (logsStr.includes('remote_token_messenger')) console.error("DIAGNOSIS: Destination domain unsupported on Solana Devnet.");
            }
            const productMessage = getProductErrorMessage(stepError || failedStep?.errorMessage || PRODUCT_ERROR_MESSAGES.genericRecoverable);
            const nextState = activeBridgeContext?.burnTxHash ? TRANSFER_STATES.RECOVERABLE : TRANSFER_STATES.FAILED;
            patchTransferRecord(activeBridgeContext?.id, {
                state: nextState,
                errorMessage: productMessage,
            });
            if (activeBridgeContext?.burnTxHash) {
                patchPendingRecovery(activeBridgeContext.burnTxHash, {
                    status: 'burned',
                    state: TRANSFER_STATES.RECOVERABLE,
                    errorMessage: productMessage,
                });
            }
            log(`Teleportation paused: ${productMessage}`, 'error');
            addActivity('Teleport', from, to, amount, 'error', null, {
                recoveryId: activeBridgeContext?.id,
                burnTxHash: activeBridgeContext?.burnTxHash || null,
                lifecycleState: nextState,
                lifecycleLabel: getTransferStateLabel(nextState),
                errorMessage: productMessage,
            });
        }
    } catch (e) {
        sounds.play('error');
        const productMessage = getProductErrorMessage(e);
        const nextState = activeBridgeContext?.burnTxHash ? TRANSFER_STATES.RECOVERABLE : TRANSFER_STATES.FAILED;
        patchTransferRecord(activeBridgeContext?.id, {
            state: nextState,
            errorMessage: productMessage,
        });
        if (activeBridgeContext?.burnTxHash) {
            patchPendingRecovery(activeBridgeContext.burnTxHash, {
                status: 'burned',
                state: TRANSFER_STATES.RECOVERABLE,
                errorMessage: productMessage,
            });
        }
        log(`Teleportation paused: ${productMessage}`, 'error');
        addActivity('Teleport', from, to, amount, 'error', null, {
            recoveryId: activeBridgeContext?.id,
            burnTxHash: activeBridgeContext?.burnTxHash || null,
            lifecycleState: nextState,
            lifecycleLabel: getTransferStateLabel(nextState),
            errorMessage: productMessage,
        });
    } finally {
        teleportBtn.classList.remove('loading');
        wormhole.setWarp(false); updateBalances(); checkReady();
    }
});

function checkReady() {
    const from = originChainSelect.value;
    const to = destinationChainSelect.value;
    const amount = parseFloat(amountInput.value || 0);
    const sourceLinked = from === 'solana' ? Boolean(solanaAdapter && solanaAccount) : Boolean(evmAdapter && evmAccount);
    const useForwarder = FORWARDER_DESTINATIONS.has(to);
    const needsDestinationSolanaSigner = to === 'solana' && !useForwarder;
    const destinationSignerReady = !needsDestinationSolanaSigner || Boolean(solanaAdapter && solanaAccount);
    let destinationReady = false;
    let destinationValid = syncDestinationAddressUI();
    try {
        destinationReady = Boolean(getDestinationRecipient(to));
    } catch {
        destinationReady = false;
    }
    const phantomUnsupportedRoute = (from === 'solana' || to === 'solana') && solanaWalletType === 'phantom';
    teleportBtn.disabled = !sourceLinked || !destinationReady || !destinationValid || !destinationSignerReady || amount <= 0 || from === to || phantomUnsupportedRoute;
    const btnText = teleportBtn.querySelector('.btn-text');
    if (!sourceLinked) {
        btnText.innerText = `Connect ${from === 'solana' ? 'Solana' : 'EVM'} source`;
    } else if (!destinationReady) {
        btnText.innerText = "Add destination wallet";
    } else if (!destinationValid) {
        btnText.innerText = "Check destination address";
    } else if (!destinationSignerReady) {
        btnText.innerText = "Connect Solana to receive";
    } else if (phantomUnsupportedRoute) {
        btnText.innerText = "Use Backpack or Solflare";
    } else {
        btnText.innerText = "Initiate Teleportation";
    }
}

themeToggle.addEventListener('click', () => {
    document.body.classList.toggle('light-theme');
    document.body.classList.toggle('dark-theme');
});

closeOverlayBtn.addEventListener('click', () => {
    successOverlay.style.display = 'none';
    stepper.style.display = 'none';
});

function formatActivityTime(timestamp) {
    if (!timestamp) return 'Unknown';
    return new Date(timestamp).toLocaleString([], {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function getActivityExplorerChain(item) {
    if (!item?.txHash) return item?.from || 'arc';
    if (item.status === 'success' || item.type === 'Recovery') return item.to || item.from || 'arc';
    return item.from || 'arc';
}

function openTransactionDetails(item) {
    if (!txDetailsOverlay || !txDetailsContent || !item) return;
    const from = item.from || 'unknown';
    const to = item.to || 'unknown';
    const status = item.status || 'pending';
    const type = item.type || 'Teleport';
    const amount = item.amount ?? 'unknown';
    const lifecycleState = item.lifecycleState || item.state || (item.alreadyMinted ? TRANSFER_STATES.ALREADY_CLAIMED : null);
    const lifecycleLabel = item.lifecycleLabel || (lifecycleState ? getTransferStateLabel(lifecycleState) : status);
    const explorerChain = getActivityExplorerChain(item);
    const explorerUrl = item.txHash ? getLink(explorerChain, item.txHash) : null;
    const transactionLabel = item.txHash ? shortHash(item.txHash) : (item.alreadyMinted ? 'Already minted' : 'Pending');

    txDetailsContent.innerHTML = `
        <div class="manifest-header">
            <div class="manifest-title">
                <h2>${escapeHtml(type)} Manifest</h2>
                <div class="manifest-id">#${escapeHtml(item.id || 'unknown')}</div>
            </div>
            <div class="manifest-badge ${escapeHtml(status)}">${escapeHtml(status.toUpperCase())}</div>
        </div>
        <div class="detail-path cinematic">
            <div>
                <div class="node-icon-bg ${escapeHtml(from)}"></div>
                <div class="node-name">${escapeHtml(from)}</div>
            </div>
            <div class="path-visual">
                <div class="tunnel-line ${escapeHtml(status)}"></div>
            </div>
            <div>
                <div class="node-icon-bg ${escapeHtml(to)}"></div>
                <div class="node-name">${escapeHtml(to)}</div>
            </div>
        </div>
        <div class="manifest-body">
            <div class="manifest-row">
                <span class="m-label">Amount</span>
                <span class="m-value highlight">${escapeHtml(amount)} USDC</span>
            </div>
            <div class="manifest-row">
                <span class="m-label">Route</span>
                <span class="m-value">${escapeHtml((CHAIN_LABELS[from] || from))} -> ${escapeHtml((CHAIN_LABELS[to] || to))}</span>
            </div>
            <div class="manifest-row">
                <span class="m-label">Started</span>
                <span class="m-value">${escapeHtml(formatActivityTime(item.timestamp))}</span>
            </div>
            <div class="manifest-row">
                <span class="m-label">Status</span>
                <span class="m-value">${escapeHtml(lifecycleLabel)}</span>
            </div>
            <div class="manifest-row">
                <span class="m-label">Transaction</span>
                <span class="m-value">${escapeHtml(transactionLabel)}</span>
            </div>
            ${item.errorMessage ? `
                <div class="manifest-row">
                    <span class="m-label">Message</span>
                    <span class="m-value">${escapeHtml(getProductErrorMessage(item.errorMessage))}</span>
                </div>
            ` : ''}
            ${item.burnTxHash ? `
                <div class="manifest-row">
                    <span class="m-label">Burn transaction</span>
                    <span class="m-value burn-hash-value">
                        ${escapeHtml(shortHash(item.burnTxHash))}
                        <button class="tx-link copy-burn-btn inline-copy" type="button" data-copy-burn="${escapeHtml(item.burnTxHash)}">Copy</button>
                    </span>
                </div>
            ` : ''}
        </div>
        <div class="manifest-actions">
            ${explorerUrl
                ? `<a class="btn btn-primary full-width" href="${explorerUrl}" target="_blank" rel="noopener">Open Explorer</a>`
                : `<button class="btn btn-glass full-width" disabled>${item.alreadyMinted ? 'Mint already completed' : 'No transaction hash yet'}</button>`}
        </div>
    `;
    txDetailsOverlay.style.display = 'flex';
    document.body.classList.add('modal-open');
}

function closeTransactionDetails() {
    if (!txDetailsOverlay) return;
    txDetailsOverlay.style.display = 'none';
    document.body.classList.remove('modal-open');
}

closeTxDetailsBtn?.addEventListener('click', closeTransactionDetails);
txDetailsOverlay?.addEventListener('click', async (event) => {
    const copyButton = event.target.closest('[data-copy-burn]');
    if (copyButton) {
        event.preventDefault();
        event.stopPropagation();
        await copyToClipboard(copyButton.dataset.copyBurn, 'burn tx');
        return;
    }
    if (event.target === txDetailsOverlay) closeTransactionDetails();
});
window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && txDetailsOverlay?.style.display === 'flex') closeTransactionDetails();
});

function saveActivity() { renderActivity(); }
function syncRecoveryActivityCards() {
    let changed = false;
    for (const recovery of readPendingRecoveries()) {
        if (!recovery.burnTxHash) continue;
        const lifecycleState = stateFromRecoveryStatus(recovery);
        const lifecycleLabel = getTransferStateLabel(lifecycleState);
        const existingIndex = activityHistory.findIndex(item =>
            item.recoveryId === recovery.id || item.burnTxHash === recovery.burnTxHash
        );
        const status = getTransferStatusBucket(lifecycleState);
        if (existingIndex === -1) {
            activityHistory.unshift({
                id: `recovery-${recovery.id || recovery.burnTxHash}`,
                timestamp: recovery.createdAt || new Date().toISOString(),
                updatedAt: recovery.updatedAt || new Date().toISOString(),
                type: 'Recovery',
                from: recovery.from,
                to: recovery.to,
                amount: recovery.amount || 'unknown',
                status,
                txHash: recovery.mintTxHash || null,
                burnTxHash: recovery.burnTxHash,
                recoveryId: recovery.id || recovery.burnTxHash,
                alreadyMinted: Boolean(recovery.alreadyMinted),
                lifecycleState,
                lifecycleLabel,
                errorMessage: recovery.errorMessage || null,
            });
            changed = true;
        } else if (
            !activityHistory[existingIndex].burnTxHash ||
            activityHistory[existingIndex].status === 'pending' ||
            activityHistory[existingIndex].status === 'error' ||
            activityHistory[existingIndex].lifecycleState !== lifecycleState ||
            recovery.status === 'minted'
        ) {
            activityHistory[existingIndex] = {
                ...activityHistory[existingIndex],
                status,
                txHash: recovery.mintTxHash || activityHistory[existingIndex].txHash || null,
                burnTxHash: recovery.burnTxHash,
                recoveryId: recovery.id || activityHistory[existingIndex].recoveryId || recovery.burnTxHash,
                alreadyMinted: Boolean(recovery.alreadyMinted || activityHistory[existingIndex].alreadyMinted),
                lifecycleState,
                lifecycleLabel,
                errorMessage: recovery.errorMessage || activityHistory[existingIndex].errorMessage || null,
                updatedAt: recovery.updatedAt || new Date().toISOString(),
            };
            changed = true;
        }
    }
    if (changed) saveActivity();
}

function addActivity(type, from, to, amount, status, txHash = null, extra = {}) {
    const existingIndex = activityHistory.findIndex(a => {
        if (extra.recoveryId && a.recoveryId === extra.recoveryId) return true;
        return a.status === 'pending' && a.type === type && a.amount === amount && a.from === from && a.to === to;
    });
    const nextValues = {
        ...extra,
        type,
        from,
        to,
        amount,
        status,
        txHash: txHash || extra.txHash || null,
        updatedAt: new Date().toISOString(),
    };

    if (existingIndex !== -1) {
        activityHistory[existingIndex] = {
            ...activityHistory[existingIndex],
            ...nextValues,
            txHash: txHash || extra.txHash || activityHistory[existingIndex].txHash || null,
            burnTxHash: extra.burnTxHash || activityHistory[existingIndex].burnTxHash || null,
        };
    } else {
        activityHistory.unshift({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            ...nextValues,
            burnTxHash: extra.burnTxHash || null,
        });
    }
    saveActivity();
}

function renderActivity() {
    const list = document.getElementById('activity-list');
    if (!list) return;
    if (activityHistory.length === 0) {
        list.innerHTML = '<div class="empty-state">No recent activity detected.</div>';
        return;
    }
    list.innerHTML = activityHistory.map(item => {
        const lifecycleState = item.lifecycleState || item.state || (item.alreadyMinted ? TRANSFER_STATES.ALREADY_CLAIMED : null);
        const lifecycleLabel = item.lifecycleLabel || (lifecycleState ? getTransferStateLabel(lifecycleState) : (item.status || 'pending'));
        return `
            <div class="activity-item" data-activity-id="${escapeHtml(item.id)}" role="button" tabindex="0" aria-label="View ${escapeHtml(item.type || 'transaction')} details">
                <div class="activity-badge ${escapeHtml(item.status || 'pending')}">${escapeHtml((item.type || 'T').slice(0, 1).toUpperCase())}</div>
                <div class="activity-info">
                    <h4>${escapeHtml((item.from || '').toUpperCase())} -> ${escapeHtml((item.to || '').toUpperCase())}</h4>
                    <p>${escapeHtml(item.amount)} USDC • <span class="status-pill ${escapeHtml(item.status || 'pending')}">${escapeHtml(lifecycleLabel)}</span></p>
                </div>
                <div class="activity-action">
                    ${item.burnTxHash
                        ? `<button class="tx-link copy-burn-btn" type="button" data-copy-burn="${escapeHtml(item.burnTxHash)}">Copy burn tx</button>`
                        : ''}
                    ${item.txHash
                        ? `<a class="tx-link" href="${getLink(getActivityExplorerChain(item), item.txHash)}" target="_blank" rel="noopener">Explorer</a>`
                        : `<span class="tx-link">${item.alreadyMinted ? 'Completed' : 'Details'}</span>`}
                </div>
            </div>
        `;
    }).join('');
}

document.getElementById('activity-list')?.addEventListener('click', async (event) => {
    const copyButton = event.target.closest('[data-copy-burn]');
    if (copyButton) {
        event.preventDefault();
        event.stopPropagation();
        await copyToClipboard(copyButton.dataset.copyBurn, 'burn tx');
        return;
    }
    if (event.target.closest('a')) return;
    const itemEl = event.target.closest('.activity-item[data-activity-id]');
    if (!itemEl) return;
    const item = activityHistory.find(entry => String(entry.id) === itemEl.dataset.activityId);
    openTransactionDetails(item);
});

document.getElementById('activity-list')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest('button, a')) return;
    const itemEl = event.target.closest('.activity-item[data-activity-id]');
    if (!itemEl) return;
    event.preventDefault();
    const item = activityHistory.find(entry => String(entry.id) === itemEl.dataset.activityId);
    openTransactionDetails(item);
});
clearLegacyTransferBrowserStorage();
unlockInterruptedRecoveries();
normalizeAlreadyClaimedRecoveries();
migrateRecoveriesToTransferLedger();
syncRecoveryActivityCards();
renderActivity();
syncRecoveryRouteControls();
syncDestinationAddressUI();
if (forwardingNotice && destinationChainSelect) {
    forwardingNotice.style.display = FORWARDER_DESTINATIONS.has(destinationChainSelect.value) ? 'flex' : 'none';
}
renderPendingRecoveries();
renderRecoveryBanner();

document.getElementById('clear-activity').addEventListener('click', () => { activityHistory = []; saveActivity(); });

log("QuantumBridge Core Systems Online.");
log("Awaiting Fleet Connection...");
const startupRecoveries = getActionableRecoveries();
if (startupRecoveries.length > 0) {
    log(`${startupRecoveries.length} pending CCTP recovery checkpoint${startupRecoveries.length === 1 ? '' : 's'} detected. Use Resume all when wallets are connected.`, 'loading');
}
syncServerTransfersForConnectedWallets();
scheduleWalletSessionRestore();
window.addEventListener('load', scheduleWalletSessionRestore);
