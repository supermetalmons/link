import { BrowserProvider } from "ethers";
import { connection } from "./connection";
import {
  getLegacyInjectedProvider,
  type EIP1193Provider,
  type EIP6963ProviderDetail,
} from "./injectedEthereumProviders";
import { prepareSiweMessage } from "./siweMessage";

const resolveInjectedProvider = (
  selectedWallet: EIP6963ProviderDetail | null,
): EIP1193Provider => {
  if (selectedWallet) {
    return selectedWallet.provider;
  }
  const legacyProvider = getLegacyInjectedProvider();
  if (legacyProvider) {
    return legacyProvider;
  }
  throw new Error("not found");
};

export async function connectToEthereumAndSign(
  selectedWallet: EIP6963ProviderDetail | null,
): Promise<{
  message: string;
  signature: string;
  intentId: string;
  address: string;
}> {
  const injectedProvider = resolveInjectedProvider(selectedWallet);

  const provider = new BrowserProvider(injectedProvider);
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  if (!Number.isSafeInteger(chainId) || chainId < 0) {
    throw new Error("Unsupported Ethereum chain id");
  }

  const intent = await connection.beginAuthIntent("eth");
  if (!intent || !intent.nonce || !intent.intentId) {
    throw new Error("Failed to begin Ethereum auth intent");
  }

  const message = prepareSiweMessage({
    domain: window.location.host,
    address,
    statement: "mons ftw",
    uri: window.location.origin,
    version: "1",
    chainId,
    nonce: intent.nonce,
    issuedAt: new Date().toISOString(),
  });

  const signature = await signer.signMessage(message);

  return {
    message,
    signature,
    intentId: intent.intentId,
    address,
  };
}
