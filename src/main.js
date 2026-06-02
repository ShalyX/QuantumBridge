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
let globalActivityHistory = [];
let walletViewGeneration = 0;

kit.on('*', async (event) => {
    console.log("[QuantumBridge Event]", summarizeBridgeEventForConsole(event));
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
            sourceWallet: activeBridgeContext.sourceWallet,
            destinationWallet: activeBridgeContext.destinationWallet,
            recipient: activeBridgeContext.recipient,
            wallets: activeBridgeContext.wallets,
            useForwarder: activeBridgeContext.useForwarder,
            lifecycleState: TRANSFER_STATES.BURN_SUBMITTED,
            lifecycleLabel: getTransferStateLabel(TRANSFER_STATES.BURN_SUBMITTED),
        });
        log(`Recovery checkpoint saved for burn ${shortHash(txHash)}.`, 'success');
        if (activeBridgeContext.useForwarder) {
            log('Burn confirmed. Waiting for Circle attestation and Forwarder mint on the destination chain...', 'loading');
        }
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
            recordTransferFailure(activeBridgeContext.id, {
                stage: methodName || 'bridge.event',
                route: `${activeBridgeContext.from}->${activeBridgeContext.to}`,
                state: nextState,
                burnTxHash: activeBridgeContext.burnTxHash || null,
                productMessage,
                error: step?.error || step?.errorMessage || step,
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
let currentActivitySearch = '';
let currentActivityScope = 'global';

// DOM Elements
const connectEvmBtn = document.getElementById('connect-evm');
const connectSolanaBtn = document.getElementById('connect-solana');
const disconnectEvmBtn = document.getElementById('disconnect-evm');
const disconnectSolanaBtn = document.getElementById('disconnect-solana');
const teleportBtn = document.getElementById('teleport-btn');
const amountInput = document.getElementById('amount');
const destinationAddressInput = document.getElementById('destination-address');
const destinationAddressContainer = document.querySelector('.destination-address-container');
const destinationAddressHint = document.getElementById('destination-address-hint');
const originChainSelect = document.getElementById('origin-chain');
const destinationChainSelect = document.getElementById('destination-chain');
const consoleLogs = document.getElementById('console-logs');
const statusConsole = document.querySelector('.status-console');
const toggleConsoleBtn = document.getElementById('toggle-console');
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
const confidenceScoreEl = document.getElementById('confidence-score');
const estArrivalEl = document.getElementById('est-arrival');
const routeHealthPill = document.getElementById('route-health-pill');
const activityFilterBtns = Array.from(document.querySelectorAll('.filter-btn[data-filter]'));
const activityScopeBtns = Array.from(document.querySelectorAll('[data-activity-scope]'));
const chainFilterSelect = document.getElementById('chain-filter');
const activitySearchInput = document.getElementById('activity-search');
const clearActivityBtn = document.getElementById('clear-activity');
const productTabs = Array.from(document.querySelectorAll('[data-app-tab]'));
const productPanels = Array.from(document.querySelectorAll('[data-tab-panel]'));
const tabSwitchers = Array.from(document.querySelectorAll('[data-switch-tab]'));
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


function setAppTab(tab) {
    productTabs.forEach(btn => {
        const active = btn.getAttribute('data-app-tab') === tab;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    productPanels.forEach(panel => {
        const active = panel.getAttribute('data-tab-panel') === tab;
        panel.classList.toggle('active', active);
        panel.hidden = !active;
    });
}

function syncBodyScrollLock() {
    const overlaysOpen = [quantumWalletModal, txDetailsOverlay, successOverlay]
        .some(overlay => overlay?.style.display === 'flex');
    document.body.classList.toggle('modal-open', overlaysOpen);
}

productTabs.forEach(btn => {
    btn.addEventListener('click', () => {
        sounds.play('click');
        setAppTab(btn.getAttribute('data-app-tab'));
    });
});

tabSwitchers.forEach(btn => {
    btn.addEventListener('click', () => {
        sounds.play('click');
        setAppTab(btn.getAttribute('data-switch-tab'));
    });
});

function setConsoleCollapsed(collapsed) {
    if (!statusConsole || !toggleConsoleBtn || !consoleLogs) return;
    statusConsole.classList.toggle('collapsed', collapsed);
    toggleConsoleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggleConsoleBtn.title = collapsed ? 'Expand teleportation status' : 'Collapse teleportation status';
    if (collapsed) {
        consoleLogs.setAttribute('aria-hidden', 'true');
    } else {
        consoleLogs.removeAttribute('aria-hidden');
        requestAnimationFrame(() => {
            consoleLogs.scrollTop = consoleLogs.scrollHeight;
        });
    }
}

toggleConsoleBtn?.addEventListener('click', () => {
    sounds.play('click');
    setConsoleCollapsed(!statusConsole?.classList.contains('collapsed'));
});

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

const ROUTE_BASE_ESTIMATE_SECONDS = Object.freeze({
    'arc:solana': 22,
    'solana:arc': 28,
    'ethereum:arc': 16,
    'arc:ethereum': 16,
    'ethereum:solana': 24,
    'solana:ethereum': 30,
});

const NETWORK_HEALTH_PROFILES = Object.freeze({
    stable: { label: 'Stable', multiplier: 1 },
    busy: { label: 'Busy', multiplier: 1.45 },
    congested: { label: 'Congested', multiplier: 2.25 },
});

const PRODUCT_ERROR_MESSAGES = Object.freeze({
    alreadyClaimed: 'This burn was already claimed.',
    attestationPending: 'Circle attestation is not ready yet.',
    solanaRecoveryWallet: 'Connect Solflare or Backpack to complete this route.',
    phantomSourceUnsupported: 'Phantom is limited for this CCTP route. Connect Backpack or Solflare to complete it.',
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
    forwarderFeeTooHigh: 'This transfer is below the current Circle Forwarder fee for this route. Increase the amount and try again.',
    solanaAtaCreation: 'Solana token account setup failed. Use Backpack or Solflare, or paste a Solana destination that already has a devnet USDC token account.',
    solanaMintPaused: 'Solana mint could not complete. Your burn is saved; open Recovery and resume this transfer with Backpack or Solflare.',
    solanaBlockhashExpired: 'Solana mint transaction expired before submission. Your burn is saved; open Recovery and resume this transfer to submit a fresh mint.',
    simulationFailed: 'The destination chain rejected this mint. Try Resume transfer again, or use a supported wallet for this route.',
    appAssetUnavailable: 'App update asset failed to load. Refresh once and retry; your transfer will remain recoverable if the burn already happened.',
    genericRecoverable: 'Transfer paused. Resume it from the recovery panel when wallets are connected.',
});

const pendingTransferSyncs = new Map();
let transferSyncTimer = null;
let etaTimer = null;
let activeEtaRoute = null;
let etaRefreshSequence = 0;
let routeHealthState = {
    status: 'stable',
    label: NETWORK_HEALTH_PROFILES.stable.label,
    multiplier: NETWORK_HEALTH_PROFILES.stable.multiplier,
    latencyMs: null,
    checkedAt: null,
};

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

function safeTelemetryValue(value, seen = new WeakSet(), depth = 0) {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
    if (typeof value === 'bigint') return value.toString();
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
        };
    }
    if (seen.has(value)) return '[Circular]';
    if (depth > 6) return '[MaxDepth]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 50).map(item => safeTelemetryValue(item, seen, depth + 1));
    return Object.fromEntries(
        Object.entries(value).slice(0, 80).map(([key, item]) => [key, safeTelemetryValue(item, seen, depth + 1)]),
    );
}

function getErrorCodeSummary(error) {
    return error?.code ||
        error?.context?.__code ||
        error?.cause?.code ||
        error?.cause?.context?.__code ||
        error?.cause?.cause?.context?.__code ||
        null;
}

function summarizeBridgeEventForConsole(event) {
    const values = event?.values || {};
    const error = values.error || values.errorMessage || null;
    return {
        protocol: event?.protocol || null,
        version: event?.version || null,
        traceId: event?.traceId || null,
        method: event?.method || null,
        values: {
            name: values.name || null,
            state: values.state || null,
            txHash: values.txHash ? shortHash(values.txHash) : null,
            forwarded: Boolean(values.forwarded),
            error: error ? {
                productMessage: getProductErrorMessage(error),
                name: error?.name || null,
                code: getErrorCodeSummary(error),
            } : null,
        },
    };
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

function forgetWalletSessionPart(part) {
    const session = readWalletSession();
    if (!session[part]) return;
    delete session[part];
    const hasWalletSession = Boolean(session.evm || session.solana);
    if (!hasWalletSession) {
        clearWalletSession();
        return;
    }
    session.updatedAt = nowIso();
    localStorage.setItem(WALLET_SESSION_STORAGE_KEY, JSON.stringify(session));
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

function buildTransferEventContext(record = activeBridgeContext) {
    if (!record?.id) return null;
    const from = record.from || record.fromChain || null;
    const to = record.to || record.toChain || null;
    const sourceWallet = record.sourceWallet || (from === 'solana' ? solanaAccount : evmAccount) || null;
    const destinationWallet = record.destinationWallet || (to === 'solana' ? solanaAccount : evmAccount) || null;
    return {
        id: record.id,
        recoveryId: record.recoveryId || record.id,
        from,
        to,
        amount: record.amount || null,
        recipient: record.recipient || null,
        sourceWallet,
        destinationWallet,
        wallets: Array.from(new Set([
            sourceWallet,
            destinationWallet,
            record.recipient,
            ...(Array.isArray(record.wallets) ? record.wallets : []),
        ].filter(Boolean).map(String))),
        sourceDomain: record.sourceDomain ?? CCTP_DOMAINS[from],
        destinationDomain: record.destinationDomain ?? CCTP_DOMAINS[to],
        burnTxHash: record.burnTxHash || null,
        mintTxHash: record.mintTxHash || null,
        state: record.state || null,
        useForwarder: Boolean(record.useForwarder),
        createdAt: record.createdAt || null,
        manualDestinationAddress: record.manualDestinationAddress || null,
    };
}

function queueTransferSync(record) {
    if (!record?.id) return;
    pendingTransferSyncs.set(record.id, normalizeBackendTransferPayload(record));
    if (transferSyncTimer) return;
    transferSyncTimer = window.setTimeout(() => {
        flushQueuedTransferSyncs();
    }, 0);
}

async function flushQueuedTransferSyncs({ useBeacon = false } = {}) {
    if (transferSyncTimer) {
        window.clearTimeout(transferSyncTimer);
        transferSyncTimer = null;
    }
    const queued = Array.from(pendingTransferSyncs.values());
    pendingTransferSyncs.clear();
    if (queued.length === 0) return;

    if (useBeacon && navigator.sendBeacon) {
        for (const payload of queued) {
            const body = new Blob([JSON.stringify(payload)], { type: 'application/json' });
            navigator.sendBeacon(transferApiUrl('/api/transfers'), body);
        }
        return;
    }

    await Promise.allSettled(queued.map(payload => syncTransferToBackend(payload, 'upsert')));
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
        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(`Transfer API ${response.status}${errorText ? `: ${errorText.slice(0, 300)}` : ''}`);
        }
    } catch (error) {
        console.warn('[QuantumBridge] Transfer API sync failed; local cache remains active.', error);
    }
}

async function recordTransferEvent(transferId, type, payload = {}) {
    if (!transferId) return;
    try {
        await flushQueuedTransferSyncs();
        const safePayload = safeTelemetryValue(payload);
        const transferContext = activeBridgeContext?.id === transferId
            ? buildTransferEventContext(activeBridgeContext)
            : (payload.transferContext || null);
        const enrichedPayload = {
            ...(safePayload && typeof safePayload === 'object' && !Array.isArray(safePayload) ? safePayload : { value: safePayload }),
            transferContext,
        };
        let response = await fetch(transferApiUrl(`/api/transfers/${encodeURIComponent(transferId)}/events`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, payload: enrichedPayload }),
        });
        if (response.status === 404 && activeBridgeContext?.id === transferId) {
            await syncTransferToBackend(activeBridgeContext, 'upsert');
            response = await fetch(transferApiUrl(`/api/transfers/${encodeURIComponent(transferId)}/events`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, payload: enrichedPayload }),
            });
        }
        if (!response.ok) throw new Error(`Transfer event API ${response.status}`);
    } catch (error) {
        console.warn('[QuantumBridge] Transfer event sync failed.', error);
    }
}

