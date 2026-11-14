# Extending MintPulse: Adding EVM Chains & Discovery Adapters

MintPulse is engineered around two extensible registries:
1. **The EVM Chain Registry (`src/core/chains.ts`)**
2. **The Discovery Source Adapter Interface (`src/core/discovery/adapterInterface.ts`)**

> **Important Scope Policy:** MintPulse strictly tracks **NFT Mints** (`free`, `allowlist`, `public`). Do not submit adapters or commands for raffles, sweepstakes, or giveaways.

---

## 1. Adding a New EVM Chain

MintPulse includes Ethereum (`1`), Base (`8453`), Polygon (`137`), Arbitrum One (`42161`), and Optimism (`10`) out of the box.

### Step 1: Register the Chain in `src/core/chains.ts` (or via runtime registration)

Every EVM chain conforms to the `EvmChainConfig` interface:

```typescript
export interface EvmChainConfig {
  chainId: number;
  slug: string;
  name: string;
  nativeSymbol: string;
  explorerUrl: string;
  openSeaChainIdentifier?: string;
  isEnabled: boolean;
}
```

To add a new EVM chain (for example, **Zora** `7777777` or **Avalanche C-Chain** `43114`):

```typescript
import { chainRegistry } from './src/core/chains.ts';

chainRegistry.registerChain({
  chainId: 7777777,
  slug: 'zora',
  name: 'Zora Network',
  nativeSymbol: 'ETH',
  explorerUrl: 'https://explorer.zora.energy',
  openSeaChainIdentifier: 'zora',
  isEnabled: true,
});
```

### Step 2: Persist in PostgreSQL

Add an `INSERT` migration in `migrations/`:

```sql
INSERT INTO evm_chains (chain_id, slug, name, native_symbol, explorer_url, opensea_chain_identifier, is_enabled)
VALUES (7777777, 'zora', 'Zora Network', 'ETH', 'https://explorer.zora.energy', 'zora', TRUE)
ON CONFLICT (chain_id) DO NOTHING;
```

Once registered, all slash commands (`/mint add`, `/mints today`, `/mints week`), contract address validators, and block explorer links automatically support the new chain.

---

## 2. Creating a New Discovery Source Adapter

All discovery adapters implement `MintDiscoveryAdapter` defined in `src/core/discovery/adapterInterface.ts`:

```typescript
export interface MintDiscoveryAdapter {
  readonly id: string;
  readonly name: string;
  readonly requiresCredentials: boolean;
  isConfigured(): boolean;
  discoverUpcomingMints(): Promise<AdapterDiscoveryResult>;
}
```

### Step-by-Step Implementation

1. **Create a new adapter file** under `src/core/discovery/`, e.g., `src/core/discovery/highlightAdapter.ts`.
2. **Fetch external URLs exclusively through `ssrfGuard`** (`validateExternalUrl` / `safeFetchUrl`) to ensure SSRF protection and DNS rebinding checks are enforced.
3. **Never fabricate missing fields:**
   - If the mint price is unknown, set `mintPriceExact: null`.
   - If the smart contract address is not yet deployed or published, set `contractAddress: null`.
   - Only set `verificationStatus: 'verified'` if the upstream source cryptographically or contractually verifies the drop date and contract. Otherwise set `verificationStatus: 'unverified'`.
4. **Normalize into `RawDiscoveredMint`** and pass through `verifyAndNormalizeMint()`.
5. **Register the adapter** with the `DiscoveryEngine` in `src/core/discovery/index.ts`:

```typescript
discoveryEngine.registerAdapter(new CustomCalendarAdapter());
```

### Testing Your Adapter

Add unit tests in `src/core/tests/testSuite.ts` verifying:
- Normalization of valid upstream responses
- Handling of missing prices or contract addresses (`null` preservation)
- Rejection of past or invalid timestamps
- SSRF rejection if custom URLs are involved
