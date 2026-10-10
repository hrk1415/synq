import { NextRequest } from 'next/server';
import { decodeEventLog, isAddress, type Hex } from 'viem';
import { getAuthenticatedWallet, unauthorized } from '@/lib/auth';
import { sepoliaPublicClient } from '@/lib/chain';
import { nexotiqDealABI, nexotiqFactoryABI } from '@/lib/contracts/abis';
import { CONTRACT_ADDRESSES, SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';
import { createCanonicalDealReceiptMessage } from '@/lib/db';
import { isSynqPaymentStructure, validateDealReceiptPayload, type SynqDealReceiptPayload } from '@/lib/synq-message';

export const runtime = 'nodejs';

const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const normalizeAddress = (value: unknown) => String(value || '').toLowerCase();

export async function POST(req: NextRequest) {
  const authenticatedWallet = getAuthenticatedWallet(req);
  if (!authenticatedWallet) return unauthorized();

  try {
    const body = await req.json();
    const transactionHash = String(body?.transactionHash || '').trim().toLowerCase();
    if (!TRANSACTION_HASH.test(transactionHash)) {
      return Response.json({ error: 'A valid Deal transaction hash is required' }, { status: 400 });
    }
    const paymentStructure = body?.paymentStructure;
    if (paymentStructure !== undefined && !isSynqPaymentStructure(paymentStructure)) {
      return Response.json({ error: 'Invalid Deal payment structure' }, { status: 400 });
    }

    let receipt;
    try {
      receipt = await sepoliaPublicClient.getTransactionReceipt({ hash: transactionHash as Hex });
    } catch {
      return Response.json({ error: 'Confirmed Deal transaction was not found on Sepolia' }, { status: 404 });
    }
    if (receipt.status !== 'success') {
      return Response.json({ error: 'The Deal transaction did not succeed' }, { status: 422 });
    }

    const factoryAddress = CONTRACT_ADDRESSES.sepolia.NexotiqFactory.toLowerCase();
    let eventArgs: any = null;
    for (const log of receipt.logs) {
      if (normalizeAddress(log.address) !== factoryAddress) continue;
      try {
        const decoded = decodeEventLog({
          abi: nexotiqFactoryABI,
          eventName: 'DealCreated',
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'DealCreated') {
          if (eventArgs) {
            return Response.json({ error: 'Transaction contains multiple Deal creation events' }, { status: 422 });
          }
          eventArgs = decoded.args;
        }
      } catch {
        // Other Factory events in the same receipt are not Deal creation proof.
      }
    }
    if (!eventArgs) {
      return Response.json({ error: 'Verified Factory DealCreated event was not found' }, { status: 422 });
    }

    const dealAddress = normalizeAddress(eventArgs.dealAddress);
    const buyer = normalizeAddress(eventArgs.buyer);
    const seller = normalizeAddress(eventArgs.seller);
    if (!isAddress(dealAddress) || !isAddress(buyer) || !isAddress(seller) || buyer === seller) {
      return Response.json({ error: 'Factory event contains invalid Deal participants' }, { status: 422 });
    }
    if (authenticatedWallet !== buyer) {
      return Response.json({ error: 'Only the verified Deal buyer can create this receipt' }, { status: 403 });
    }

    const dealContract = { address: dealAddress as `0x${string}`, abi: nexotiqDealABI } as const;
    let dealState;
    try {
      dealState = await Promise.all([
        sepoliaPublicClient.readContract({ ...dealContract, functionName: 'factory' }),
        sepoliaPublicClient.readContract({ ...dealContract, functionName: 'buyer' }),
        sepoliaPublicClient.readContract({ ...dealContract, functionName: 'seller' }),
        sepoliaPublicClient.readContract({ ...dealContract, functionName: 'title' }),
        sepoliaPublicClient.readContract({ ...dealContract, functionName: 'description' }),
        sepoliaPublicClient.readContract({ ...dealContract, functionName: 'totalValue' }),
        sepoliaPublicClient.readContract({ ...dealContract, functionName: 'asset' }),
        sepoliaPublicClient.readContract({ ...dealContract, functionName: 'deadline' }),
        sepoliaPublicClient.readContract({ ...dealContract, functionName: 'protectionEnabled' }),
      ]);
    } catch {
      return Response.json({ error: 'Could not verify the created Deal contract' }, { status: 502 });
    }

    const [contractFactory, contractBuyer, contractSeller, title, scope, totalValue, assetAddress, deadline, protectionEnabled] = dealState;
    if (normalizeAddress(contractFactory) !== factoryAddress) {
      return Response.json({ error: 'Deal contract does not belong to the configured Synq Factory' }, { status: 422 });
    }
    const normalizedContractBuyer = normalizeAddress(contractBuyer);
    const normalizedContractSeller = normalizeAddress(contractSeller);
    const eventValue = BigInt(eventArgs.value);
    const contractValue = BigInt(totalValue as bigint);
    if (
      normalizedContractBuyer !== buyer
      || normalizedContractSeller !== seller
      || eventValue !== contractValue
    ) {
      return Response.json({ error: 'Factory event and Deal contract state do not match' }, { status: 422 });
    }

    const payload = validateDealReceiptPayload({
      dealAddress,
      chainId: SEPOLIA_CHAIN_ID,
      transactionHash,
      title: String(title),
      scope: String(scope),
      totalValue: contractValue.toString(),
      assetAddress: normalizeAddress(assetAddress),
      deadline: BigInt(deadline as bigint).toString(),
      protectionEnabled: Boolean(protectionEnabled),
      factoryDealId: BigInt(eventArgs.dealId).toString(),
      ...(paymentStructure === undefined ? {} : { paymentStructure }),
    } satisfies SynqDealReceiptPayload);

    const result = await createCanonicalDealReceiptMessage({
      buyerWallet: buyer,
      sellerWallet: seller,
      payload,
    });
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    console.error('[synqchat-deal-receipt] persistence failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return Response.json({ error: 'Could not save the Deal receipt to SynqChat' }, { status: 500 });
  }
}
