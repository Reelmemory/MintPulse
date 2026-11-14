/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Configurable EVM Chain Registry
 * Restricts active default EVM chains strictly to Ethereum, Robinhood Chain, and Ink Chain.
 * Easily extensible or editable via registerChain().
 */

import { EvmChainConfig } from './types.ts';

const DEFAULT_EVM_CHAINS: EvmChainConfig[] = [
  {
    chainId: 1,
    slug: 'ethereum',
    name: 'Ethereum',
    nativeSymbol: 'ETH',
    explorerUrl: 'https://etherscan.io',
    openSeaChainIdentifier: 'ethereum',
    isEnabled: true,
  },
  {
    chainId: 747474,
    slug: 'robinhood',
    name: 'Robinhood Chain',
    nativeSymbol: 'ETH',
    explorerUrl: 'https://explorer.robinhood.com',
    openSeaChainIdentifier: 'robinhood',
    isEnabled: true,
  },
  {
    chainId: 57073,
    slug: 'ink',
    name: 'Ink Chain',
    nativeSymbol: 'ETH',
    explorerUrl: 'https://explorer.inkonchain.com',
    openSeaChainIdentifier: 'ink',
    isEnabled: true,
  },
];

export class EvmChainRegistry {
  private chainsById = new Map<number, EvmChainConfig>();
  private chainsBySlug = new Map<string, EvmChainConfig>();

  constructor(initialChains: EvmChainConfig[] = DEFAULT_EVM_CHAINS) {
    for (const chain of initialChains) {
      this.registerChain(chain);
    }
  }

  public registerChain(config: EvmChainConfig): void {
    const normalizedSlug = config.slug.trim().toLowerCase();
    const record: EvmChainConfig = {
      ...config,
      slug: normalizedSlug,
      explorerUrl: config.explorerUrl.replace(/\/+$/, ''),
    };
    this.chainsById.set(record.chainId, record);
    this.chainsBySlug.set(normalizedSlug, record);
    if (normalizedSlug === 'ethereum') {
      this.chainsBySlug.set('eth', record);
    }
    if (normalizedSlug === 'robinhood') {
      this.chainsBySlug.set('rh', record);
      this.chainsBySlug.set('robinhood-chain', record);
      this.chainsBySlug.set('robinhood chain', record);
    }
    if (normalizedSlug === 'ink') {
      this.chainsBySlug.set('ink-chain', record);
      this.chainsBySlug.set('ink chain', record);
      this.chainsBySlug.set('inkonchain', record);
    }
    if (record.openSeaChainIdentifier) {
      this.chainsBySlug.set(record.openSeaChainIdentifier.toLowerCase(), record);
    }
  }

  public getChainById(chainId: number): EvmChainConfig | undefined {
    const chain = this.chainsById.get(chainId);
    return chain && chain.isEnabled ? chain : undefined;
  }

  public getChainBySlugOrId(input: string | number): EvmChainConfig | undefined {
    if (typeof input === 'number') {
      return this.getChainById(input);
    }
    const trimmed = input.trim().toLowerCase();
    const asNum = Number(trimmed);
    if (!Number.isNaN(asNum) && Number.isInteger(asNum)) {
      return this.getChainById(asNum);
    }
    const chain = this.chainsBySlug.get(trimmed);
    return chain && chain.isEnabled ? chain : undefined;
  }

  public getEnabledChains(): EvmChainConfig[] {
    return Array.from(this.chainsById.values()).filter((c) => c.isEnabled);
  }

  public isValidEvmAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address.trim());
  }

  public getContractExplorerUrl(chainId: number, contractAddress: string): string | null {
    const chain = this.getChainById(chainId);
    if (!chain || !this.isValidEvmAddress(contractAddress)) {
      return null;
    }
    return `${chain.explorerUrl}/address/${contractAddress.trim()}`;
  }
}

export const chainRegistry = new EvmChainRegistry();
