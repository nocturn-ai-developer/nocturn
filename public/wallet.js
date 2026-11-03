// Connect an EVM wallet (MetaMask or any wallet that injects window.ethereum) on Robinhood Chain.
// On your own machine the wallet also signs one short message, so the miner can link it to your
// pool account. On the public site it only connects; nothing is sent anywhere.
export const CHAIN = {
  chainId: '0x1237', // 4663
  chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
  blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
};

const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

// Asks the wallet to move to Robinhood Chain, adding it first if the wallet does not know it.
export async function useRobinhoodChain() {
  const wallet = window.ethereum;
  if (!wallet) throw new Error('No wallet found in this browser.');
  try {
    await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.chainId }] });
  } catch (err) {
    if (err?.code !== 4902) throw err;
    await wallet.request({ method: 'wallet_addEthereumChain', params: [CHAIN] });
  }
}

// `api` is null on the public site.
export function walletButton(api) {
  const button = el('button', 'btn primary wallet-btn', 'Connect wallet');
  const menu = el('div', 'wallet-menu hidden');
  const box = el('div', 'wallet', button, menu);
  let address = null;

  const show = (...children) => { menu.replaceChildren(...children); menu.classList.remove('hidden'); };
  const hide = () => menu.classList.add('hidden');
  // The button reshapes itself between "Connect wallet" and the short address.
  const paint = () => {
    const change = () => {
      button.textContent = address ? short(address) : 'Connect wallet';
      button.classList.toggle('primary', !address);
    };
    if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden) { change(); return; }
    document.startViewTransition(change).finished.catch(() => {});
  };

  async function connect() {
    const wallet = window.ethereum;
    if (!wallet) {
      const link = el('a', '', 'Get MetaMask');
      link.href = 'https://metamask.io/download';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      show(el('p', '', 'No wallet found in this browser. Install one, then reload this page.'), link);
      return;
    }
    button.disabled = true;
    button.textContent = 'Check your wallet…';
    try {
      const [account] = await wallet.request({ method: 'eth_requestAccounts' });
      await useRobinhoodChain().catch(() => {}); // still connected if they stay on another network
      if (api) {
        const message = `Nocturn wallet link\nWallet: ${account}\nIssued: ${new Date().toISOString()}`;
        const signature = await wallet.request({ method: 'personal_sign', params: [message, account] });
        await api('wallet', 'POST', { address: account, message, signature });
      }
      address = account;
      hide();
    } catch (err) {
      show(el('p', '', err?.code === 4001 ? 'You canceled in your wallet.' : `Could not connect: ${err?.message ?? 'unknown error'}`));
    } finally {
      button.disabled = false;
      paint();
    }
  }

  async function disconnect() {
    if (api) await api('wallet', 'DELETE').catch(() => {});
    address = null;
    hide();
    paint();
  }

  button.addEventListener('click', () => {
    if (!address) { connect(); return; }
    if (!menu.classList.contains('hidden')) { hide(); return; }
    const off = el('button', 'btn small danger', 'Disconnect');
    off.addEventListener('click', disconnect);
    show(el('p', '', api
      ? 'Linked to your miner account the next time you run nocturn mine.'
      : 'Connected on this page only. To link it to your miner, connect it from your own Nocturn dashboard.'), off);
  });
  document.addEventListener('click', (e) => { if (!box.contains(e.target)) hide(); });

  if (api) api('wallet').then((saved) => { address = saved.address ?? null; paint(); }).catch(() => {});
  return box;
}
