export const environment = {
  ensRequests: [] as {
    address: string;
    resolve: (name: string | null) => void;
  }[],
};

export const resolveENS = (address: string) =>
  new Promise<string | null>((resolve) => {
    environment.ensRequests.push({ address, resolve });
  });