function serializeFailureForTelemetry(error, fallbackMessage = '') {
    const rawMessage = getErrorText(error) || fallbackMessage || '';
    return {
        productMessage: getProductErrorMessage(error || fallbackMessage),
        rawMessage: rawMessage.slice(0, 2000),
        name: error?.name || null,
        code: error?.code || error?.cause?.code || null,
        type: error?.type || null,
        recoverability: error?.recoverability || null,
        stack: typeof error?.stack === 'string' ? error.stack.slice(0, 2500) : null,
    };
}

function recordTransferFailure(transferId, details = {}) {
    if (!transferId) return;
    const errorDetails = serializeFailureForTelemetry(details.error, details.productMessage);
    recordTransferEvent(transferId, 'transfer.failed', {
        stage: details.stage || 'unknown',
        route: details.route || null,
        state: details.state || null,
        burnTxHash: details.burnTxHash || null,
        mintTxHash: details.mintTxHash || null,
        walletType: solanaWalletType || null,
        sourceWallet: details.sourceWallet || activeBridgeContext?.sourceWallet || null,
        destinationWallet: details.destinationWallet || activeBridgeContext?.destinationWallet || null,
        error: errorDetails,
        capturedAt: nowIso(),
    });
}

function transferToActivity(transfer, { type = 'Teleport' } = {}) {
    if (!transfer) return null;
    const lifecycleState = transfer.state || (transfer.alreadyMinted ? TRANSFER_STATES.ALREADY_CLAIMED : TRANSFER_STATES.CREATED);
    const id = transfer.id || transfer.recoveryId || transfer.burnTxHash || transfer.mintTxHash;
    return {
        id: id || `${transfer.from || 'unknown'}-${transfer.to || 'unknown'}-${transfer.updatedAt || transfer.createdAt || nowIso()}`,
        recoveryId: transfer.recoveryId || transfer.id || transfer.burnTxHash || null,
        timestamp: transfer.createdAt || transfer.updatedAt || nowIso(),
        updatedAt: transfer.updatedAt || transfer.createdAt || nowIso(),
        type,
        from: transfer.from,
        to: transfer.to,
        amount: transfer.amount || 'unknown',
        status: getTransferStatusBucket(lifecycleState),
        txHash: transfer.mintTxHash || null,
        mintTxHash: transfer.mintTxHash || null,
        burnTxHash: transfer.burnTxHash || null,
        sourceWallet: transfer.sourceWallet || null,
        destinationWallet: transfer.destinationWallet || null,
        recipient: transfer.recipient || null,
        wallets: Array.isArray(transfer.wallets) ? transfer.wallets : [],
        alreadyMinted: Boolean(transfer.alreadyMinted),
        lifecycleState,
        lifecycleLabel: getTransferStateLabel(lifecycleState),
        errorMessage: transfer.errorMessage || null,
        useForwarder: Boolean(transfer.useForwarder),
        lastCheckedAt: transfer.lastCheckedAt || null,
        metadata: transfer.metadata || {},
    };
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
                id: transfer.id || transfer.recoveryId || transfer.burnTxHash,
                recoveryId: transfer.recoveryId || transfer.id,
                burnTxHash: transfer.burnTxHash || null,
                sourceWallet: transfer.sourceWallet || null,
                destinationWallet: transfer.destinationWallet || null,
                recipient: transfer.recipient || null,
                wallets: transfer.wallets || [],
                alreadyMinted: Boolean(transfer.alreadyMinted),
                useForwarder: Boolean(transfer.useForwarder),
                lifecycleState: transfer.state,
                lifecycleLabel: getTransferStateLabel(transfer.state),
                errorMessage: transfer.errorMessage || null,
                timestamp: transfer.createdAt || transfer.updatedAt || nowIso(),
                updatedAt: transfer.updatedAt || transfer.createdAt || nowIso(),
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
    if (wallets.length === 0) {
        if (currentActivityScope === 'mine') renderActivity();
        return;
    }
    const viewGeneration = walletViewGeneration;
    try {
        const results = await Promise.all(wallets.map(async wallet => {
            const response = await fetch(transferApiUrl(`/api/transfers?wallet=${encodeURIComponent(wallet)}`), {
                cache: 'no-store',
            });
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
        if (transfersById.size > 0) {
            log(`Loaded ${transfersById.size} transfer${transfersById.size === 1 ? '' : 's'} from recovery history.`, 'success');
        }
    } catch (error) {
        console.warn('[QuantumBridge] Could not load backend transfers; local cache remains active.', error);
    }
}

async function syncGlobalTransfers() {
    try {
        const response = await fetch(transferApiUrl('/api/transfers?scope=global&limit=100'), {
            cache: 'no-store',
        });
        if (!response.ok) throw new Error(`Transfer API ${response.status}`);
        const result = await response.json();
        globalActivityHistory = (result.transfers || [])
            .filter(transfer => transfer.from && transfer.to)
            .map(transfer => transferToActivity(transfer, { type: 'Teleport' }))
            .filter(Boolean);
        if (currentActivityScope === 'global') renderActivity();
    } catch (error) {
        console.warn('[QuantumBridge] Could not load global transfer feed.', error);
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

function isSolanaPreflightOrDecoderError(text) {
    const lower = String(text || '').toLowerCase();
    return lower.includes('unknown blockchain error on solana') && (
        lower.includes('solana error #-32002') ||
        lower.includes('solanaerror -32002') ||
        lower.includes('7050008') ||
        lower.includes('decode this error by running') ||
        lower.includes('__code=-32002')
    );
}

function isSolanaBlockhashExpiredError(error) {
    const lower = getErrorText(error).toLowerCase();
    return lower.includes('blockhash not found') || lower.includes('7050008');
}

function getProductErrorMessage(error) {
    const text = getErrorText(error) || String(error?.message || error || '');
    const lower = text.toLowerCase();

    if (isNonceAlreadyUsedError(error)) return PRODUCT_ERROR_MESSAGES.alreadyClaimed;
    if (isSolanaBlockhashExpiredError(error)) return PRODUCT_ERROR_MESSAGES.solanaBlockhashExpired;
    if (isSolanaPreflightOrDecoderError(text)) return PRODUCT_ERROR_MESSAGES.solanaMintPaused;
    if (
        lower.includes('maxfeemustbelessthanamount') ||
        lower.includes('max fee must be less than amount') ||
        lower.includes('below the current circle forwarder fee') ||
        lower.includes('forwarder fee')
    ) {
        if (lower.includes('current estimated route fee')) return text;
        return PRODUCT_ERROR_MESSAGES.forwarderFeeTooHigh;
    }
    if (lower.includes('attestation is still pending') || lower.includes('not ready yet') || lower.includes('has not indexed')) {
        return lower.includes('indexed') ? PRODUCT_ERROR_MESSAGES.circleIndexing : PRODUCT_ERROR_MESSAGES.attestationPending;
    }
    if (lower.includes('messageexpired') || (lower.includes('message') && lower.includes('expired')) || lower.includes('re-attest')) {
        return PRODUCT_ERROR_MESSAGES.attestationExpired;
    }
    if (lower.includes('failed to fetch dynamically imported module') || lower.includes('/assets/ccip-')) {
        return PRODUCT_ERROR_MESSAGES.appAssetUnavailable;
    }
    if (lower.includes('looks like an evm transaction hash')) return PRODUCT_ERROR_MESSAGES.solanaHashMismatch;
    if (lower.includes('looks like a solana signature')) return PRODUCT_ERROR_MESSAGES.evmHashMismatch;
    if (lower.includes('no cctp message')) return PRODUCT_ERROR_MESSAGES.noCctpMessage;
    if (
        lower.includes('failed to create ata') ||
        lower.includes('ata creation failed') ||
        lower.includes('can not add signature') ||
        lower.includes('not required to sign this transaction')
    ) {
        return PRODUCT_ERROR_MESSAGES.solanaAtaCreation;
    }
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

function parseUsdcMinorUnits(value) {
    const raw = String(value || '').trim();
    if (!/^\d+(\.\d{0,6})?$/.test(raw)) throw new Error('Enter a valid USDC amount.');
    const [whole, fraction = ''] = raw.split('.');
    return BigInt(whole || '0') * 1000000n + BigInt(fraction.padEnd(6, '0').slice(0, 6) || '0');
}

function formatUsdcMinorUnits(value) {
    const units = BigInt(value || 0);
    const whole = units / 1000000n;
    const fraction = String(units % 1000000n).padStart(6, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : `${whole}`;
}

async function fetchForwarderFeeMinorUnits(sourceDomain, destinationDomain) {
    const response = await fetch(`${IRIS_API}/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}?forward=true`);
    if (!response.ok) throw new Error(`Circle Forwarder fee lookup failed (${response.status})`);
    const feeTiers = await response.json();
    const fastTier = Array.isArray(feeTiers)
        ? feeTiers.find(tier => Number(tier.finalityThreshold) === 1000) || feeTiers[0]
        : null;
    const fee = fastTier?.forwardFee?.high ?? fastTier?.forwardFee?.med ?? fastTier?.forwardFee?.low;
    if (fee === undefined || fee === null) throw new Error('Circle Forwarder fee is unavailable for this route.');
    return BigInt(String(fee));
}

async function assertForwarderAmountCoversFee({ from, to, amount }) {
    const sourceDomain = CCTP_DOMAINS[from];
    const destinationDomain = CCTP_DOMAINS[to];
    if (sourceDomain === undefined || destinationDomain === undefined) return null;

    const [amountMinor, forwarderFeeMinor] = await Promise.all([
        Promise.resolve(parseUsdcMinorUnits(amount)),
        fetchForwarderFeeMinorUnits(sourceDomain, destinationDomain),
    ]);
    if (amountMinor <= forwarderFeeMinor) {
        const minimumMinor = forwarderFeeMinor + 1n;
        throw new Error(
            `${PRODUCT_ERROR_MESSAGES.forwarderFeeTooHigh} Current estimated route fee is ${formatUsdcMinorUnits(forwarderFeeMinor)} USDC; send more than ${formatUsdcMinorUnits(minimumMinor)} USDC.`,
        );
    }
    return forwarderFeeMinor;
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

function getRouteBaseEstimateSeconds(from = originChainSelect?.value, to = destinationChainSelect?.value) {
    const routeKey = `${from}:${to}`;
    if (ROUTE_BASE_ESTIMATE_SECONDS[routeKey]) return ROUTE_BASE_ESTIMATE_SECONDS[routeKey];
    if (from === 'solana' || to === 'solana') return 28;
    return FORWARDER_DESTINATIONS.has(to) ? 18 : 14;
}

function getRouteEstimateRange(from = originChainSelect?.value, to = destinationChainSelect?.value) {
    const base = getRouteBaseEstimateSeconds(from, to);
    const multiplier = routeHealthState.multiplier || 1;
    const low = Math.max(8, Math.ceil(base * multiplier));
    const high = Math.max(low + 4, Math.ceil(low * 1.35));
    return { low, high };
}

function setEstimatedArrivalText(text) {
    if (estArrivalEl) estArrivalEl.textContent = text;
}

function setRouteHealthUi() {
    if (confidenceScoreEl) {
        confidenceScoreEl.textContent = routeHealthState.latencyMs === null
            ? routeHealthState.label
            : `${routeHealthState.latencyMs}ms`;
    }
    if (routeHealthPill) {
        routeHealthPill.className = `health-pill ${routeHealthState.status}`;
        routeHealthPill.textContent = routeHealthState.label;
    }
}

function updateEstimatedArrival() {
    if (!estArrivalEl) return;
    const route = activeEtaRoute || {
        from: originChainSelect?.value || 'arc',
        to: destinationChainSelect?.value || 'solana',
    };
    const { low, high } = getRouteEstimateRange(route.from, route.to);
    setRouteHealthUi();
    setEstimatedArrivalText(`~${low}-${high}s`);
}

function routeHealthFromLatency(latencyMs, failedCount = 0) {
    if (failedCount > 0 || latencyMs > 4000) return { status: 'congested', ...NETWORK_HEALTH_PROFILES.congested };
    if (latencyMs > 1800) return { status: 'busy', ...NETWORK_HEALTH_PROFILES.busy };
    return { status: 'stable', ...NETWORK_HEALTH_PROFILES.stable };
}

async function probeChainLatency(chainKey) {
    const startedAt = performance.now();
    await getDestinationProgressBlock(chainKey);
    return Math.round(performance.now() - startedAt);
}

async function refreshRouteHealth(from, to, sequence) {
    const probes = await Promise.allSettled([from, to].map(chain => probeChainLatency(chain)));
    if (sequence !== etaRefreshSequence) return;
    const latencies = probes
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value);
    const failedCount = probes.filter(result => result.status === 'rejected').length;
    const latencyMs = latencies.length > 0 ? Math.max(...latencies) : 5000;
    routeHealthState = {
        ...routeHealthFromLatency(latencyMs, failedCount),
        latencyMs,
        checkedAt: nowIso(),
    };
    updateEstimatedArrival();
}

function startEstimatedArrivalMonitor(from = originChainSelect?.value, to = destinationChainSelect?.value) {
    activeEtaRoute = { from, to };
    if (etaTimer) window.clearInterval(etaTimer);
    const sequence = ++etaRefreshSequence;
    updateEstimatedArrival();
    refreshRouteHealth(from, to, sequence).catch(error => {
        console.warn('[QuantumBridge] Route health probe failed.', error);
    });
    etaTimer = window.setInterval(() => {
        const route = activeEtaRoute || {
            from: originChainSelect?.value || from,
            to: destinationChainSelect?.value || to,
        };
        refreshRouteHealth(route.from, route.to, sequence).catch(error => {
            console.warn('[QuantumBridge] Route health probe failed.', error);
        });
    }, 15000);
}

function finishEstimatedArrival(label = null) {
    if (etaTimer) window.clearInterval(etaTimer);
    etaTimer = null;
    etaRefreshSequence += 1;
    if (label) setEstimatedArrivalText(label);
    window.setTimeout(() => {
        startEstimatedArrivalMonitor(originChainSelect?.value, destinationChainSelect?.value);
    }, label ? 5000 : 0);
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
        pendingRecoveriesEl.classList.add('empty-recovery-list');
        pendingRecoveriesEl.innerHTML = `
            <div class="recovery-empty recovery-empty-card">
                <strong>No transfers waiting</strong>
                <span>Paste a burn transaction above or connect wallets to load recoverable transfers.</span>
            </div>
        `;
        return;
    }

    pendingRecoveriesEl.classList.remove('empty-recovery-list');
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

function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

function getTransferSnapshot(transferId) {
    if (activeBridgeContext?.id === transferId) return activeBridgeContext;
    return readTransferLedger().find(item => item.id === transferId || item.recoveryId === transferId) || null;
}

function isForwarderConfirmedMessage(message) {
    const forwardState = String(message?.forwardState || '').toUpperCase();
    return Boolean(message?.forwardTxHash) || forwardState === 'CONFIRMED';
}

async function waitForForwarderCompletion(transferId, { timeoutMs = 8 * 60 * 1000, intervalMs = 2500 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const snapshot = getTransferSnapshot(transferId);
        if (!snapshot?.burnTxHash || snapshot.sourceDomain === undefined || snapshot.sourceDomain === null) {
            await sleep(500);
            continue;
        }
        try {
            const attestationData = await fetchCctpAttestation(snapshot.sourceDomain, snapshot.burnTxHash);
            const message = attestationData.raw || {};
            if (isForwarderConfirmedMessage(message)) {
                return {
                    state: 'success',
                    transactionHash: message.forwardTxHash || snapshot.mintTxHash || null,
                    forwarderFastConfirmed: true,
                };
            }
        } catch (error) {
            const text = getErrorText(error).toLowerCase();
            if (!text.includes('indexed') && !text.includes('not ready') && !text.includes('pending')) {
                console.warn('[QuantumBridge] Forwarder completion poll skipped once.', error);
            }
        }
        await sleep(intervalMs);
    }
    throw new Error('Forwarder completion watcher timed out');
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
                recordTransferFailure(transfer.id || transfer.burnTxHash, {
                    stage: 'recovery.resume',
                    route: `${transfer.from || 'unknown'}->${transfer.to || 'unknown'}`,
                    state: TRANSFER_STATES.RECOVERABLE,
                    burnTxHash: transfer.burnTxHash,
                    productMessage: errorText,
                    error: e,
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

const SOLANA_WALLET_CATALOG = Object.freeze([
    {
        walletType: 'phantom',
        name: 'Phantom',
        supportLabel: 'Limited for CCTP routes',
        supportClass: 'limited',
        optionClass: 'limited',
    },
    {
        walletType: 'backpack',
        name: 'Backpack',
        supportLabel: 'Supported',
        supportClass: 'supported',
    },
    {
        walletType: 'solflare',
        name: 'Solflare',
        supportLabel: 'Supported',
        supportClass: 'supported',
    },
    {
        walletType: 'zerion',
        name: 'Zerion',
        supportLabel: 'Wallet dependent',
        supportClass: 'experimental',
    },
]);

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

function getWalletStandardWallets() {
    const walletSources = [
        window.navigator?.wallets,
        window.wallets,
    ].filter(Boolean);

    for (const source of walletSources) {
        try {
            const wallets = typeof source.get === 'function' ? source.get() : source;
            if (Array.isArray(wallets)) return wallets;
        } catch {}
    }

    return [];
}

function findStandardSolanaWallet(walletType) {
    const catalogItem = SOLANA_WALLET_CATALOG.find(item => item.walletType === walletType);
    const expected = (catalogItem?.name || walletType).toLowerCase();
    return getWalletStandardWallets().find(wallet => {
        const name = String(wallet?.name || wallet?.info?.name || '').toLowerCase();
        return name.includes(expected) && (
            wallet?.chains?.some?.(chain => String(chain).toLowerCase().includes('solana')) ||
            Object.keys(wallet?.features || {}).some(feature => feature.toLowerCase().includes('solana')) ||
            name.includes(expected)
        );
    }) || null;
}

function getProviderIcon(provider, standardWallet) {
    return standardWallet?.icon ||
        standardWallet?.info?.icon ||
        provider?.icon ||
        provider?.info?.icon ||
        provider?.metadata?.icon ||
        '';
}

function getSolanaWalletMark(walletType) {
    const marks = {
        phantom: `
            <svg viewBox="0 0 32 32">
                <rect width="32" height="32" rx="10" fill="#AB9FF2"/>
                <path d="M8 18.1c0-5 3.8-9.1 8.4-9.1 4.5 0 7.6 3.4 7.6 8.3v4.6c0 .6-.7.9-1.1.5l-1.6-1.4c-.2-.2-.5-.2-.7 0l-1.5 1.4c-.3.3-.7.3-1 0L16.8 21c-.2-.2-.5-.2-.7 0l-1.5 1.4c-.3.3-.7.3-1 0L12.2 21c-.2-.2-.5-.2-.7 0l-1.7 1.5c-.4.4-1.1.1-1.1-.5v-3.9Z" fill="#fff"/>
                <circle cx="19.7" cy="15.5" r="1.1" fill="#2B2155"/>
                <circle cx="23" cy="15.5" r="1.1" fill="#2B2155"/>
            </svg>
        `,
        backpack: `
            <svg viewBox="0 0 32 32">
                <rect width="32" height="32" rx="10" fill="#EF4444"/>
                <path d="M12 10.5A4 4 0 0 1 16 7a4 4 0 0 1 4 3.5" fill="none" stroke="#14141A" stroke-width="2.2" stroke-linecap="round"/>
                <path d="M9 14.5A4.5 4.5 0 0 1 13.5 10h5A4.5 4.5 0 0 1 23 14.5V25H9V14.5Z" fill="#14141A"/>
                <rect x="12" y="17" width="8" height="4" rx="2" fill="#EF4444"/>
            </svg>
        `,
        solflare: `
            <svg viewBox="0 0 32 32">
                <rect width="32" height="32" rx="10" fill="#14141A"/>
                <path d="M8 10h16l-3.5 4H4.5L8 10Z" fill="#8B5CF6"/>
                <path d="M11.5 15h16L24 19H8l3.5-4Z" fill="#06B6D4"/>
                <path d="M8 20h16l-3.5 4H4.5L8 20Z" fill="#10B981"/>
            </svg>
        `,
        zerion: `
            <svg viewBox="0 0 32 32">
                <rect width="32" height="32" rx="10" fill="#2563EB"/>
                <path d="M10 10h12v3.2l-6.7 5.6H22V22H10v-3.2l6.8-5.6H10V10Z" fill="#fff"/>
            </svg>
        `,
    };

    return `
        <span class="wallet-icon wallet-mark ${escapeHtml(walletType)}-mark" aria-hidden="true">
            ${marks[walletType] || `<span>${escapeHtml(walletType.slice(0, 1).toUpperCase())}</span>`}
        </span>
    `;
}

function getSolanaWalletIconMarkup(walletType, name, provider) {
    const standardWallet = findStandardSolanaWallet(walletType);
    const providerName = standardWallet?.name || standardWallet?.info?.name || name;
    const icon = getProviderIcon(provider, standardWallet);
    const fallback = getSolanaWalletMark(walletType);

    if (!icon) return fallback;
    return `
        <span class="wallet-icon-stack">
            <img src="${escapeHtml(icon)}" alt="${escapeHtml(providerName)}" class="wallet-icon" data-wallet-icon>
            ${fallback}
        </span>
    `;
}

function wireWalletIconFallbacks(root) {
    root.querySelectorAll('img[data-wallet-icon]').forEach(img => {
        img.addEventListener('error', () => {
            img.closest('.wallet-icon-stack')?.classList.add('icon-failed');
        }, { once: true });
    });
}

function renderSolanaWallets() {
    const list = document.getElementById('solana-wallet-list');
    if (!list) return;

    list.innerHTML = SOLANA_WALLET_CATALOG.map(wallet => {
        const provider = getSolanaWalletProvider(wallet.walletType);
        const detected = Boolean(provider);
        const optionClasses = [
            wallet.optionClass || '',
            detected ? '' : 'not-detected',
        ].filter(Boolean).join(' ');
        return `
            <div class="wallet-option ${escapeHtml(optionClasses)}" data-wallet="${escapeHtml(wallet.walletType)}" aria-disabled="${detected ? 'false' : 'true'}" title="${detected ? '' : 'Wallet not detected'}">
                ${getSolanaWalletIconMarkup(wallet.walletType, wallet.name, provider)}
                <span class="wallet-copy">
                    <span class="wallet-name">${escapeHtml(wallet.name)}</span>
                    <span class="wallet-support ${escapeHtml(wallet.supportClass)}">${escapeHtml(wallet.supportLabel)}</span>
                </span>
            </div>
        `;
    }).join('');

    wireWalletIconFallbacks(list);
    list.querySelectorAll('.wallet-option[data-wallet]').forEach(opt => {
        opt.addEventListener('click', async () => {
            const walletType = opt.getAttribute('data-wallet');
            const provider = getSolanaWalletProvider(walletType);
            if (!provider) {
                sounds.play('error');
                alert(`${walletType} wallet not detected. Backpack and Solflare are supported for Solana routes; Phantom is limited for this route.`);
                return;
            }
            if (walletType === 'phantom') {
                sounds.play('error');
                log(PRODUCT_ERROR_MESSAGES.phantomSourceUnsupported, 'error');
                return;
            }
            closeWalletModal();
            await connectSolanaWallet(walletType);
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

    syncServerTransfersForConnectedWallets();
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
        if (disconnectEvmBtn) {
            disconnectEvmBtn.hidden = false;
            disconnectEvmBtn.disabled = false;
        }
        rememberEvmWallet(providerDetail, evmAccount);
        log(`${silent ? 'EVM Node Restored' : 'EVM Node Linked'}: ${evmAccount}`, 'success');
        checkReady();
        updateBalances();
        syncServerTransfersForConnectedWallets();
        return true;
    } catch (e) {
        currentEvmProvider = null;
        evmAdapter = null;
        evmAccount = null;
        connectEvmBtn.querySelector('span').innerText = "Connect EVM";
        if (disconnectEvmBtn) disconnectEvmBtn.disabled = true;
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

    if (tab === 'evm') renderEvmWallets();
    if (tab === 'solana') renderSolanaWallets();
}

function openWalletModal(tab = 'evm') {
    setWalletModalTab(tab);
    quantumWalletModal.style.display = 'flex';
    syncBodyScrollLock();
}

function closeWalletModal() {
    quantumWalletModal.style.display = 'none';
    syncBodyScrollLock();
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

function refreshAfterWalletDisconnect() {
    clearVisibleTransferState();
    clearLegacyTransferBrowserStorage();
    updateBalances();
    checkReady();
    if (evmAccount || solanaAccount) {
        syncServerTransfersForConnectedWallets();
    }
}

function disconnectEvmWallet() {
    sounds.play('click');
    evmAccount = null;
    evmAdapter = null;
    currentEvmProvider = null;
    evmRestoreAttempted = false;
    forgetWalletSessionPart('evm');
    connectEvmBtn.querySelector('span').innerText = "Connect EVM";
    if (disconnectEvmBtn) disconnectEvmBtn.disabled = true;
    refreshAfterWalletDisconnect();
}

function disconnectSolanaWallet() {
    sounds.play('click');
    try { currentSolanaProvider?.disconnect?.(); } catch {}
    solanaAccount = null;
    solanaWalletType = null;
    solanaAdapter = null;
    currentSolanaProvider = null;
    solanaRestoreAttempted = false;
    forgetWalletSessionPart('solana');
    connectSolanaBtn.querySelector('span').innerText = "Connect Solana";
    if (disconnectSolanaBtn) disconnectSolanaBtn.disabled = true;
    refreshAfterWalletDisconnect();
}

disconnectEvmBtn?.addEventListener('click', disconnectEvmWallet);
disconnectSolanaBtn?.addEventListener('click', disconnectSolanaWallet);

connectSolanaBtn.addEventListener('click', () => {
    sounds.play('click');
    if (solanaAccount) return;
    openWalletModal('solana');
});

function refreshSolanaWalletDetection() {
    renderSolanaWallets();
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
            alert(`${walletType} wallet not detected. Backpack and Solflare are supported for Solana routes; Phantom is limited for this route.`);
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
        if (disconnectSolanaBtn) {
            disconnectSolanaBtn.hidden = false;
            disconnectSolanaBtn.disabled = false;
        }
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
        if (disconnectSolanaBtn) disconnectSolanaBtn.disabled = true;
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
    startEstimatedArrivalMonitor(originChainSelect.value, destinationChainSelect.value);
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
            recordTransferFailure(recoveryId, {
                stage: 'recovery.manual',
                route: `${source}->${destination}`,
                state: TRANSFER_STATES.RECOVERABLE,
                burnTxHash,
                productMessage: errorText,
                error: e,
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
            recordTransferFailure(transfer.id || transfer.burnTxHash, {
                stage: 'recovery.item',
                route: `${transfer.from || 'unknown'}->${transfer.to || 'unknown'}`,
                state: TRANSFER_STATES.RECOVERABLE,
                burnTxHash: transfer.burnTxHash,
                productMessage: errorText,
                error: e,
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
    let finalEtaLabel = null;
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
            sourceWallet,
            destinationWallet,
            recipient,
            wallets: activeBridgeContext.wallets,
            useForwarder,
            lifecycleState: TRANSFER_STATES.CREATED,
            lifecycleLabel: getTransferStateLabel(TRANSFER_STATES.CREATED),
        });
        await syncTransferToBackend(activeBridgeContext, 'upsert');

        if (useForwarder) {
            const feeMinor = await assertForwarderAmountCoversFee({ from, to, amount: formattedAmount });
            if (feeMinor !== null) {
                log(`Circle Forwarder route fee estimate: ${formatUsdcMinorUnits(feeMinor)} USDC.`, 'loading');
            }
        }

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
        startEstimatedArrivalMonitor(from, to);
        const bridgePromise = kit.bridge(bridgeParams);
        const result = useForwarder
            ? await Promise.race([
                bridgePromise,
                waitForForwarderCompletion(activeBridgeContext.id).catch(error => {
                    console.warn('[QuantumBridge] Forwarder fast completion watcher fell back to SDK result.', error);
                    return bridgePromise;
                }),
            ])
            : await bridgePromise;

        if (result.state === 'success') {
            sounds.play('success');
            finalEtaLabel = 'Arrived';
            successOverlay.style.display = 'flex';
            syncBodyScrollLock();
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
                sourceWallet,
                destinationWallet,
                recipient,
                wallets: activeBridgeContext?.wallets || [],
                useForwarder,
                lifecycleState: TRANSFER_STATES.COMPLETED,
                lifecycleLabel: getTransferStateLabel(TRANSFER_STATES.COMPLETED),
            });
        } else {
            const failedStep = result.steps?.find(s => s.state === 'error');
            const stepError = failedStep?.error;
            const productMessage = getProductErrorMessage(stepError || failedStep?.errorMessage || PRODUCT_ERROR_MESSAGES.genericRecoverable);
            if (stepError && stepError.cause && stepError.cause.trace) {
                const trace = stepError.cause.trace;
                console.warn('[QuantumBridge] Bridge step failed', {
                    route: `${from}->${to}`,
                    stage: failedStep?.name || 'bridge.result',
                    productMessage,
                    chain: trace.chain || null,
                    code: getErrorCodeSummary(trace.rawError || stepError),
                });
                const logs = trace.logs || trace.errorDetails?.logs || [];
                const logsStr = Array.isArray(logs) ? logs.join('\n') : String(logs);
                if (logsStr.includes('remote_token_messenger')) console.error("DIAGNOSIS: Destination domain unsupported on Solana Devnet.");
            }
            finalEtaLabel = 'Paused';
            const nextState = activeBridgeContext?.burnTxHash ? TRANSFER_STATES.RECOVERABLE : TRANSFER_STATES.FAILED;
            patchTransferRecord(activeBridgeContext?.id, {
                state: nextState,
                errorMessage: productMessage,
            });
            recordTransferFailure(activeBridgeContext?.id, {
                stage: failedStep?.name || 'bridge.result',
                route: `${from}->${to}`,
                state: nextState,
                burnTxHash: activeBridgeContext?.burnTxHash || null,
                productMessage,
                error: stepError || failedStep?.errorMessage || failedStep,
                sourceWallet,
                destinationWallet,
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
                sourceWallet,
                destinationWallet,
                recipient,
                wallets: activeBridgeContext?.wallets || [],
                useForwarder,
                lifecycleState: nextState,
                lifecycleLabel: getTransferStateLabel(nextState),
                errorMessage: productMessage,
            });
        }
    } catch (e) {
        sounds.play('error');
        finalEtaLabel = 'Paused';
        const productMessage = getProductErrorMessage(e);
        const nextState = activeBridgeContext?.burnTxHash ? TRANSFER_STATES.RECOVERABLE : TRANSFER_STATES.FAILED;
        patchTransferRecord(activeBridgeContext?.id, {
            state: nextState,
            errorMessage: productMessage,
        });
        recordTransferFailure(activeBridgeContext?.id, {
            stage: 'bridge.exception',
            route: `${from}->${to}`,
            state: nextState,
            burnTxHash: activeBridgeContext?.burnTxHash || null,
            productMessage,
            error: e,
            sourceWallet: activeBridgeContext?.sourceWallet || null,
            destinationWallet: activeBridgeContext?.destinationWallet || null,
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
            sourceWallet: activeBridgeContext?.sourceWallet || null,
            destinationWallet: activeBridgeContext?.destinationWallet || null,
            recipient: activeBridgeContext?.recipient || null,
            wallets: activeBridgeContext?.wallets || [],
            useForwarder: activeBridgeContext?.useForwarder,
            lifecycleState: nextState,
            lifecycleLabel: getTransferStateLabel(nextState),
            errorMessage: productMessage,
        });
    } finally {
        teleportBtn.classList.remove('loading');
        finishEstimatedArrival(finalEtaLabel);
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
    syncBodyScrollLock();
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

function getActivityExplorerTarget(item) {
    const mintHash = item?.txHash || item?.mintTxHash;
    if (mintHash) {
        return {
            chain: getActivityExplorerChain({ ...item, txHash: mintHash }),
            hash: mintHash,
            label: 'Open in explorer',
        };
    }
    if (item?.burnTxHash) {
        return {
            chain: item.from || 'arc',
            hash: item.burnTxHash,
            label: 'Open burn in explorer',
        };
    }
    return null;
}

function hasKnownWalletForActivity() {
    const session = readWalletSession();
    return Boolean(evmAccount || solanaAccount || session.evm?.address || session.solana?.address);
}

function getCurrentActivitySource() {
    return currentActivityScope === 'global' ? globalActivityHistory : activityHistory;
}

function getActivityById(id) {
    return getCurrentActivitySource().find(entry => String(entry.id) === String(id));
}

function getVisibleActivities() {
    const query = currentActivitySearch.trim().toLowerCase();
    return getCurrentActivitySource().filter(item => {
        const status = item.status || 'pending';
        const statusMatches = currentStatusFilter === 'all' || status === currentStatusFilter;
        const chainMatches = currentChainFilter === 'all' ||
            item.from === currentChainFilter ||
            item.to === currentChainFilter;
        const searchText = [
            item.id,
            item.recoveryId,
            item.txHash,
            item.mintTxHash,
            item.burnTxHash,
            item.sourceWallet,
            item.destinationWallet,
            item.recipient,
            item.from,
            item.to,
            item.amount,
            item.errorMessage,
            ...(Array.isArray(item.wallets) ? item.wallets : []),
        ].filter(Boolean).join(' ').toLowerCase();
        const searchMatches = !query || searchText.includes(query);
        return statusMatches && chainMatches && searchMatches;
    });
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
    const explorerTarget = getActivityExplorerTarget(item);
    const explorerUrl = explorerTarget ? getLink(explorerTarget.chain, explorerTarget.hash) : null;
    const transactionLabel = explorerTarget ? shortHash(explorerTarget.hash) : (item.alreadyMinted ? 'Already minted' : 'Pending');
    const detailRow = (label, value) => value ? `
        <div class="manifest-row">
            <span class="m-label">${escapeHtml(label)}</span>
            <span class="m-value">${escapeHtml(value)}</span>
        </div>
    ` : '';

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
            ${detailRow('Updated', item.updatedAt ? formatActivityTime(item.updatedAt) : null)}
            <div class="manifest-row">
                <span class="m-label">Status</span>
                <span class="m-value">${escapeHtml(lifecycleLabel)}</span>
            </div>
            ${detailRow('Delivery', item.useForwarder ? 'Circle Forwarder' : 'Manual destination mint')}
            ${detailRow('Source wallet', item.sourceWallet ? shortHash(item.sourceWallet) : null)}
            ${detailRow('Destination wallet', item.destinationWallet ? shortHash(item.destinationWallet) : null)}
            ${detailRow('Recipient', item.recipient && item.recipient !== item.destinationWallet ? shortHash(item.recipient) : null)}
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
            ${item.mintTxHash || item.txHash ? `
                <div class="manifest-row">
                    <span class="m-label">Mint transaction</span>
                    <span class="m-value">${escapeHtml(shortHash(item.mintTxHash || item.txHash))}</span>
                </div>
            ` : ''}
        </div>
        <div class="manifest-actions">
            ${explorerUrl
                ? `<a class="btn btn-primary full-width" href="${explorerUrl}" target="_blank" rel="noopener">${escapeHtml(explorerTarget.label)}</a>`
                : `<button class="btn btn-glass full-width" disabled>${item.alreadyMinted ? 'Mint already completed' : 'No transaction hash yet'}</button>`}
        </div>
    `;
    txDetailsOverlay.style.display = 'flex';
    syncBodyScrollLock();
}

function closeTransactionDetails() {
    if (!txDetailsOverlay) return;
    txDetailsOverlay.style.display = 'none';
    syncBodyScrollLock();
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
        mintTxHash: txHash || extra.mintTxHash || extra.txHash || null,
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
    activityScopeBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.activityScope === currentActivityScope);
    });
    if (clearActivityBtn) {
        clearActivityBtn.hidden = currentActivityScope === 'global';
    }
    const activitySource = getCurrentActivitySource();
    const visibleActivities = getVisibleActivities();
    if (activitySource.length === 0) {
        const emptyMessage = currentActivityScope === 'global'
            ? 'No global bridge activity indexed yet.'
            : (hasKnownWalletForActivity()
                ? 'No transfers found for connected wallets yet.'
                : 'Connect a wallet to load your transfer history.');
        list.classList.add('empty-portal');
        list.innerHTML = `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
        return;
    }
    if (visibleActivities.length === 0) {
        list.classList.add('empty-portal');
        list.innerHTML = '<div class="empty-state">No activity matches these filters.</div>';
        return;
    }
    list.classList.remove('empty-portal');
    list.innerHTML = visibleActivities.map(item => {
        const lifecycleState = item.lifecycleState || item.state || (item.alreadyMinted ? TRANSFER_STATES.ALREADY_CLAIMED : null);
        const lifecycleLabel = item.lifecycleLabel || (lifecycleState ? getTransferStateLabel(lifecycleState) : (item.status || 'pending'));
        const explorerTarget = getActivityExplorerTarget(item);
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
                    ${explorerTarget
                        ? `<a class="tx-link" href="${getLink(explorerTarget.chain, explorerTarget.hash)}" target="_blank" rel="noopener">Open in explorer</a>`
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
    const item = getActivityById(itemEl.dataset.activityId);
    openTransactionDetails(item);
});

document.getElementById('activity-list')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest('button, a')) return;
    const itemEl = event.target.closest('.activity-item[data-activity-id]');
    if (!itemEl) return;
    event.preventDefault();
    const item = getActivityById(itemEl.dataset.activityId);
    openTransactionDetails(item);
});

activityScopeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        currentActivityScope = btn.dataset.activityScope || 'mine';
        renderActivity();
        if (currentActivityScope === 'global') {
            syncGlobalTransfers();
        } else {
            syncServerTransfersForConnectedWallets();
        }
    });
});

activityFilterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        currentStatusFilter = btn.dataset.filter || 'all';
        activityFilterBtns.forEach(item => item.classList.toggle('active', item === btn));
        renderActivity();
    });
});

chainFilterSelect?.addEventListener('change', () => {
    currentChainFilter = chainFilterSelect.value || 'all';
    renderActivity();
});

activitySearchInput?.addEventListener('input', () => {
    currentActivitySearch = activitySearchInput.value || '';
    renderActivity();
});

window.addEventListener('pagehide', () => {
    flushQueuedTransferSyncs({ useBeacon: true });
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        flushQueuedTransferSyncs({ useBeacon: true });
    }
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
startEstimatedArrivalMonitor(originChainSelect?.value, destinationChainSelect?.value);
renderPendingRecoveries();
renderRecoveryBanner();

clearActivityBtn?.addEventListener('click', () => { activityHistory = []; saveActivity(); });

log("QuantumBridge Core Systems Online.");
log("Awaiting Fleet Connection...");
const startupRecoveries = getActionableRecoveries();
if (startupRecoveries.length > 0) {
    log(`${startupRecoveries.length} pending CCTP recovery checkpoint${startupRecoveries.length === 1 ? '' : 's'} detected. Use Resume all when wallets are connected.`, 'loading');
}
syncServerTransfersForConnectedWallets();
syncGlobalTransfers();
window.setInterval(syncGlobalTransfers, 30000);
scheduleWalletSessionRestore();
window.addEventListener('load', scheduleWalletSessionRestore);
