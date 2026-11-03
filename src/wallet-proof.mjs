// Proof that someone holds an EVM wallet (MetaMask and friends on Robinhood Chain): they sign a
// short message with personal_sign, and the signer's address is recovered from the signature.
// No private key ever reaches Nocturn.
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

export const ROBINHOOD_CHAIN_ID = 4663;

export const validAddress = (address) => typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address);

export const linkMessage = (address, issued) => `Nocturn wallet link\nWallet: ${address}\nIssued: ${issued}`;

function signerOf(message, signatureHex) {
  const sig = Buffer.from(signatureHex.replace(/^0x/, ''), 'hex');
  if (sig.length !== 65) throw new Error('Bad signature');
  const text = Buffer.from(message, 'utf8');
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${text.length}`, 'utf8'), text]));
  const recovery = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  if (recovery !== 0 && recovery !== 1) throw new Error('Bad signature');
  const point = secp256k1.Signature.fromCompact(sig.subarray(0, 64)).addRecoveryBit(recovery).recoverPublicKey(digest);
  return `0x${Buffer.from(keccak_256(point.toRawBytes(false).subarray(1))).subarray(12).toString('hex')}`;
}

// Accepts { address, message, signature (0x hex) } and throws if it is not a real signature.
export function checkWalletProof({ address, message, signature }) {
  if (!validAddress(address)) throw new Error('Not a wallet address');
  const issued = typeof message === 'string' ? message.match(/^Nocturn wallet link\nWallet: (\S+)\nIssued: (\S+)$/) : null;
  if (!issued || issued[1].toLowerCase() !== address.toLowerCase() || Number.isNaN(Date.parse(issued[2]))) throw new Error('Unexpected message');
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('Bad signature');
  let signer;
  try { signer = signerOf(message, signature); } catch { throw new Error('Bad signature'); }
  if (signer !== address.toLowerCase()) throw new Error('The signature does not match this wallet');
  return { address: address.toLowerCase(), message, signature };
}
