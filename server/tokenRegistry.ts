import type { Network } from "@x402/core/types";

export type ChainFamily = "evm" | "solana" | "stellar";

export interface TokenConfig {
  chainId: string;
  chainName: string;
  network: Network;
  chainFamily: ChainFamily;
  tokenSymbol: string;
  tokenName: string;
  asset: string;
  decimals: number;
  isTestnet: boolean;
}

export const SUPPORTED_TOKENS: TokenConfig[] = [
  // Base Sepolia
  { chainId: "eip155:84532", chainName: "Base Sepolia", network: "eip155:84532" as Network, chainFamily: "evm", tokenSymbol: "USDC", tokenName: "USD Coin", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, isTestnet: true },
  // Base
  { chainId: "eip155:8453", chainName: "Base", network: "eip155:8453" as Network, chainFamily: "evm", tokenSymbol: "USDC", tokenName: "USD Coin", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, isTestnet: false },
  { chainId: "eip155:8453", chainName: "Base", network: "eip155:8453" as Network, chainFamily: "evm", tokenSymbol: "USDT", tokenName: "Tether USD", asset: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6, isTestnet: false },
  // Ethereum
  { chainId: "eip155:1", chainName: "Ethereum", network: "eip155:1" as Network, chainFamily: "evm", tokenSymbol: "USDC", tokenName: "USD Coin", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, isTestnet: false },
  { chainId: "eip155:1", chainName: "Ethereum", network: "eip155:1" as Network, chainFamily: "evm", tokenSymbol: "USDT", tokenName: "Tether USD", asset: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, isTestnet: false },
  // Polygon
  { chainId: "eip155:137", chainName: "Polygon", network: "eip155:137" as Network, chainFamily: "evm", tokenSymbol: "USDC", tokenName: "USD Coin", asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, isTestnet: false },
  // Arbitrum
  { chainId: "eip155:42161", chainName: "Arbitrum One", network: "eip155:42161" as Network, chainFamily: "evm", tokenSymbol: "USDC", tokenName: "USD Coin", asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, isTestnet: false },
  // Optimism
  { chainId: "eip155:10", chainName: "Optimism", network: "eip155:10" as Network, chainFamily: "evm", tokenSymbol: "USDC", tokenName: "USD Coin", asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6, isTestnet: false },
  { chainId: "eip155:10", chainName: "Optimism", network: "eip155:10" as Network, chainFamily: "evm", tokenSymbol: "USDT", tokenName: "Tether USD", asset: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6, isTestnet: false },
  // BSC
  { chainId: "eip155:56", chainName: "BNB Smart Chain", network: "eip155:56" as Network, chainFamily: "evm", tokenSymbol: "USDC", tokenName: "USD Coin", asset: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, isTestnet: false },
  { chainId: "eip155:56", chainName: "BNB Smart Chain", network: "eip155:56" as Network, chainFamily: "evm", tokenSymbol: "USDT", tokenName: "Tether USD", asset: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, isTestnet: false },
  // Solana Mainnet
  { chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", chainName: "Solana", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as Network, chainFamily: "solana", tokenSymbol: "USDC", tokenName: "USD Coin", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, isTestnet: false },
  // Solana Devnet
  { chainId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", chainName: "Solana Devnet", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as Network, chainFamily: "solana", tokenSymbol: "USDC", tokenName: "USD Coin", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, isTestnet: true },
  // Stellar Pubnet
  { chainId: "stellar:pubnet", chainName: "Stellar", network: "stellar:pubnet" as Network, chainFamily: "stellar", tokenSymbol: "USDC", tokenName: "USD Coin", asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", decimals: 7, isTestnet: false },
  // Stellar Testnet
  { chainId: "stellar:testnet", chainName: "Stellar Testnet", network: "stellar:testnet" as Network, chainFamily: "stellar", tokenSymbol: "USDC", tokenName: "USD Coin", asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", decimals: 7, isTestnet: true },
];

export function getTokenConfig(chainId: string, tokenSymbol: string): TokenConfig | undefined {
  return SUPPORTED_TOKENS.find(t => t.chainId === chainId && t.tokenSymbol === tokenSymbol);
}
