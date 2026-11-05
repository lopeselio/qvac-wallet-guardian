// Small, conservative registry of well-known contracts. Being listed here only
// improves *labels* and lowers some severities from danger to warning. It
// never makes a request "safe". Extend it per app via `context.tokens` and
// `context.knownSpenders`.

/** @typedef {{ symbol: string, decimals: number, name?: string }} TokenInfo */

/** chainId → lowercase address → TokenInfo */
export const TOKENS = {
  1: {
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6, name: 'Tether USD' },
    '0x68749665ff8d2d112fa859aa293f07a622782f38': { symbol: 'XAUt', decimals: 6, name: 'Tether Gold' },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6, name: 'USD Coin' },
    '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18, name: 'Dai' },
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' }
  },
  42161: {
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT0', decimals: 6, name: 'USDT0' }
  },
  137: {
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT0', decimals: 6, name: 'USDT0 (PoS)' }
  }
}

/** Contracts that legitimately ask for approvals. Same address on most EVM chains. */
export const KNOWN_SPENDERS = {
  '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Uniswap Permit2',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router',
  '0x111111125421ca6dc452d289314280a0f8842a65': '1inch Aggregation Router v6',
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x Exchange Proxy'
}

export const NATIVE = { 1: 'ETH', 10: 'ETH', 8453: 'ETH', 42161: 'ETH', 137: 'POL', 56: 'BNB', 43114: 'AVAX' }

export const CHAIN_NAMES = { 1: 'Ethereum', 10: 'Optimism', 56: 'BNB Chain', 137: 'Polygon', 8453: 'Base', 42161: 'Arbitrum One', 43114: 'Avalanche', 11155111: 'Sepolia' }
