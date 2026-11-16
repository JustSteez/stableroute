'use strict';
// Drafts the unsigned deposit transactions for protocols we can call directly.
// StableRoute never holds keys: the user reviews and signs in their own wallet.
const { Interface, getAddress } = require('ethers');

const CHAIN_IDS = { ethereum: 1, base: 8453, arbitrum: 42161, optimism: 10, polygon: 137 };

// Aave v3 Pool contracts
const AAVE_POOL = {
  ethereum: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  base: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  optimism: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  polygon: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
};
// Compound v3 USDC markets (Comet)
const COMET_USDC = {
  ethereum: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
  base: '0xb125E6687d4313864e53df431d5425969c15Eb2F',
  arbitrum: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
};
const DECIMALS = { USDC: 6, 'USDC.E': 6, USDT: 6, USDBC: 6, DAI: 18, USDS: 18, GHO: 18, PYUSD: 6, USDE: 18 };

const erc20 = new Interface(['function approve(address spender, uint256 amount)']);
const aave = new Interface(['function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)']);
const comet = new Interface(['function supply(address asset, uint256 amount)']);

function toUnits(amount, decimals) {
  return BigInt(Math.round(amount * 100)) * 10n ** BigInt(decimals) / 100n;
}

function draftDeposit(c, amount, wallet) {
  const chain = String(c.chain).toLowerCase();
  const decimals = DECIMALS[c.symbol];
  const link = `https://defillama.com/yields/pool/${c.pool}`;
  if (!c.underlying || decimals === undefined || !CHAIN_IDS[chain]) return { supported: false, link };
  let asset;
  try { asset = getAddress(c.underlying); } catch { return { supported: false, link }; }
  const units = toUnits(amount, decimals);
  let target, data, method;
  if (c.project === 'aave-v3' && AAVE_POOL[chain]) {
    if (!wallet) return { supported: true, needsWallet: true, link };
    target = AAVE_POOL[chain];
    data = aave.encodeFunctionData('supply', [asset, units, getAddress(wallet), 0]);
    method = 'Aave v3 Pool.supply';
  } else if (c.project === 'compound-v3' && COMET_USDC[chain] && c.symbol.startsWith('USDC')) {
    target = COMET_USDC[chain];
    data = comet.encodeFunctionData('supply', [asset, units]);
    method = 'Compound v3 Comet.supply';
  } else {
    return { supported: false, link };
  }
  return {
    supported: true,
    chainId: CHAIN_IDS[chain],
    link,
    steps: [
      { label: `Approve ${amount} ${c.symbol}`, to: asset, data: erc20.encodeFunctionData('approve', [target, units]), value: '0x0' },
      { label: method, to: target, data, value: '0x0' },
    ],
  };
}

module.exports = { draftDeposit, CHAIN_IDS };
