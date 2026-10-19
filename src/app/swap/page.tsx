'use client';

import Link from 'next/link';
import { Press_Start_2P } from 'next/font/google';
import { useMemo, useEffect, useState, useCallback, useRef } from 'react';
import { useAccount, useBalance, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther, parseUnits, formatUnits } from 'viem';
import { ArrowLeft, ArrowUpDown, Loader2, CheckCircle, ExternalLink, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TokenIcon } from '@/components/shared/TokenIcon';
import { getTokenInfo, SEPOLIA_CHAIN_ID, TOKENS } from '@/lib/contracts/addresses';
import { UNISWAP_V2_SEPOLIA, uniswapV2RouterABI } from '@/lib/contracts/uniswap';
import { erc20ABI } from '@/lib/contracts/abis';
import { getSepoliaExplorerUrl, sepoliaPublicClient } from '@/lib/chain';
import { useSepoliaNetwork, clearRejectedSwitchSession } from '@/hooks/useSepoliaNetwork';

const pressStart2P = Press_Start_2P({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});

const WETH = UNISWAP_V2_SEPOLIA.weth;
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as `0x${string}`;
const ZERO = '0x0000000000000000000000000000000000000000' as `0x${string}`;
const MIN_ETH_GAS_FLOOR = parseEther('0.0015');

type TransactionType = 'approve' | 'swap';

interface SubmittedTx {
  hash: `0x${string}`;
  type: TransactionType;
}

