import { NextRequest } from 'next/server';
import { decodeEventLog, isAddress, type Hex } from 'viem';
import { getAuthenticatedWallet, unauthorized } from '@/lib/auth';
import { sepoliaPublicClient } from '@/lib/chain';
import { SEPOLIA_CHAIN_ID, TOKENS } from '@/lib/contracts/addresses';
import { createCanonicalPaymentReceiptMessage, getById } from '@/lib/db';
import { normalizePaymentNote, validatePaymentReceiptPayload, type SynqPaymentReceiptPayload } from '@/lib/synq-message';

export const runtime = 'nodejs';

const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/;
const TRANSFER_EVENT = [{
  type: 'event',
  name: 'Transfer',
  inputs: [
    { indexed: true, name: 'from', type: 'address' },
    { indexed: true, name: 'to', type: 'address' },
    { indexed: false, name: 'value', type: 'uint256' },
  ],
}] as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const USDC_ADDRESS = Object.keys(TOKENS.sepolia).find((address) => TOKENS.sepolia[address].symbol === 'USDC')?.toLowerCase() || '';
const normalizeAddress = (value: unknown) => String(value || '').toLowerCase();

export async function POST(req: NextRequest) {
  const authenticatedWallet = getAuthenticatedWallet(req);
  if (!authenticatedWallet) return unauthorized();

  try {
    const body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'A valid payment receipt request is required' }, { status: 400 });
    }
    const allowedKeys = ['transactionHash', 'asset', 'conversationId', 'toWallet', 'transferLogIndex', 'note'];
    if (Object.keys(body).some((key) => !allowedKeys.includes(key))) {
      return Response.json({ error: 'Payment receipt request contains unsupported fields' }, { status: 400 });
    }
    const transactionHash = typeof body?.transactionHash === 'string' ? body.transactionHash.trim().toLowerCase() : '';
    const asset = body?.asset;
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId.trim() : '';
    const requestedToWallet = typeof body?.toWallet === 'string' ? body.toWallet.trim().toLowerCase() : '';
    const transferLogIndex = body?.transferLogIndex;
    let note: string | undefined;
    try {
      note = normalizePaymentNote(body?.note);
    } catch {
      return Response.json({ error: 'Invalid payment note' }, { status: 400 });
    }

    if (!TRANSACTION_HASH.test(transactionHash)) {
      return Response.json({ error: 'A valid payment transaction hash is required' }, { status: 400 });
    }
    if (asset !== 'ETH' && asset !== 'USDC') {
      return Response.json({ error: 'Unsupported payment asset' }, { status: 400 });
    }
    if (!!conversationId === !!requestedToWallet) {
      return Response.json({ error: 'Provide exactly one payment conversation target' }, { status: 400 });
    }
    if (asset === 'ETH' && transferLogIndex !== undefined) {
      return Response.json({ error: 'ETH payments cannot include a transfer log index' }, { status: 400 });
    }
    if (asset === 'USDC' && (!Number.isSafeInteger(transferLogIndex) || transferLogIndex < 0)) {
      return Response.json({ error: 'USDC payments require a valid transfer log index' }, { status: 400 });
    }

    let toWallet = requestedToWallet;
    if (conversationId) {
      const conversation = await getById('conversations', conversationId);
      if (!conversation) return Response.json({ error: 'Conversation not found' }, { status: 404 });
      const participantA = normalizeAddress(conversation.participantA);
      const participantB = normalizeAddress(conversation.participantB);
      if (authenticatedWallet !== participantA && authenticatedWallet !== participantB) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
      toWallet = authenticatedWallet === participantA ? participantB : participantA;
    }
    if (!isAddress(toWallet) || toWallet === authenticatedWallet) {
      return Response.json({ error: 'A valid counterparty wallet is required' }, { status: 400 });
    }

    let receipt;
    try {
      receipt = await sepoliaPublicClient.getTransactionReceipt({ hash: transactionHash as Hex });
    } catch {
      return Response.json({ error: 'Confirmed payment transaction was not found on Sepolia' }, { status: 404 });
    }
    if (receipt.status !== 'success') {
      return Response.json({ error: 'The payment transaction did not succeed' }, { status: 422 });
    }

    let payload: SynqPaymentReceiptPayload;
    if (asset === 'ETH') {
      let transaction;
      try {
        transaction = await sepoliaPublicClient.getTransaction({ hash: transactionHash as Hex });
      } catch {
        return Response.json({ error: 'Could not verify the ETH payment transaction' }, { status: 502 });
      }
      if (
        normalizeAddress(transaction.from) !== authenticatedWallet
        || normalizeAddress(transaction.to) !== toWallet
        || transaction.value <= 0n
        || (transaction.input !== '0x' && transaction.input !== undefined)
      ) {
        return Response.json({ error: 'The confirmed transaction is not a supported direct ETH payment' }, { status: 422 });
      }
      payload = validatePaymentReceiptPayload({
        transactionHash,
        chainId: SEPOLIA_CHAIN_ID,
        assetType: 'native',
        assetAddress: ZERO_ADDRESS,
        amount: transaction.value.toString(),
        decimals: 18,
        symbol: 'ETH',
        ...(note === undefined ? {} : { note }),
      });
    } else {
      if (!USDC_ADDRESS || !isAddress(USDC_ADDRESS)) throw new Error('Sepolia USDC is not configured');
      const selectedLogs = receipt.logs.filter((log) => log.logIndex === transferLogIndex);
      if (selectedLogs.length !== 1) {
        return Response.json({ error: 'The selected USDC transfer log was not found' }, { status: 422 });
      }
      const selectedLog = selectedLogs[0];
      if (normalizeAddress(selectedLog.address) !== USDC_ADDRESS) {
        return Response.json({ error: 'The selected log was not emitted by configured Sepolia USDC' }, { status: 422 });
      }
      let decoded;
      try {
        decoded = decodeEventLog({ abi: TRANSFER_EVENT, eventName: 'Transfer', data: selectedLog.data, topics: selectedLog.topics });
      } catch {
        return Response.json({ error: 'The selected log is not a valid USDC transfer' }, { status: 422 });
      }
      const from = normalizeAddress(decoded.args.from);
      const to = normalizeAddress(decoded.args.to);
      const value = decoded.args.value;
      if (from !== authenticatedWallet || to !== toWallet || value <= 0n) {
        return Response.json({ error: 'The USDC transfer does not match this SynqChat payment' }, { status: 422 });
      }
      const matchingLogs = receipt.logs.filter((log) => {
        if (normalizeAddress(log.address) !== USDC_ADDRESS) return false;
        try {
          const candidate = decodeEventLog({ abi: TRANSFER_EVENT, eventName: 'Transfer', data: log.data, topics: log.topics });
          return normalizeAddress(candidate.args.from) === authenticatedWallet
            && normalizeAddress(candidate.args.to) === toWallet
            && candidate.args.value > 0n;
        } catch { return false; }
      });
      if (matchingLogs.length !== 1) {
        return Response.json({ error: 'The transaction contains multiple matching USDC transfers' }, { status: 422 });
      }
      payload = validatePaymentReceiptPayload({
        transactionHash,
        chainId: SEPOLIA_CHAIN_ID,
        assetType: 'erc20',
        assetAddress: USDC_ADDRESS,
        amount: value.toString(),
        decimals: 6,
        symbol: 'USDC',
        transferLogIndex,
        ...(note === undefined ? {} : { note }),
      });
    }

    const result = await createCanonicalPaymentReceiptMessage({
      fromWallet: authenticatedWallet,
      toWallet,
      payload,
    });
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    console.error('[synqchat-payment-receipt] persistence failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return Response.json({ error: 'Could not save the payment receipt to SynqChat' }, { status: 500 });
  }
}
