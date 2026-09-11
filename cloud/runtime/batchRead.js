const batchReadWithRetry = async (readers) => {
  const initial = await Promise.allSettled(readers.map((read) => read()));
  return Promise.all(
    initial.map((result, index) => {
      if (result.status === "rejected") {
        console.error("Error in initial batch read:", result.reason);
        return readers[index]();
      }
      return result.value;
    }),
  );
};

module.exports = {
  batchReadWithRetry,
};
