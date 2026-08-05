let currentSessionId = 0;
let currentEpoch = 0;

export const beginMatchSession = () => {
  currentSessionId += 1;
  currentEpoch += 1;
  return {
    sessionId: currentSessionId,
    epoch: currentEpoch,
  };
};

export const incrementSessionEpoch = () => {
  currentEpoch += 1;
  return currentEpoch;
};

export const getCurrentSessionId = () => {
  return currentSessionId;
};

export const getCurrentSessionEpoch = () => {
  return currentEpoch;
};

export const getSessionGuard = () => {
  const expectedSessionId = currentSessionId;
  const expectedEpoch = currentEpoch;
  return () => {
    const isActive =
      expectedSessionId === currentSessionId && expectedEpoch === currentEpoch;
    if (!isActive && import.meta.env.DEV) {
      console.log("stale-session-callback", {
        expectedSessionId,
        expectedEpoch,
        currentSessionId,
        currentEpoch,
      });
    }
    return isActive;
  };
};
