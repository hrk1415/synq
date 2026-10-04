const EVM_WALLET = /^0x[0-9a-fA-F]{40}$/;

export interface CanonicalConversationPair {
  participantA: string;
  participantB: string;
}

/** Canonical neutral identity for one distinct wallet-to-wallet conversation. */
export function canonicalizeConversationPair(walletA: unknown, walletB: unknown): CanonicalConversationPair {
  if (typeof walletA !== 'string' || typeof walletB !== 'string' || !EVM_WALLET.test(walletA) || !EVM_WALLET.test(walletB)) {
    throw new Error('Two valid wallet addresses are required');
  }

  const first = walletA.toLowerCase();
  const second = walletB.toLowerCase();
  if (first === second) throw new Error('You cannot create a conversation with yourself');

  // Valid normalized wallets contain equal-length ASCII hex digits. Comparing
  // those strings is equivalent to comparing the decoded address bytes, which
  // is the collation-independent rule enforced by PostgreSQL.
  return first < second
    ? { participantA: first, participantB: second }
    : { participantA: second, participantB: first };
}

export function isConversationParticipant(
  conversation: { participantA?: unknown; participantB?: unknown },
  wallet: string,
): boolean {
  const normalized = wallet.toLowerCase();
  return conversation.participantA === normalized || conversation.participantB === normalized;
}
