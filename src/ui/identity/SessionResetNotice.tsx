import { useEffect, useState } from "react";
import styled from "styled-components";
import {
  consumeSessionResetNotice,
  hasPendingSessionResetNotice,
} from "../../session/sessionAuth";

const Notice = styled.div`
  width: 100%;
  box-sizing: border-box;
  border-radius: 8px;
  background: var(--color-gray-f5);
  color: var(--color-gray-27);
  font-size: 0.74rem;
  line-height: 1.35;
  padding: 8px 9px;
  text-align: left;

  @media (prefers-color-scheme: dark) {
    background: var(--color-gray-27);
    color: var(--color-gray-f5);
  }
`;

export function SessionResetNotice() {
  const [visible] = useState(hasPendingSessionResetNotice);

  useEffect(() => {
    if (visible) consumeSessionResetNotice();
  }, [visible]);

  return visible ? (
    <Notice role="status">
      Your session was reset. Sign in again to restore your profile.
    </Notice>
  ) : null;
}
