import { css } from "styled-components";

export type SignInButtonVisualProps = {
  $isConnected?: boolean;
  $isPending?: boolean;
};

export const signInButtonVisualStyles = css<SignInButtonVisualProps>`
  background-color: ${(props) =>
    props.$isConnected || props.$isPending
      ? "var(--color-gray-f9de)"
      : "var(--profileSigninTint)"};

  padding: 8px 16px;
  font-weight: ${(props) =>
    props.$isConnected || props.$isPending ? "750" : "888"};
  font-size: ${(props) =>
    props.$isConnected || props.$isPending ? "0.9rem" : "0.95rem"};
  color: ${(props) =>
    props.$isConnected || props.$isPending
      ? "var(--profileConnectedText)"
      : "white"};
  border-radius: 16px;
  border: none;
  cursor: pointer;

  &:disabled {
    cursor: default;
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: ${(props) =>
        props.$isConnected || props.$isPending
          ? "var(--color-gray-f5)"
          : "var(--bottomButtonBackgroundHover)"};
    }
  }

  @media (prefers-color-scheme: dark) {
    background-color: ${(props) =>
      props.$isConnected || props.$isPending
        ? "var(--color-gray-25d5)"
        : "var(--profileSigninTintDark)"};

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: ${(props) =>
          props.$isConnected || props.$isPending
            ? "var(--color-gray-27)"
            : "var(--bottomButtonBackgroundHoverDark)"};
      }
    }
  }
`;
