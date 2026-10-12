import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('SYNQ React Infinite-Render Bug Regression Suite', () => {
  const dealsPagePath = path.join(process.cwd(), 'src', 'app', 'deals', 'page.tsx');
  const authSessionPath = path.join(process.cwd(), 'src', 'hooks', 'useAuthSession.ts');
  const dealsContent = fs.readFileSync(dealsPagePath, 'utf8');
  const authContent = fs.readFileSync(authSessionPath, 'utf8');

  describe('1. useAuthSession Hook Stability', () => {
    it('getToken is memoized using useCallback to maintain referential identity across renders', () => {
      // Must use useCallback with [address] dependency
      assert.match(
        authContent,
        /const\s+getToken\s*=\s*useCallback\s*\(\s*\(\)\s*=>\s*getStoredSession\s*\(\s*address\s*\)\s*,\s*\[\s*address\s*\]\s*\)/,
        'getToken must be memoized with useCallback([address]) to prevent re-creation on every render',
      );
      // Must return the memoized getToken in the return object
      assert.match(
        authContent,
        /return\s*\{\s*[\s\S]*?\bgetToken\b[\s\S]*?\}/,
        'useAuthSession must return the memoized getToken',
      );
      // Must NOT return inline unmemoized function
      assert.doesNotMatch(
        authContent,
        /getToken\s*:\s*\(\)\s*=>\s*getStoredSession/,
        'useAuthSession must NOT return an inline unmemoized function for getToken',
      );
    });
  });

  describe('2. DealsPage Disconnected State Guard & Referential Bailout', () => {
    it('loadDeals uses functional state updater to preserve referential equality when already empty', () => {
      // In loadDeals when !targetAddress, setDeals must return prev if already empty
      assert.match(
        dealsContent,
        /setDeals\s*\(\s*\(prev\)\s*=>\s*\(\s*prev\.length\s*===\s*0\s*\?\s*prev\s*:\s*\[\]\s*\)\s*\)/,
        'loadDeals must preserve prev reference when length is 0 to allow React to bailout of state update',
      );
    });

    it('useEffect does NOT call loadDeals unconditionally when !effectiveAddress', () => {
      // Must NOT have the buggy: else if (!effectiveAddress) { loadDeals(); }
      assert.doesNotMatch(
        dealsContent,
        /else\s+if\s*\(\s*!effectiveAddress\s*\)\s*\{\s*loadDeals\(\)\s*;?\s*\}/,
        'useEffect must not call loadDeals unconditionally on !effectiveAddress without checking lastFetchedAddressRef',
      );

      // Must guard disconnected reset with lastFetchedAddressRef.current !== null
      assert.match(
        dealsContent,
        /else\s+if\s*\(\s*!effectiveAddress\s*&&\s*lastFetchedAddressRef\.current\s*!==\s*null\s*\)\s*\{\s*loadDeals\(\)\s*;?\s*\}/,
        'useEffect must guard loadDeals on disconnected state by checking lastFetchedAddressRef.current !== null',
      );
    });
  });

  describe('3. Lifecycle Simulation & Update Depth Analysis', () => {
    // Simulate React render loop tracking state updates and effect executions
    interface PageSimulationState {
      deals: string[];
      isLoading: boolean;
      lastFetchedAddress: string | null;
      renderCount: number;
      effectRuns: number;
      fetchCalls: number;
    }

    function simulateLifecycle(
      isFixedImplementation: boolean,
      walletTransitions: (string | undefined)[],
      maxRoundsPerTransition = 50,
    ) {
      let state: PageSimulationState = {
        deals: [],
        isLoading: false,
        lastFetchedAddress: null,
        renderCount: 0,
        effectRuns: 0,
        fetchCalls: 0,
      };

      for (const effectiveAddress of walletTransitions) {
        let round = 0;
        let stateChangedInRound = true;

        while (stateChangedInRound && round < maxRoundsPerTransition) {
          round++;
          state.renderCount++;
          stateChangedInRound = false;

          // Check if effect would trigger
          const shouldRunEffect = isFixedImplementation
            ? (effectiveAddress && effectiveAddress.toLowerCase() !== state.lastFetchedAddress) ||
              (!effectiveAddress && state.lastFetchedAddress !== null)
            : (effectiveAddress && effectiveAddress.toLowerCase() !== state.lastFetchedAddress) ||
              !effectiveAddress; // BUGGY: always runs when !effectiveAddress

          if (shouldRunEffect) {
            state.effectRuns++;

            // Inside loadDeals:
            if (!effectiveAddress) {
              const prevDeals = state.deals;
              const nextDeals = isFixedImplementation
                ? (prevDeals.length === 0 ? prevDeals : []) // Fixed: keeps reference if 0
                : []; // Buggy: creates new array literal every time

              const dealsChanged = prevDeals !== nextDeals;
              const addressChanged = state.lastFetchedAddress !== null;

              state.deals = nextDeals;
              state.lastFetchedAddress = null;

              if (dealsChanged || addressChanged) {
                stateChangedInRound = true;
              } else if (!isFixedImplementation) {
                // Buggy: in React, setState([]) with new [] always triggers re-render
                stateChangedInRound = true;
              }
            } else {
              state.fetchCalls++;
              state.deals = [`deal_for_${effectiveAddress.toLowerCase()}`];
              state.lastFetchedAddress = effectiveAddress.toLowerCase();
              stateChangedInRound = false; // State stabilized after fetch
            }
          }
        }

        if (round >= maxRoundsPerTransition) {
          throw new Error('Maximum update depth exceeded in simulation');
        }
      }

      return state;
    }

    it('BUGGY implementation triggers infinite update loop when disconnected', () => {
      // Running buggy implementation with disconnected wallet [undefined] should exceed depth
      assert.throws(
        () => {
          simulateLifecycle(false, [undefined], 30);
        },
        /Maximum update depth exceeded/,
        'Buggy logic must trigger infinite loop when disconnected',
      );
    });

    it('FIXED implementation stabilizes immediately when initial page load has no wallet', () => {
      // Disconnected wallet on initial load
      const state = simulateLifecycle(true, [undefined]);
      assert.strictEqual(state.renderCount, 1, 'Should only render once on mount');
      assert.strictEqual(state.effectRuns, 0, 'Effect should not run when disconnected with null ref');
      assert.strictEqual(state.fetchCalls, 0, 'No fetch calls when disconnected');
      assert.strictEqual(state.deals.length, 0, 'Deals should remain empty');
      assert.strictEqual(state.lastFetchedAddress, null, 'Last fetched address should remain null');
    });

    it('FIXED implementation handles full wallet lifecycle cleanly without loops', () => {
      const transitions = [
        undefined,                                    // 1. Initial load (disconnected)
        undefined,                                    // 2. Navigation while disconnected
        '0x1111111111111111111111111111111111111111', // 3. Connect Wallet A
        '0x1111111111111111111111111111111111111111', // 4. Re-render while on Wallet A
        '0x2222222222222222222222222222222222222222', // 5. Switch to Wallet B
        undefined,                                    // 6. Disconnect wallet
        undefined,                                    // 7. Stay disconnected
      ];

      const state = simulateLifecycle(true, transitions);

      // Exactly 2 fetches: one for Wallet A, one for Wallet B
      assert.strictEqual(state.fetchCalls, 2, 'Must fetch exactly once per unique wallet connected');
      // Final state: clean empty deals, null lastFetchedAddress
      assert.strictEqual(state.deals.length, 0, 'Deals must be cleared after disconnect');
      assert.strictEqual(state.lastFetchedAddress, null, 'Last fetched address must be null after disconnect');
    });
  });
});
