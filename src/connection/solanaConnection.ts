import { connection } from "./connection";

type InjectedSolanaProvider = {
  connected?: boolean;
  connect(): Promise<unknown>;
  publicKey?: { toString(): string } | null;
  signMessage(message: Uint8Array): Promise<unknown>;
};

declare global {
  interface Window {
    solana?: InjectedSolanaProvider;
  }
}

let walletAdapter: InjectedSolanaProvider | null = null;

const coerceLegacySolanaSignature = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) {
    return value;
  }
  return new Uint8Array(
    (value as { signature?: unknown }).signature as
      ArrayBuffer | ArrayLike<number>,
  );
};

export async function connectToSolana(): Promise<{
  publicKey: string;
  signature: string;
  intentId: string;
}> {
  try {
    if (!window.solana) {
      throw new Error("not found");
    }

    if (!walletAdapter) {
      walletAdapter = window.solana;
    }

    if (!walletAdapter.connected) {
      await walletAdapter.connect();
    }

    const publicKey = walletAdapter.publicKey;
    if (!publicKey) {
      throw new Error("not connected");
    }

    const intent = await connection.beginAuthIntent("sol");
    if (!intent || !intent.nonce || !intent.intentId) {
      throw new Error("Failed to begin Solana auth intent");
    }

    const message = `Sign in mons.link with Solana nonce ${intent.nonce}`;
    const encodedMessage = new TextEncoder().encode(message);
    const signatureResponse = await walletAdapter.signMessage(encodedMessage);

    const signature = coerceLegacySolanaSignature(signatureResponse);

    return {
      publicKey: publicKey.toString(),
      signature: btoa(String.fromCharCode(...signature)),
      intentId: intent.intentId,
    };
  } catch (error) {
    console.error("Solana connection error:", error);
    throw error;
  }
}