export default function SwapPage() {
  const { address, isConnected, chainId: accountChainId } = useAccount();
  const {
    networkReady,
    isSepolia: hookIsSepolia,
    isWrongNetwork,
    isSwitching,
    error: networkError,
    requestSepolia,
    ensureSepolia,
    verifiedChainId,
  } = useSepoliaNetwork();

  const activeChainId = verifiedChainId ?? accountChainId;
  const isSepolia = isConnected && (hookIsSepolia || activeChainId === SEPOLIA_CHAIN_ID);
  const isUnsupported = isConnected && (isWrongNetwork || (activeChainId !== undefined && activeChainId !== SEPOLIA_CHAIN_ID));

  const [from, setFrom] = useState(ZERO);
  const [to, setTo] = useState(USDC);
  const [amount, setAmount] = useState('');

  // 1. QUOTE CONTEXT INTEGRITY & DATA STRUCTURE
  interface QuoteData {
    outputAmount: bigint;
    amountIn: bigint;
    from: `0x${string}`;
    to: `0x${string}`;
    chainId: number;
    account: `0x${string}`;
    timestamp: number;
  }

  const [activeQuote, setActiveQuote] = useState<QuoteData | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [preflighting, setPreflighting] = useState(false);
  const [error, setError] = useState('');
  const [marketPrice, setMarketPrice] = useState<number | null>(null);
  const [marketPriceLoading, setMarketPriceLoading] = useState(false);
  const [maxCalculating, setMaxCalculating] = useState(false);
  const [submittedTx, setSubmittedTx] = useState<SubmittedTx | null>(null);

  // 2. COMPONENT MOUNT & ASYNC GENERATION REFS
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const quoteRequestIdRef = useRef(0);
  const allowanceReqIdRef = useRef(0);

  const tokens = useMemo(() => {
    const list = Object.entries(TOKENS.sepolia).map(([addr, t]) => ({
      address: addr as `0x${string}`,
      symbol: t.symbol,
      decimals: t.decimals,
    }));
    return list;
  }, []);

  const fromInfo = getTokenInfo('sepolia', from);
  const toInfo = getTokenInfo('sepolia', to);

  useEffect(() => {
    const entries = Object.entries(TOKENS.sepolia);
    if (entries.length > 1 && !entries.some(([a]) => a === to)) setTo(entries[1][0] as `0x${string}`);
    if (entries.length > 0 && !entries.some(([a]) => a === from)) setFrom(entries[0][0] as `0x${string}`);
  }, [to, from]);

  const isEthIn = from === ZERO;
  const path = useMemo(() => (isEthIn ? [WETH, USDC] : [USDC, WETH]), [isEthIn]);

  const amountIn = useMemo(() => {
    if (!amount || Number(amount) <= 0) return 0n;
    try {
      return isEthIn ? parseEther(amount) : parseUnits(amount, 6);
    } catch {
      return 0n;
    }
  }, [amount, isEthIn]);

  const client = sepoliaPublicClient;

  // 3. QUOTE FRESHNESS POLICY (60s TTL WITH REACTIVE EXPIRATION TIMER)
  const QUOTE_TTL_MS = 60_000;
  const [quoteExpiredTick, setQuoteExpiredTick] = useState<number>(0);

  useEffect(() => {
    if (!activeQuote) return;
    const age = Date.now() - activeQuote.timestamp;
    const remaining = Math.max(0, QUOTE_TTL_MS - age);
    const timer = setTimeout(() => {
      if (isMountedRef.current) {
        setQuoteExpiredTick((prev) => prev + 1);
      }
    }, remaining);
    return () => clearTimeout(timer);
  }, [activeQuote]);

  const isQuoteStale = useMemo(() => {
    if (!activeQuote) return false;
    return Date.now() - activeQuote.timestamp >= QUOTE_TTL_MS;
  }, [activeQuote, quoteExpiredTick]);

  // Context verification: Quote MUST belong to the exact current input amount, tokens, account, and chain
  const isQuoteContextValid = useMemo(() => {
    if (!activeQuote || !address || !isSepolia || !networkReady) return false;
    return (
      activeQuote.amountIn === amountIn &&
      activeQuote.amountIn > 0n &&
      activeQuote.from === from &&
      activeQuote.to === to &&
      activeQuote.account.toLowerCase() === address.toLowerCase() &&
      activeQuote.chainId === SEPOLIA_CHAIN_ID
    );
  }, [activeQuote, amountIn, from, to, address, isSepolia, networkReady]);

  // Executable quote is strictly bound to context and not stale
  const executableQuote = isQuoteContextValid && !isQuoteStale ? activeQuote : null;
  const minOut = executableQuote !== null ? (executableQuote.outputAmount * 995n) / 1000n : 0n;

  // 4. ASYNC QUOTE FETCHING WITH STRICT RACE & CONTEXT CHECKS
  const fetchQuote = useCallback(async (reqId: number) => {
    if (!isSepolia || !networkReady || amountIn <= 0n || !client || !address) {
      if (isMountedRef.current && quoteRequestIdRef.current === reqId) {
        setQuoteLoading(false);
      }
      return;
    }

    const snapshotAmountIn = amountIn;
    const snapshotFrom = from;
    const snapshotTo = to;
    const snapshotAddress = address;
    const snapshotPath = path;

    try {
      const amounts = (await client.readContract({
        address: UNISWAP_V2_SEPOLIA.router,
        abi: uniswapV2RouterABI,
        functionName: 'getAmountsOut',
        args: [snapshotAmountIn, snapshotPath],
      })) as bigint[];

      // Invalidate if a newer request began or component unmounted
      if (!isMountedRef.current || quoteRequestIdRef.current !== reqId) return;

      // Invalidate if context drifted during RPC flight
      if (
        amountIn !== snapshotAmountIn ||
        from !== snapshotFrom ||
        to !== snapshotTo ||
        address !== snapshotAddress
      ) {
        return;
      }

      const outputAmount = amounts[amounts.length - 1] ?? null;
      if (outputAmount && outputAmount > 0n) {
        setActiveQuote({
          outputAmount,
          amountIn: snapshotAmountIn,
          from: snapshotFrom,
          to: snapshotTo,
          chainId: SEPOLIA_CHAIN_ID,
          account: snapshotAddress,
          timestamp: Date.now(),
        });
        setError('');
      } else {
        setActiveQuote(null);
      }
    } catch (e: any) {
      if (!isMountedRef.current || quoteRequestIdRef.current !== reqId) return;
      setActiveQuote(null);
      setError(e?.shortMessage || 'No liquidity for this pair.');
    } finally {
      if (isMountedRef.current && quoteRequestIdRef.current === reqId) {
        setQuoteLoading(false);
      }
    }
  }, [isSepolia, networkReady, amountIn, from, to, address, path, client]);

  // 400ms typing debounce for automatic quoting
  useEffect(() => {
    if (!isSepolia || !networkReady || amountIn <= 0n) {
      setQuoteLoading(false);
      return;
    }

    setQuoteLoading(true);
    const reqId = ++quoteRequestIdRef.current;
    const timer = setTimeout(() => {
      fetchQuote(reqId);
    }, 400);

    return () => {
      clearTimeout(timer);
    };
  }, [isSepolia, networkReady, amountIn, from, to, address, fetchQuote]);

  // Manual one-click quote refresh helper for expired quotes
  const refreshQuoteNow = useCallback(() => {
    if (amountIn <= 0n || !isSepolia || !networkReady) return;
    setQuoteLoading(true);
    const reqId = ++quoteRequestIdRef.current;
    fetchQuote(reqId);
  }, [amountIn, isSepolia, networkReady, fetchQuote]);

  // Immediate quote invalidation on wallet, chain, or network changes
  useEffect(() => {
    quoteRequestIdRef.current += 1;
    setActiveQuote(null);
    setError('');
    setSubmittedTx(null);
  }, [address, activeChainId, isSepolia, networkReady]);

  const { data: ethBalance, refetch: refetchEthBalance } = useBalance({ address, chainId: SEPOLIA_CHAIN_ID });
  const { data: tokenBalance, refetch: refetchTokenBalance } = useReadContract({
    address: from,
    abi: erc20ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: SEPOLIA_CHAIN_ID,
    query: { enabled: !!address && !isEthIn && !!from },
  });
  const fromBalanceRaw = isEthIn ? ethBalance?.value : tokenBalance;
  const fromBalanceLabel = useMemo(() => {
    if (!address || !fromInfo || fromBalanceRaw === undefined || fromBalanceRaw === null) return '';
    return `${Number(formatUnits(fromBalanceRaw, fromInfo.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${fromInfo.symbol}`;
  }, [address, fromBalanceRaw, fromInfo]);

  const setMax = async () => {
    if (!fromInfo || fromBalanceRaw === undefined || fromBalanceRaw === null || fromBalanceRaw <= 0n) return;

    // Immediately invalidate active quotes
    quoteRequestIdRef.current += 1;
    setActiveQuote(null);
    setError('');

    // For non-native tokens (USDC), gas is paid separately in native ETH, so Max uses the full raw token balance
    if (!isEthIn) {
      setAmount(formatUnits(fromBalanceRaw, fromInfo.decimals));
      return;
    }

    // For native ETH: calculate gas reserve for swapExactETHForTokens
    setMaxCalculating(true);
    try {
      let gasPrice: bigint | undefined;
      try {
        if (client) {
          gasPrice = await client.getGasPrice();
        }
      } catch {
        gasPrice = undefined;
      }

      // The native-ETH swap path executes swapExactETHForTokens on Uniswap V2 Router.
      // Standard execution uses ~110k-140k gas. We allocate 180,000 gas units with a 1.5x buffer (150%)
      // to safely accommodate EIP-1559 base fee variance between quoting and transaction inclusion.
      const SWAP_ETH_GAS_LIMIT = 180_000n;
      const calculatedGasReserve = gasPrice
        ? (SWAP_ETH_GAS_LIMIT * gasPrice * 150n) / 100n
        : parseEther('0.005'); // Conservative fallback if RPC gasPrice query fails

      // Enforce a minimum safety floor of 0.003 ETH (~$10 at testnet equivalent) so users are never starved
      const MIN_GAS_FLOOR = parseEther('0.003');
      const effectiveReserve = calculatedGasReserve > MIN_GAS_FLOOR ? calculatedGasReserve : MIN_GAS_FLOOR;

      if (fromBalanceRaw <= effectiveReserve) {
        setAmount('0');
        setError(
          `ETH balance too low to reserve network fees (~${Number(formatUnits(effectiveReserve, 18)).toFixed(4)} ETH needed for gas).`
        );
        return;
      }

      const spendableWei = fromBalanceRaw - effectiveReserve;
      // Convert spendable wei to formatted string without floating-point conversion loss
      const formatted = formatUnits(spendableWei, 18);
      // Clean display: truncate trailing digits to 6 decimals, rounding down safely to leave extra gas
      const [whole, decimals = ''] = formatted.split('.');
      const clampedAmount = decimals.length > 0 ? `${whole}.${decimals.slice(0, 6)}` : whole;

      setAmount(clampedAmount);
    } finally {
      setMaxCalculating(false);
    }
  };

  const hasInsufficientBalance = useMemo(() => {
    if (!amountIn || fromBalanceRaw === undefined || fromBalanceRaw === null) return false;
    return amountIn > fromBalanceRaw;
  }, [amountIn, fromBalanceRaw]);

  const hasInsufficientGas = useMemo(() => {
    if (!isEthIn || !amountIn || fromBalanceRaw === undefined || fromBalanceRaw === null) return false;
    if (amountIn > fromBalanceRaw) return false;
    // Native ETH swap requires at least ~0.0015 ETH remaining to cover base transaction execution
    return (fromBalanceRaw - amountIn) < MIN_ETH_GAS_FLOOR;
  }, [isEthIn, amountIn, fromBalanceRaw]);

  const hasZeroEthForGas = useMemo(() => {
    if (isEthIn) return false;
    return ethBalance?.value === 0n;
  }, [isEthIn, ethBalance]);

  // 5. USDC ALLOWANCE HANDLING & REFRESH ON APPROVAL CONFIRMATION
  const [allowance, setAllowance] = useState<bigint | null>(null);

  const fetchAllowance = useCallback(async () => {
    if (!isSepolia || isEthIn || !address || !client || from === ZERO) {
      setAllowance(null);
      return;
    }
    const reqId = ++allowanceReqIdRef.current;
    try {
      const val = (await client.readContract({
        address: from,
        abi: erc20ABI,
        functionName: 'allowance',
        args: [address, UNISWAP_V2_SEPOLIA.router],
      })) as bigint;
      if (isMountedRef.current && allowanceReqIdRef.current === reqId) {
        setAllowance(val);
      }
    } catch {
      // Retain previous state on transient failure
    }
  }, [isSepolia, isEthIn, address, client, from]);

  useEffect(() => {
    void fetchAllowance();
  }, [fetchAllowance]);

  const write = useWriteContract();
  const activeTxHash = submittedTx?.hash ?? (write.data as `0x${string}` | undefined);
  const receipt = useWaitForTransactionReceipt({ hash: activeTxHash, chainId: SEPOLIA_CHAIN_ID });

  // When approval or swap receipt confirms, refresh allowance and balances immediately
  const txConfirmed = receipt.isSuccess && activeTxHash !== undefined;
  useEffect(() => {
    if (txConfirmed) {
      void fetchAllowance();
      void refetchEthBalance();
      void refetchTokenBalance();
    }
  }, [txConfirmed, fetchAllowance, refetchEthBalance, refetchTokenBalance]);

  const needsApprove = !isEthIn && allowance !== null && amountIn > 0n && allowance < amountIn;

  useEffect(() => {
    let cancelled = false;
    const token = isEthIn ? 'ETH' : 'USDC';
    setMarketPriceLoading(true);
    fetch(`/api/price?token=${token}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d.price) setMarketPrice(d.price); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setMarketPriceLoading(false); });
    return () => { cancelled = true; };
  }, [isEthIn, from, to]);

  const marketValue = useMemo(() => {
    if (!marketPrice || !amount || Number(amount) <= 0) return null;
    const input = Number(amount);
    if (isEthIn) {
      return { usd: input * marketPrice, outUsdc: input * marketPrice, label: 'Live market (CoinGecko)' };
    }
    return { usd: input, outUsdc: input / marketPrice, label: 'Live market (CoinGecko)' };
  }, [marketPrice, amount, isEthIn]);

  // 6. SWAP PREFLIGHT WITH ON-CHAIN RE-QUOTING & SLIPPAGE PROTECTION
  const busy = isSwitching || preflighting || write.isPending || receipt.isLoading;

  const swap = async () => {
    if (busy || preflighting || !networkReady || !address || isUnsupported) return;
    if (!executableQuote || amountIn <= 0n) {
      setError('Please obtain a valid quote before swapping.');
      return;
    }

    // Context snapshot to guard against race conditions across async hops
    const snapshotAmountIn = amountIn;
    const snapshotFrom = from;
    const snapshotTo = to;
    const snapshotAddress = address;
    const snapshotPath = path;
    const snapshotIsEthIn = isEthIn;
    const reviewedQuoteOut = executableQuote.outputAmount;

    setPreflighting(true);
    setSubmittedTx(null);
    setError('');

    try {
      // Step 1: Network verification
      await ensureSepolia();

      // Ensure context did not change during network verification
      if (
        amountIn !== snapshotAmountIn ||
        from !== snapshotFrom ||
        to !== snapshotTo ||
        address !== snapshotAddress
      ) {
        setError('Swap context changed. Please review and try again.');
        return;
      }

      if (!client) {
        setError('RPC client unavailable.');
        return;
      }

      // Step 2: Fresh on-chain token balance check
      if (snapshotIsEthIn) {
        const freshEthBalance = await client.getBalance({ address: snapshotAddress });
        if (freshEthBalance < snapshotAmountIn + MIN_ETH_GAS_FLOOR) {
          setError(
            `Insufficient ETH balance. Additional ETH (~${Number(formatUnits(MIN_ETH_GAS_FLOOR, 18)).toFixed(4)} ETH) must remain for network fees (${Number(formatUnits(freshEthBalance, 18)).toFixed(4)} ETH available).`
          );
          return;
        }
      } else {
        const freshTokenBalance = (await client.readContract({
          address: snapshotFrom,
          abi: erc20ABI,
          functionName: 'balanceOf',
          args: [snapshotAddress],
        })) as bigint;
        if (freshTokenBalance < snapshotAmountIn) {
          setError(`Insufficient ${fromInfo?.symbol ?? 'token'} balance.`);
          return;
        }

        // Step 3: Fresh on-chain allowance check for USDC
        const freshAllowance = (await client.readContract({
          address: snapshotFrom,
          abi: erc20ABI,
          functionName: 'allowance',
          args: [snapshotAddress, UNISWAP_V2_SEPOLIA.router],
        })) as bigint;
        if (freshAllowance < snapshotAmountIn) {
          setError(`Insufficient allowance. Please approve ${fromInfo?.symbol ?? 'token'} first.`);
          return;
        }
      }

      // Step 4: Fetch fresh on-chain router quote using getAmountsOut
      const freshAmounts = (await client.readContract({
        address: UNISWAP_V2_SEPOLIA.router,
        abi: uniswapV2RouterABI,
        functionName: 'getAmountsOut',
        args: [snapshotAmountIn, snapshotPath],
      })) as bigint[];

      const freshOutput = freshAmounts[freshAmounts.length - 1];
      if (!freshOutput || freshOutput <= 0n) {
        setError('Could not verify pool liquidity. Please try again.');
        return;
      }

      // Step 5: Enforce deterioration limit:
      // If the fresh output has dropped beyond the 0.5% tolerance relative to the quote reviewed by the user,
      // stop before requesting a wallet signature and prompt the user to review the updated quote.
      const minAcceptableFromReview = (reviewedQuoteOut * 995n) / 1000n;
      if (freshOutput < minAcceptableFromReview) {
        setActiveQuote({
          outputAmount: freshOutput,
          amountIn: snapshotAmountIn,
          from: snapshotFrom,
          to: snapshotTo,
          chainId: SEPOLIA_CHAIN_ID,
          account: snapshotAddress,
          timestamp: Date.now(),
        });
        setError('Pool quote changed. Expected return dropped beyond 0.5% tolerance. Please review the updated quote.');
        return;
      }

      // Compute final minOut using the fresh quote and 0.5% slippage
      const finalMinOut = (freshOutput * 995n) / 1000n;

      // Re-verify context one final time before invoking the wallet signer
      if (
        amountIn !== snapshotAmountIn ||
        from !== snapshotFrom ||
        to !== snapshotTo ||
        address !== snapshotAddress
      ) {
        setError('Swap context changed. Transaction aborted.');
        return;
      }

      // Step 6: Submit transaction to wallet
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
      let hash: `0x${string}`;
      if (snapshotIsEthIn) {
        hash = await write.writeContractAsync({
          address: UNISWAP_V2_SEPOLIA.router,
          abi: uniswapV2RouterABI,
          functionName: 'swapExactETHForTokens',
          args: [finalMinOut, snapshotPath, snapshotAddress, deadline],
          value: snapshotAmountIn,
        });
      } else {
        hash = await write.writeContractAsync({
          address: UNISWAP_V2_SEPOLIA.router,
          abi: uniswapV2RouterABI,
          functionName: 'swapExactTokensForETH',
          args: [snapshotAmountIn, finalMinOut, snapshotPath, snapshotAddress, deadline],
        });
      }
      setSubmittedTx({ hash, type: 'swap' });
    } catch (e: any) {
      setError(e?.shortMessage || e?.message || 'Swap failed');
    } finally {
      if (isMountedRef.current) {
        setPreflighting(false);
      }
    }
  };

  const approve = async () => {
    if (busy || preflighting || !networkReady || !address || isUnsupported) return;
    setSubmittedTx(null);
    setError('');
    try {
      await ensureSepolia();
      const hash = await write.writeContractAsync({
        address: from,
        abi: erc20ABI,
        functionName: 'approve',
        args: [UNISWAP_V2_SEPOLIA.router, amountIn],
      });
      setSubmittedTx({ hash, type: 'approve' });
    } catch (e: any) {
      setError(e?.shortMessage || e?.message || 'Approval failed');
    }
  };

  const explorerUrl = activeTxHash ? getSepoliaExplorerUrl('tx', activeTxHash) : null;

  const flip = () => {
    quoteRequestIdRef.current += 1;
    setActiveQuote(null);
    setError('');
    setSubmittedTx(null);
    const f = from;
    setFrom(to);
    setTo(f);
    setAmount('');
  };

  // Picking the same token on both sides used to leave from === to, and the
  // receive select (which hides the from-token) then displayed a label that
  // didn't match the actual output token. Swapping the two instead keeps the
  // pair always valid — same as Uniswap.
  const pickFrom = (v: string) => {
    if (v === to) { flip(); return; }
    quoteRequestIdRef.current += 1;
    setActiveQuote(null);
    setError('');
    setSubmittedTx(null);
    setFrom(v as `0x${string}`);
  };
  const pickTo = (v: string) => {
    if (v === from) { flip(); return; }
    quoteRequestIdRef.current += 1;
    setActiveQuote(null);
    setError('');
    setSubmittedTx(null);
    setTo(v as `0x${string}`);
  };

  // Output display strictly reflects the genuine Uniswap pool quote.
  // CoinGecko market estimate is never presented as an executable pool quote.
  const outValue = useMemo(() => {
    if (!isSepolia || !networkReady) return null;
    if (executableQuote && toInfo) {
      return formatUnits(executableQuote.outputAmount, toInfo.decimals);
    }
    return null;
  }, [isSepolia, networkReady, executableQuote, toInfo]);
  const outDisplay = outValue ? Number(outValue).toLocaleString(undefined, { maximumFractionDigits: 4 }) : '0';

  return (
    <div className="max-w-lg mx-auto space-y-6">
      {/* BREADCRUMB / BACK NAVIGATION TO HUB */}
      <div>
        <Link
          href="/hub"
          className="inline-flex items-center gap-1.5 text-xs text-[#A3A3A3] hover:text-white transition-colors outline-none focus-visible:ring-1 focus-visible:ring-white/40 rounded"
        >
          <ArrowLeft size={14} />
          <span>Back to Hub</span>
        </Link>
      </div>

      {/* HEADER SECTION WITH PIXEL FONT AND TOOLTIP */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <h1
          className={`${pressStart2P.className} text-xl md:text-2xl font-normal text-white tracking-tight`}
        >
          Swap
        </h1>
        <div className="relative group inline-block">
          <button
            type="button"
            tabIndex={0}
            aria-label="About Swap"
            className="w-5 h-5 rounded-full bg-[#252525] hover:bg-white/10 border border-white/20 text-[#A3A3A3] hover:text-white text-[11px] font-bold font-mono inline-flex items-center justify-center shrink-0 transition-colors focus:outline-none focus:ring-1 focus:ring-white/40"
          >
            ?
          </button>
          <div className="absolute left-0 top-full mt-2 w-72 sm:w-80 p-3 rounded-xl bg-[#1B1B1B] border border-white/75 text-white text-xs leading-relaxed shadow-2xl opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-all duration-150 z-30">
            Swap ETH and USDC through the configured Uniswap V2 liquidity pool on Ethereum Sepolia. Quotes and transaction fees may change before confirmation.
          </div>
        </div>
      </div>

      {isUnsupported && (
        <div className="p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/10 text-xs text-amber-300 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} className="shrink-0 text-amber-400" />
            <span>
              <strong className="font-semibold text-amber-200">Wrong Network.</strong> Swaps are available only on Ethereum Sepolia.
              {networkError && <span className="block text-amber-200/80 mt-0.5">{networkError.message}</span>}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={isSwitching}
            onClick={() => {
              clearRejectedSwitchSession();
              void requestSepolia().catch(() => undefined);
            }}
            className="gap-1.5 shrink-0 text-xs h-7 px-2.5 bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-lg"
          >
            {isSwitching ? <Loader2 size={12} className="animate-spin" /> : null}
            Switch to Sepolia
          </Button>
        </div>
      )}

      {!isConnected ? (
        <div className="rounded-2xl border border-white/75 bg-[#1B1B1B] py-16 text-center">
          <p className="text-[#A3A3A3] text-sm">Connect your wallet to swap tokens.</p>
        </div>
      ) : (
        <>
          {/* You pay */}
          <div className="relative rounded-2xl border border-white/75 bg-[#1B1B1B] p-5">
            <p className="text-[11px] uppercase tracking-wider text-[#A3A3A3] mb-2.5">You pay</p>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <TokenIcon symbol={fromInfo?.symbol ?? ''} size={44} />
                <div className="min-w-0">
                  <select
                    value={from}
                    onChange={(e) => pickFrom(e.target.value)}
                    className="block bg-transparent font-bold text-lg text-white outline-none cursor-pointer [&>option]:bg-[#1B1B1B] [&>option]:text-white"
                  >
                    {tokens.map((t) => (
                      <option key={t.address} value={t.address}>{t.symbol}</option>
                    ))}
                  </select>
                  <p className="text-xs text-[#A3A3A3] truncate">{fromBalanceLabel || (fromInfo ? `${fromInfo.symbol} balance` : 'Unsupported network')}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={setMax}
                disabled={!fromBalanceRaw || fromBalanceRaw === 0n || maxCalculating}
                className="px-3 py-1.5 rounded-lg border border-white/20 bg-[#252525] text-xs font-medium text-zinc-300 hover:border-white/40 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0 inline-flex items-center gap-1.5"
              >
                {maxCalculating && <Loader2 size={11} className="animate-spin" />}
                Use Max
              </button>
            </div>

            <input
              type="number"
              min="0"
              step="any"
              placeholder="0"
              value={amount}
              onChange={(e) => {
                quoteRequestIdRef.current += 1;
                setActiveQuote(null);
                setError('');
                setAmount(e.target.value);
              }}
              className="mt-3.5 w-full bg-transparent text-center text-4xl sm:text-5xl font-bold text-white placeholder-zinc-700 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />

            <div className="mt-2.5 flex items-center justify-center gap-1.5">
              <span className="w-4 h-4 rounded-full bg-[#252525] border border-white/10 flex items-center justify-center text-[10px] text-[#A3A3A3]">=</span>
              <span className="text-xs sm:text-sm text-[#A3A3A3]">
                {marketPriceLoading ? (
                  <Loader2 size={12} className="animate-spin inline" />
                ) : marketValue ? (
                  `$${marketValue.usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                ) : (
                  '$0.00'
                )}
              </span>
            </div>
          </div>

          {/* Divider */}
          <div className="relative z-10 flex justify-center -my-3">
            <button
              type="button"
              onClick={flip}
              title="Reverse swap direction"
              aria-label="Reverse swap direction"
              className="p-2.5 rounded-xl bg-[#252525] border border-white/20 text-zinc-300 hover:text-white hover:border-white/40 transition-colors"
            >
              <ArrowUpDown size={16} />
            </button>
          </div>

          {/* You receive */}
          <div className="rounded-2xl border border-white/75 bg-[#1B1B1B] p-5">
            <p className="text-[11px] uppercase tracking-wider text-[#A3A3A3] mb-2.5">You receive</p>
            <div className="min-h-[52px] flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <TokenIcon symbol={toInfo?.symbol ?? ''} size={44} />
                <div className="min-w-0">
                  <select
                    value={to}
                    onChange={(e) => pickTo(e.target.value)}
                    className="block bg-transparent font-bold text-lg text-white outline-none cursor-pointer [&>option]:bg-[#1B1B1B] [&>option]:text-white"
                  >
                    {tokens.filter((t) => t.address !== from).map((t) => (
                      <option key={t.address} value={t.address}>{t.symbol}</option>
                    ))}
                  </select>
                  <p className="text-xs text-[#A3A3A3] truncate">
                    Receive {toInfo?.symbol ?? ''}
                    {isQuoteStale ? ' · quote expired' : quoteLoading ? ' · fetching quote...' : ''}
                  </p>
                </div>
              </div>
              <span className="text-3xl sm:text-4xl font-bold text-white tabular-nums tracking-tight break-all text-right">
                {quoteLoading ? <Loader2 size={20} className="animate-spin text-zinc-500 inline-block" /> : outDisplay}
              </span>
            </div>

            {(executableQuote !== null || marketValue) && (
              <div className="mt-3.5 pt-3 border-t border-white/10 space-y-1 text-right">
                {executableQuote !== null && (
                  <p className="text-[11px] text-[#A3A3A3]">
                    Pool quote · min received {toInfo ? Number(formatUnits(minOut, toInfo.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 }) : '-'} {toInfo?.symbol ?? ''} (0.5% slippage)
                  </p>
                )}
                {marketValue && (
                  <p className="text-[11px] text-[#A3A3A3]">
                    {marketValue.label} (reference only): ~{marketValue.outUsdc.toLocaleString(undefined, { maximumFractionDigits: 4 })} {toInfo?.symbol ?? ''}
                  </p>
                )}
                {marketValue && executableQuote !== null && (() => {
                  const poolVal = isEthIn ? Number(executableQuote.outputAmount) / 1e6 : Number(executableQuote.outputAmount) / 1e18;
                  const liveVal = marketValue.outUsdc;
                  const diffPct = Math.abs((poolVal - liveVal) / liveVal) * 100;
                  if (diffPct > 5) {
                    return (
                      <p className="text-[11px] text-amber-400">
                        Testnet pool price differs from live market ({diffPct.toFixed(0)}%) — you receive what the pool offers.
                      </p>
                    );
                  }
                  return null;
                })()}
              </div>
            )}
          </div>

          {/* Action area */}
          <div className="space-y-2.5 pt-1">
            {error && (
              <div className="p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-xs text-red-300">
                {error}
              </div>
            )}

            {activeTxHash && receipt.isSuccess && submittedTx && submittedTx.hash === activeTxHash && (
              <div className="p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 flex items-center gap-2 text-xs text-emerald-300">
                <CheckCircle size={15} className="text-emerald-400 shrink-0" />
                <span className="font-medium">
                  {submittedTx.type === 'approve' ? 'Approval confirmed!' : 'Swap confirmed!'}
                </span>
                {explorerUrl && (
                  <a
                    href={explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-emerald-400 hover:text-emerald-300 underline ml-auto inline-flex items-center gap-1"
                  >
                    View on Etherscan <ExternalLink size={11} className="inline" />
                  </a>
                )}
              </div>
            )}

            {networkReady && needsApprove ? (
              <Button
                type="button"
                onClick={approve}
                disabled={busy || isUnsupported || hasZeroEthForGas || hasInsufficientBalance || amountIn <= 0n}
                className="w-full h-12 font-semibold text-sm rounded-xl bg-white text-[#101010] hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-zinc-400 disabled:border disabled:border-white/10 transition-colors"
              >
                {busy ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 size={16} className="animate-spin" />
                    <span>
                      {write.isPending
                        ? 'Confirm approval in wallet...'
                        : receipt.isLoading
                        ? 'Waiting for approval confirmation...'
                        : 'Approving...'}
                    </span>
                  </span>
                ) : hasZeroEthForGas ? (
                  'ETH needed for approval gas'
                ) : (
                  `Approve ${fromInfo?.symbol ?? 'token'}`
                )}
              </Button>
            ) : (
              <Button
                type="button"
                onClick={
                  isUnsupported
                    ? () => { clearRejectedSwitchSession(); void requestSepolia().catch(() => undefined); }
                    : isQuoteStale
                    ? () => refreshQuoteNow()
                    : swap
                }
                disabled={
                  busy ||
                  !isConnected ||
                  (isUnsupported
                    ? isSwitching
                    : (
                        !networkReady ||
                        amountIn <= 0n ||
                        hasInsufficientBalance ||
                        hasInsufficientGas ||
                        hasZeroEthForGas ||
                        from === to ||
                        (isQuoteStale ? false : (!executableQuote || quoteLoading))
                      ))
                }
                className={`w-full h-12 font-semibold text-sm rounded-xl transition-colors ${
                  isUnsupported
                    ? 'bg-amber-500 hover:bg-amber-600 text-black'
                    : 'bg-white text-[#101010] hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-zinc-400 disabled:border disabled:border-white/10'
                }`}
              >
                {busy ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 size={16} className="animate-spin" />
                    <span>
                      {preflighting
                        ? 'Checking latest quote...'
                        : write.isPending
                        ? 'Confirm in wallet...'
                        : receipt.isLoading
                        ? 'Waiting for confirmation...'
                        : isSwitching
                        ? 'Switching to Sepolia...'
                        : 'Processing...'}
                    </span>
                  </span>
                ) : isUnsupported ? (
                  isSwitching ? 'Switching to Sepolia...' : 'Switch to Sepolia to swap'
                ) : from === to ? (
                  'Select different tokens'
                ) : !networkReady ? (
                  'Connect on Sepolia to swap'
                ) : !amount || Number(amount) <= 0 ? (
                  'Enter an amount'
                ) : hasInsufficientBalance ? (
                  `Insufficient ${fromInfo?.symbol ?? 'token'} balance`
                ) : hasInsufficientGas ? (
                  'Insufficient ETH for gas fees'
                ) : hasZeroEthForGas ? (
                  'ETH needed for transaction gas'
                ) : quoteLoading ? (
                  'Fetching quote...'
                ) : isQuoteStale ? (
                  'Quote expired — Refresh'
                ) : !executableQuote ? (
                  'Quote unavailable'
                ) : (
                  `Swap ${fromInfo?.symbol ?? ''} for ${toInfo?.symbol ?? ''}`
                )}
              </Button>
            )}

            <button
              type="button"
              onClick={() => {
                quoteRequestIdRef.current += 1;
                setAmount('');
                setActiveQuote(null);
                setError('');
                setSubmittedTx(null);
              }}
              className="w-full py-2.5 rounded-xl bg-[#252525] border border-white/20 text-xs font-medium text-[#A3A3A3] hover:text-white hover:border-white/40 transition-colors"
            >
              Clear
            </button>
          </div>
        </>
      )}
    </div>
  );
}
