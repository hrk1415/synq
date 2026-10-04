import { loadEnvConfig } from '@next/env';
import { getDb, closeDb, schema } from '../src/db';

export async function verifyPostgresImport() {
  // Explicitly load .env.local configuration before database initialization
  loadEnvConfig(process.cwd());

  const db = getDb();

  // Query PostgreSQL read-only
  const usersList = await db.select().from(schema.users);
  const marketProfilesList = await db.select().from(schema.marketProfiles);
  const reviewsList = await db.select().from(schema.reviews);
  const conversationsList = await db.select().from(schema.conversations);
  const messagesList = await db.select().from(schema.messages);

  console.log('--- POSTGRES IMPORT VERIFICATION ---');
  console.log(`users: ${usersList.length}`);
  console.log(`marketProfiles: ${marketProfilesList.length}`);
  console.log(`reviews: ${reviewsList.length}`);
  console.log(`conversations: ${conversationsList.length}`);
  console.log(`messages: ${messagesList.length}`);

  let allChecksPassed = true;

  // Set of user wallets for relational checking
  const userWalletsSet = new Set(usersList.map((u) => String(u.walletAddress).toLowerCase()));

  // 1. Market Profile User References
  const marketProfilesUserRefsPass = marketProfilesList.every((m) =>
    userWalletsSet.has(String(m.walletAddress).toLowerCase())
  );
  if (!marketProfilesUserRefsPass) allChecksPassed = false;

  // 2. Review User References (Seller wallet must exist in users)
  const reviewUserRefsPass = reviewsList.every((r) =>
    userWalletsSet.has(String(r.sellerWallet).toLowerCase())
  );
  if (!reviewUserRefsPass) allChecksPassed = false;

  // 3. Message Conversation References
  const conversationIdsSet = new Set(conversationsList.map((c) => String(c.id)));
  const messageConvRefsPass = messagesList.every((msg) =>
    conversationIdsSet.has(String(msg.conversationId))
  );
  if (!messageConvRefsPass) allChecksPassed = false;

  // 4. Wallet Normalization Check (All wallet columns must be lowercase)
  let walletNormalizationPass = true;
  for (const u of usersList) {
    if (u.walletAddress !== u.walletAddress.toLowerCase()) walletNormalizationPass = false;
  }
  for (const m of marketProfilesList) {
    if (m.walletAddress !== m.walletAddress.toLowerCase()) walletNormalizationPass = false;
  }
  for (const r of reviewsList) {
    if (r.reviewerWallet !== r.reviewerWallet.toLowerCase()) walletNormalizationPass = false;
    if (r.sellerWallet !== r.sellerWallet.toLowerCase()) walletNormalizationPass = false;
  }
  for (const c of conversationsList) {
    if (c.buyerWallet !== c.buyerWallet.toLowerCase()) walletNormalizationPass = false;
    if (c.sellerWallet !== c.sellerWallet.toLowerCase()) walletNormalizationPass = false;
    if (c.lastMessageFrom && c.lastMessageFrom !== c.lastMessageFrom.toLowerCase()) walletNormalizationPass = false;
  }
  for (const msg of messagesList) {
    if (msg.fromWallet !== msg.fromWallet.toLowerCase()) walletNormalizationPass = false;
    if (msg.toWallet !== msg.toWallet.toLowerCase()) walletNormalizationPass = false;
  }
  if (!walletNormalizationPass) allChecksPassed = false;

  // 5. Review Rating Range Check (1 to 5 integer)
  const reviewRatingRangePass = reviewsList.every((r) =>
    Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5
  );
  if (!reviewRatingRangePass) allChecksPassed = false;

  // 6. Uniqueness Checks
  const marketWalletsSeen = new Set<string>();
  let marketUniquenessPass = true;
  for (const m of marketProfilesList) {
    const w = String(m.walletAddress).toLowerCase();
    if (marketWalletsSeen.has(w)) marketUniquenessPass = false;
    marketWalletsSeen.add(w);
  }

  const reviewDealsSeen = new Set<string>();
  let reviewUniquenessPass = true;
  for (const r of reviewsList) {
    const d = String(r.dealAddress).toLowerCase();
    if (reviewDealsSeen.has(d)) reviewUniquenessPass = false;
    reviewDealsSeen.add(d);
  }
  const uniquenessPass = marketUniquenessPass && reviewUniquenessPass;
  if (!uniquenessPass) allChecksPassed = false;

  console.log('\nIntegrity checks:');
  console.log(`- market profile user references: ${marketProfilesUserRefsPass ? 'PASS' : 'FAIL'}`);
  console.log(`- review user references: ${reviewUserRefsPass ? 'PASS' : 'FAIL'}`);
  console.log(`- message conversation references: ${messageConvRefsPass ? 'PASS' : 'FAIL'}`);
  console.log(`- wallet normalization: ${walletNormalizationPass ? 'PASS' : 'FAIL'}`);
  console.log(`- review rating range: ${reviewRatingRangePass ? 'PASS' : 'FAIL'}`);
  console.log(`- uniqueness checks: ${uniquenessPass ? 'PASS' : 'FAIL'}`);

  if (!allChecksPassed) {
    throw new Error('One or more structural integrity checks failed.');
  }
}

if (require.main === module) {
  (async () => {
    try {
      await verifyPostgresImport();
      console.log('\nPostgreSQL import verification completed successfully.');
    } catch (err: any) {
      console.error('\nVerification failed:', err?.message || 'Structural integrity validation failure.');
      process.exitCode = 1;
    } finally {
      await closeDb();
    }
  })();
}
