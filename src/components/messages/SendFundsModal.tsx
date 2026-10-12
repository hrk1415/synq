'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { decodeEventLog, parseEther, parseUnits } from 'viem';
import { useSendTransaction, useWriteContract } from 'wagmi';
import { ExternalLink, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { shortenAddress } from '@/lib/utils';
import { getSepoliaExplorerUrl, sepoliaPublicClient } from '@/lib/chain';
import { TOKENS } from '@/lib/contracts/addresses';
import { useSepoliaNetwork } from '@/hooks/useSepoliaNetwork';
import { normalizePaymentNote } from '@/lib/synq-message';

type PaymentAsset = 'ETH' | 'USDC';
type Target = { conversationId?: string; toWallet?: string };
type AuthenticatedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const TRANSFER_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'event', name: 'Transfer', inputs: [{ indexed: true, name: 'from', type: 'address' }, { indexed: true, name: 'to', type: 'address' }, { indexed: false, name: 'value', type: 'uint256' }] },
] as const;
const USDC_ADDRESS = Object.keys(TOKENS.sepolia).find((address) => TOKENS.sepolia[address].symbol === 'USDC') as `0x${string}`;
const lc = (value: string) => value.toLowerCase();

function parseAmount(input: string, asset: PaymentAsset): bigint {
  const decimals = asset === 'ETH' ? 18 : 6;
  const value = input.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) throw new Error('Enter a valid amount.');
  const fraction = value.split('.')[1] || '';
  if (fraction.length > decimals) throw new Error(`${asset} supports up to ${decimals} decimal places.`);
  const parsed = asset === 'ETH' ? parseEther(value) : parseUnits(value, 6);
  if (parsed <= 0n) throw new Error('Amount must be greater than zero.');
  return parsed;
}

