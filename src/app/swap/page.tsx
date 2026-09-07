'use client';

import { useMemo, useEffect, useState, useCallback } from 'react';
import { useAccount, useChainId, useBalance, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther, parseUnits, formatUnits } from 'viem';
import { ChevronDown, ArrowUpDown, Loader2, CheckCircle, ExternalLink, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TokenIcon } from '@/components/shared/TokenIcon';
import { chainKeyForId, getTokenInfo, TOKENS } from '@/lib/contracts/addresses';
import { UNISWAP_V2_SEPOLIA, uniswapV2RouterABI } from '@/lib/contracts/uniswap';
import { erc20ABI } from '@/lib/contracts/abis';
import { getPublicClient, getExplorerUrl } from '@/lib/chain';

const WETH = UNISWAP_V2_SEPOLIA.weth;
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as `0x${string}`;
const ZERO = '0x0000000000000000000000000000000000000000' as `0x${string}`;

export default function SwapPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const [from, setFrom] = useState(ZERO);
  const [to, setTo] = useState(USDC);
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<bigint | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [error, setError] = useState('');
  const [marketPrice, setMarketPrice] = useState<number | null>(null);
  const [marketPriceLoading, setMarketPriceLoading] = useState(false);

  const isLocal = chainKeyForId(chainId) === 'hardhat';
  const isSepolia = chainKeyForId(chainId) === 'sepolia';
  const isUnsupported = !isLocal && !isSepolia;

  const tokens = useMemo(() => {
    const key = chainKeyForId(chainId);
    const list = TOKENS[key] ? Object.entries(TOKENS[key]).map(([addr, t]) => ({
      address: addr as `0x${string}`,
      symbol: t.symbol,
      decimals: t.decimals,
    })) : [];
    return list.length > 0 ? list : [{ address: ZERO as `0x${string}`, symbol: 'ETH', decimals: 18 }];
  }, [chainId]);

  const fromInfo = getTokenInfo(chainKeyForId(chainId), from);
  const toInfo = getTokenInfo(chainKeyForId(chainId), to);

  useEffect(() => {
    const key = chainKeyForId(chainId);
    const entries = TOKENS[key] ? Object.entries(TOKENS[key]) : [];
    if (entries.length > 1 && !entries.some(([a]) => a === to)) setTo(entries[1][0] as `0x${string}`);
    if (entries.length > 0 && !entries.some(([a]) => a === from)) setFrom(entries[0][0] as `0x${string}`);
  }, [chainId, to, from]);

  const isEthIn = from === ZERO;
  const path = useMemo(() => (isEthIn ? [WETH, USDC] : [USDC, WETH]), [isEthIn]);

  const amountIn = useMemo(() => {
    if (!amount || Number(amount) <= 0) return 0n;
    return isEthIn ? parseEther(amount) : parseUnits(amount, 6);
  }, [amount, isEthIn]);

  const client = useMemo(() => getPublicClient(chainId), [chainId]);

  const fetchQuote = useCallback(async () => {
    setQuote(null);
    setError('');
    if (!isSepolia || amountIn <= 0n || !client) return;
    setQuoteLoading(true);
    try {
      const amounts = await client.readContract({
        address: UNISWAP_V2_SEPOLIA.router,
        abi: uniswapV2RouterABI,
        functionName: 'getAmountsOut',
        args: [amountIn, path],
      });
      setQuote((amounts as bigint[])[amounts.length - 1] ?? null);
    } catch (e: any) {
      setError(e?.shortMessage || 'No liquidity for this pair.');
    }
    setQuoteLoading(false);
  }, [isSepolia, amountIn, path, client]);

  useEffect(() => {
    if (!isSepolia) return;
    const t = setTimeout(fetchQuote, 400);
    return () => clearTimeout(t);
  }, [isSepolia, fetchQuote]);

  const { data: ethBalance } = useBalance({ address });
  const { data: tokenBalance } = useReadContract({
    address: from,
    abi: erc20ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !isEthIn && !!from },
  });
  const fromBalanceRaw = isEthIn ? ethBalance?.value : tokenBalance;
  const fromBalanceLabel = useMemo(() => {
    if (!address || fromBalanceRaw === undefined || fromBalanceRaw === null) return '';
    return `${Number(formatUnits(fromBalanceRaw, fromInfo.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${fromInfo.symbol}`;
  }, [address, fromBalanceRaw, fromInfo]);
  const setMax = () => {
    if (fromBalanceRaw === undefined || fromBalanceRaw === null || fromBalanceRaw === 0n) return;
    setAmount(formatUnits(fromBalanceRaw, fromInfo.decimals));
  };

  const [allowance, setAllowance] = useState<bigint | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (isSepolia && !isEthIn && address && client) {
      client.readContract({
        address: from,
        abi: erc20ABI,
        functionName: 'allowance',
        args: [address, UNISWAP_V2_SEPOLIA.router],
      }).then((v) => { if (!cancelled) setAllowance(v as bigint); }).catch(() => {});
    } else {
      setAllowance(null);
    }
    return () => { cancelled = true; };
  }, [isSepolia, isEthIn, address, client, from]);

  const needsApprove = !isEthIn && allowance !== null && allowance < amountIn;
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

  const minOut = quote !== null ? (quote * 995n) / 1000n : 0n;

  const write = useWriteContract();
  const txHash = write.data as `0x${string}` | undefined;
  const receipt = useWaitForTransactionReceipt({ hash: txHash });

  const swap = async () => {
    if (!address || quote === null) return;
    setError('');
    try {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
      if (isEthIn) {
        await write.writeContract({
          address: UNISWAP_V2_SEPOLIA.router,
          abi: uniswapV2RouterABI,
          functionName: 'swapExactETHForTokens',
          args: [minOut, path, address, deadline],
          value: amountIn,
        });
      } else {
        await write.writeContract({
          address: UNISWAP_V2_SEPOLIA.router,
          abi: uniswapV2RouterABI,
          functionName: 'swapExactTokensForETH',
          args: [amountIn, minOut, path, address, deadline],
        });
      }
    } catch (e: any) {
      setError(e?.shortMessage || e?.message || 'Swap failed');
    }
  };

  const approve = async () => {
    setError('');
    try {
      await write.writeContract({
        address: from,
        abi: erc20ABI,
        functionName: 'approve',
        args: [UNISWAP_V2_SEPOLIA.router, amountIn],
      });
    } catch (e: any) {
      setError(e?.shortMessage || e?.message || 'Approval failed');
    }
  };

  const busy = write.isPending || receipt.isLoading;
  const explorerUrl = txHash ? getExplorerUrl(chainId, 'tx', txHash) : null;

  const flip = () => { const f = from; setFrom(to); setTo(f); setAmount(''); setQuote(null); };

  // Picking the same token on both sides used to leave from === to, and the
  // receive select (which hides the from-token) then displayed a label that
  // didn't match the actual output token. Swapping the two instead keeps the
  // pair always valid — same as Uniswap.
  const pickFrom = (v: string) => {
    if (v === to) { flip(); return; }
    setFrom(v as `0x${string}`);
  };
  const pickTo = (v: string) => {
    if (v === from) { flip(); return; }
    setTo(v as `0x${string}`);
  };

  const outValue = useMemo(() => {
    if (quote !== null) return formatUnits(quote, toInfo.decimals);
    if (marketValue) return String(marketValue.outUsdc);
    return null;
  }, [quote, marketValue, toInfo]);
  const outDisplay = outValue ? Number(outValue).toLocaleString(undefined, { maximumFractionDigits: 4 }) : '0';

  return (
    <div className="relative min-h-screen overflow-hidden">
      <img src="/rose-gold-bg.svg" alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover opacity-15 blur-sm" />
      <div className="absolute inset-0 bg-gradient-to-b from-zinc-950/60 via-zinc-950/40 to-zinc-950 pointer-events-none" />
      <div className="relative max-w-lg mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white">Swap</h1>
      </div>

      {isUnsupported && (
        <div className="p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-sm text-amber-400 flex items-center gap-2">
          <AlertTriangle size={14} /> Swaps are available on the Sepolia testnet. Switch your wallet network.
        </div>
      )}

      {!isConnected ? (
        <div className="rounded-3xl border border-zinc-800/80 bg-zinc-950/60 py-16 text-center">
          <p className="text-zinc-500">Connect your wallet to swap tokens.</p>
        </div>
      ) : (
        <>
          {/* You pay */}
          <div className="relative rounded-3xl border border-zinc-800/80 bg-zinc-950/80 p-5">
            <p className="text-[11px] uppercase tracking-wider text-zinc-600 mb-3">You pay</p>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <TokenIcon symbol={fromInfo.symbol} size={44} />
                <div className="min-w-0">
                  <select
                    value={from}
                    onChange={(e) => pickFrom(e.target.value)}
                    className="block bg-transparent font-bold text-lg text-white outline-none cursor-pointer [&>option]:bg-zinc-900"
                  >
                    {tokens.map((t) => (
                      <option key={t.address} value={t.address}>{t.symbol}</option>
                    ))}
                  </select>
                  <p className="text-xs text-zinc-500 truncate">{fromBalanceLabel || `${fromInfo.symbol} balance`}</p>
                </div>
              </div>
              <button
                onClick={setMax}
                disabled={!fromBalanceRaw || fromBalanceRaw === 0n}
                className="px-3.5 py-1.5 rounded-full border border-zinc-700 bg-zinc-900/80 text-xs font-medium text-zinc-300 hover:border-zinc-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
              >
                Use Max
              </button>
            </div>

            <input
              type="number"
              min="0"
              step="any"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-7 w-full bg-transparent text-center text-5xl font-bold text-white placeholder-zinc-700 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />

            <div className="mt-4 flex items-center justify-center gap-2">
              <span className="w-5 h-5 rounded-full bg-zinc-800 flex items-center justify-center text-[10px] text-zinc-400">=</span>
              <span className="text-sm text-zinc-400">
                {marketPriceLoading ? (
                  <Loader2 size={12} className="animate-spin inline" />
                ) : marketValue ? (
                  `$${marketValue.usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                ) : (
                  '$0.00'
                )}
              </span>
              <button
                onClick={flip}
                title="Reverse direction"
                className="ml-1 p-1 rounded-md text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors"
              >
                <ArrowUpDown size={14} />
              </button>
            </div>
          </div>

          {/* Divider */}
          <div className="relative z-10 flex justify-center -my-5">
            <button
              onClick={flip}
              title="Reverse direction"
              className="p-2.5 rounded-xl bg-zinc-900 border border-zinc-700 text-zinc-400 hover:text-white hover:border-blue-500/50 transition-colors shadow-lg shadow-black/40"
            >
              <ChevronDown size={16} />
            </button>
          </div>

          {/* You receive */}
          <div className="rounded-3xl border border-zinc-800/80 bg-zinc-950/80 p-5">
            <p className="text-[11px] uppercase tracking-wider text-zinc-600 mb-3">You receive</p>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <TokenIcon symbol={toInfo.symbol} size={44} />
                <div className="min-w-0">
                  <select
                    value={to}
                    onChange={(e) => pickTo(e.target.value)}
                    className="block bg-transparent font-bold text-lg text-white outline-none cursor-pointer [&>option]:bg-zinc-900"
                  >
                    {tokens.filter((t) => t.address !== from).map((t) => (
                      <option key={t.address} value={t.address}>{t.symbol}</option>
                    ))}
                  </select>
                  <p className="text-xs text-zinc-500 truncate">Receive {toInfo.symbol}{quote === null && marketValue ? ' · estimated' : ''}</p>
                </div>
              </div>
              <span className="text-3xl font-bold text-white tabular-nums break-all text-right">
                {quoteLoading ? <Loader2 size={20} className="animate-spin text-zinc-600 inline-block" /> : outDisplay}
              </span>
            </div>

            {(quote !== null || marketValue) && (
              <div className="mt-3 space-y-0.5 text-right">
                {quote !== null && (
                  <p className="text-[11px] text-zinc-600">
                    Pool quote · min received {Number(formatUnits(minOut, toInfo.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {toInfo.symbol} (0.5% slippage)
                  </p>
                )}
                {marketValue && quote === null && (
                  <p className="text-[11px] text-zinc-600">{marketValue.label}</p>
                )}
                {marketValue && quote !== null && (() => {
                  const poolVal = isEthIn ? Number(quote) / 1e6 : Number(quote) / 1e18;
                  const liveVal = marketValue.outUsdc;
                  const diffPct = Math.abs((poolVal - liveVal) / liveVal) * 100;
                  if (diffPct > 5) {
                    return (
                      <p className="text-[11px] text-amber-400/90">
                        Testnet pool price differs from live market ({diffPct.toFixed(0)}%) — you receive what the pool offers.
                      </p>
                    );
                  }
                  return null;
                })()}
              </div>
            )}
          </div>

          <button
            onClick={() => { setAmount(''); setQuote(null); }}
            className="w-full py-3 rounded-2xl bg-zinc-900/70 border border-zinc-800/60 text-sm text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors"
          >
            Clear
          </button>

          {error && <p className="text-xs text-amber-400 px-1">{error}</p>}

          {txHash && receipt.isSuccess && (
            <div className="p-3 rounded-xl border border-green-500/20 bg-green-600/10 flex items-center gap-2">
              <CheckCircle size={16} className="text-green-400" />
              <span className="text-sm text-green-400">Swap confirmed!</span>
              {explorerUrl && <a href={explorerUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:text-blue-300 ml-auto">View on Etherscan <ExternalLink size={12} className="inline" /></a>}
            </div>
          )}

          {isSepolia && needsApprove ? (
            <Button onClick={approve} disabled={busy} className="w-full h-13 font-semibold text-base rounded-2xl">
              {busy ? <Loader2 size={18} className="animate-spin" /> : `Approve ${fromInfo.symbol}`}
            </Button>
          ) : (
            <Button onClick={swap} disabled={!isSepolia || quote === null || !amount || Number(amount) <= 0 || busy || from === to} className="w-full h-13 font-semibold text-base rounded-2xl">
              {busy ? <Loader2 size={18} className="animate-spin" /> : from === to ? 'Select different tokens' : !isSepolia ? (isLocal ? 'Swaps are disabled on local network — use Sepolia' : 'Connect on Sepolia to swap') : quote === null ? 'Enter an amount' : `Swap ${fromInfo.symbol} for ${toInfo.symbol}`}
            </Button>
          )}
        </>
      )}
    </div>
    </div>
  );
}