export function SendFundsModal({
  open,
  onClose,
  fromWallet,
  toWallet,
  recipientLabel,
  target,
  authenticatedFetch,
  onSynced,
}: {
  open: boolean;
  onClose: () => void;
  fromWallet: string;
  toWallet: string;
  recipientLabel: string;
  target: Target;
  authenticatedFetch: AuthenticatedFetch;
  onSynced: (result: any) => Promise<void> | void;
}) {
  const [asset, setAsset] = useState<PaymentAsset>('ETH');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [status, setStatus] = useState<'idle' | 'confirming' | 'syncing' | 'sent-unsynced' | 'submitted-unconfirmed'>('idle');
  const [error, setError] = useState('');
  const [transactionHash, setTransactionHash] = useState('');
  const [confirmedLogIndex, setConfirmedLogIndex] = useState<number | undefined>();
  const [confirmedNote, setConfirmedNote] = useState<string | undefined>();
  const operationRef = useRef(0);
  const { ensureSepolia } = useSepoliaNetwork();
  const sendTransaction = useSendTransaction();
  const writeContract = useWriteContract();
  const parsedAmount = useMemo(() => {
    try { return parseAmount(amount, asset); } catch { return null; }
  }, [amount, asset]);

  useEffect(() => () => { operationRef.current += 1; }, []);

  if (!open) return null;

  const resetAndClose = () => {
    if (status === 'confirming' || status === 'syncing') return;
    operationRef.current += 1;
    setAsset('ETH'); setAmount(''); setNote(''); setReviewing(false); setError(''); setStatus('idle'); setTransactionHash(''); setConfirmedLogIndex(undefined); setConfirmedNote(undefined);
    onClose();
  };

  const syncReceipt = async (hash: string, logIndex: number | undefined, paymentNote: string | undefined, operation: number) => {
    setStatus('syncing');
    try {
      const response = await authenticatedFetch('/api/messages/payment-receipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionHash: hash, asset, ...target, ...(logIndex === undefined ? {} : { transferLogIndex: logIndex }), ...(paymentNote === undefined ? {} : { note: paymentNote }) }),
      });
      const contentType = response.headers.get('content-type') || '';
      const data = contentType.includes('application/json') ? await response.json().catch(() => null) : null;
      if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Receipt synchronization failed.');
      if (operationRef.current !== operation) return;
      await onSynced(data);
      resetAndClose();
    } catch {
      if (operationRef.current !== operation) return;
      setStatus('sent-unsynced');
      setError('Payment sent successfully, but its receipt could not be synced to SynqChat.');
    }
  };

  const submit = async () => {
    const operation = ++operationRef.current;
    const initiatingWallet = lc(fromWallet);
    const recipient = lc(toWallet) as `0x${string}`;
    let value: bigint;
    let paymentConfirmed = false;
    try { value = parseAmount(amount, asset); } catch (validationError: any) { setError(validationError.message); return; }
    let paymentNote: string | undefined;
    try { paymentNote = normalizePaymentNote(note); } catch (validationError: any) { setError(validationError.message); return; }
    setConfirmedNote(paymentNote);
    setError('');
    try {
      await ensureSepolia();
      setStatus('confirming');
      const hash = asset === 'ETH'
        ? await sendTransaction.sendTransactionAsync({ to: recipient, value })
        : await writeContract.writeContractAsync({ address: USDC_ADDRESS, abi: TRANSFER_ABI, functionName: 'transfer', args: [recipient, value] });
      if (operationRef.current !== operation) return;
      setTransactionHash(hash);
      let receipt;
      try {
        receipt = await sepoliaPublicClient.waitForTransactionReceipt({ hash });
      } catch {
        if (operationRef.current !== operation) return;
        setStatus('submitted-unconfirmed');
        setError('Payment was submitted, but confirmation could not be verified yet.');
        return;
      }
      if (operationRef.current !== operation) return;
      if (receipt.status !== 'success') throw new Error('Payment failed.');
      paymentConfirmed = true;

      let transferLogIndex: number | undefined;
      if (asset === 'USDC') {
        const matching = receipt.logs.filter((log) => {
          if (lc(log.address) !== lc(USDC_ADDRESS)) return false;
          try {
            const decoded = decodeEventLog({ abi: TRANSFER_ABI, eventName: 'Transfer', data: log.data, topics: log.topics });
            return lc(decoded.args.from) === initiatingWallet && lc(decoded.args.to) === recipient && decoded.args.value === value;
          } catch { return false; }
        });
        if (matching.length !== 1 || matching[0].logIndex === null) {
          setStatus('sent-unsynced');
          setError('Payment sent successfully, but its receipt could not be synced to SynqChat.');
          return;
        }
        transferLogIndex = matching[0].logIndex;
        setConfirmedLogIndex(transferLogIndex);
      }
      await syncReceipt(hash, transferLogIndex, paymentNote, operation);
    } catch (submitError: any) {
      if (operationRef.current !== operation) return;
      const message = String(submitError?.shortMessage || submitError?.message || 'Payment could not be sent.');
      const rejected = /user rejected|user denied|rejected transaction/i.test(message);
      if (paymentConfirmed) {
        setStatus('sent-unsynced');
        setError('Payment sent successfully, but its receipt could not be synced to SynqChat.');
      } else {
        setStatus('idle');
        setError(rejected ? 'Payment not sent.' : message === 'Payment failed.' ? message : 'Payment could not be sent.');
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Send funds">
      <div className="w-full max-w-md rounded-2xl border border-zinc-700/70 bg-zinc-950 p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div><h2 className="text-lg font-semibold text-white">Send funds</h2><p className="text-xs text-zinc-500">Ethereum Sepolia</p></div>
          <button type="button" onClick={resetAndClose} disabled={status === 'confirming' || status === 'syncing'} className="text-zinc-400 hover:text-white disabled:opacity-40"><X size={18} /></button>
        </div>
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
          <p className="text-[10px] uppercase tracking-wide text-zinc-500">Recipient</p>
          <p className="mt-1 text-sm font-medium text-white">{recipientLabel}</p>
          <p className="text-xs text-zinc-500">{shortenAddress(toWallet)}</p>
        </div>
        {!reviewing ? (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-2">
              {(['ETH', 'USDC'] as const).map((option) => <button key={option} type="button" onClick={() => { setAsset(option); setError(''); }} className={`rounded-xl border px-3 py-2 text-sm ${asset === option ? 'border-blue-500 bg-blue-600/15 text-white' : 'border-zinc-700 text-zinc-400'}`}>{option}</button>)}
            </div>
            <div><label className="mb-1 block text-xs text-zinc-400">Amount</label><input value={amount} onChange={(event) => { setAmount(event.target.value); setError(''); }} inputMode="decimal" placeholder="0.00" className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-white outline-none focus:border-blue-500" /></div>
            <div>
              <div className="mb-1 flex items-center justify-between"><label className="text-xs text-zinc-400">Add a note (optional)</label><span className="text-[10px] text-zinc-600">{note.length}/160</span></div>
              <input value={note} onChange={(event) => { setNote(event.target.value); setError(''); }} maxLength={160} placeholder="Thanks for the frontend work" className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-blue-500" />
            </div>
            <Button type="button" className="w-full" disabled={!parsedAmount} onClick={() => { try { parseAmount(amount, asset); const normalizedNote = normalizePaymentNote(note); setNote(normalizedNote || ''); setReviewing(true); setError(''); } catch (e: any) { setError(e.message); } }}>Review payment</Button>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm"><div className="flex justify-between"><span className="text-zinc-500">Amount</span><span className="font-medium text-white">{amount} {asset}</span></div><div className="mt-2 flex justify-between"><span className="text-zinc-500">Network</span><span className="text-zinc-200">Sepolia</span></div>{note && <div className="mt-3 border-t border-zinc-800 pt-3"><p className="text-xs text-zinc-500">Note</p><p className="mt-1 break-words text-xs text-zinc-300">{note}</p></div>}<p className="mt-3 text-xs text-zinc-500">Your wallet will show the final network fee before confirmation.</p></div>
            {status === 'idle' && <div className="flex gap-2"><Button type="button" variant="outline" className="flex-1" onClick={() => setReviewing(false)}>Back</Button><Button type="button" className="flex-1" onClick={submit}>Confirm in wallet</Button></div>}
            {(status === 'confirming' || status === 'syncing') && <div className="flex items-center justify-center gap-2 py-2 text-sm text-zinc-300"><Loader2 size={16} className="animate-spin" />{status === 'confirming' ? 'Confirming…' : 'Syncing receipt…'}</div>}
          </div>
        )}
        {error && <p className={`mt-3 text-xs ${status === 'sent-unsynced' || status === 'submitted-unconfirmed' ? 'text-amber-300' : 'text-red-300'}`}>{error}</p>}
        {transactionHash && (status === 'sent-unsynced' || status === 'submitted-unconfirmed') && (
          <div className="mt-3 flex items-center gap-3">
            {status === 'sent-unsynced' && <button type="button" onClick={() => { const operation = ++operationRef.current; void syncReceipt(transactionHash, confirmedLogIndex, confirmedNote, operation); }} className="text-xs text-blue-300 hover:text-blue-200">Retry receipt sync</button>}
            <a href={getSepoliaExplorerUrl('tx', transactionHash)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-blue-300 hover:text-blue-200">View transaction <ExternalLink size={12} /></a>
          </div>
        )}
      </div>
    </div>
  );
}
